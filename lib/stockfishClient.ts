// src/lib/stockfishClient.ts
import { Chess } from 'chess.js';
import { EngineEval } from './reviewEngine';

// Strict FEN validation prevents UCI command injection
const FEN_REGEX = /^[rnbqkpRNBQKP1-8/]+\s[wb]\s[KQkq-]+\s[a-h1-8-]+\s\d+\s\d+$/;

// The engine stops by itself at whichever limit comes first: depth or time.
// Letting the ENGINE stop (instead of us sending "stop") means its "bestmove"
// reply always matches the search we asked for. No stale replies.
const DEFAULT_MOVE_TIME_MS = 3000;
// If the engine says nothing for this long after that, it is stuck.
const HANG_GRACE_MS = 5000;

export const ANALYSIS_CANCELLED = 'Analysis cancelled'; 

interface PendingSearch {
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class StockfishAnalyzer {
  private worker: Worker | null = null;
  private isReady = false;
  private pending: PendingSearch | null = null;
  // Searches wait in line, so two can never run at once
  private queue: Promise<unknown> = Promise.resolve();

  async init(): Promise<void> {
    if (this.worker) return;
    this.worker = new Worker('/engine/stockfish.js');

    await new Promise<void>((resolve, reject) => {
      if (!this.worker) return reject(new Error('Worker initialization failed'));

      const timeout = setTimeout(() => reject(new Error('Stockfish init timeout')), 10_000);

      this.worker.onmessage = (e: MessageEvent<string>) => {
        const line = String(e.data);
        if (line.includes('uciok')) {
          // Ask for the TOP TWO moves. The gap between them finds "Great" moves.
          this.worker?.postMessage('setoption name MultiPV value 2');
          this.worker?.postMessage('isready');
        } else if (line.includes('readyok')) {
          clearTimeout(timeout);
          this.isReady = true;
          resolve();
        }
      };

      this.worker.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('Failed to load local Stockfish WASM worker.'));
      };

      this.worker.postMessage('uci');
    });
  }

  /** Tells the engine a new game starts, so old cached results are not reused. */
  async newGame(): Promise<void> {
    await this.init();
    await new Promise<void>((resolve, reject) => {
      const worker = this.worker;
      if (!worker) return reject(new Error('Worker unavailable'));
      const timer = setTimeout(() => reject(new Error('Stockfish did not respond.')), 5000);
      worker.onmessage = (e: MessageEvent<string>) => {
        if (String(e.data).includes('readyok')) {
          clearTimeout(timer);
          resolve();
        }
      };
      worker.postMessage('ucinewgame');
      worker.postMessage('isready');
    });
  }

  /**
   * Finished games cannot be searched: the engine prints "score mate 0" or
   * nothing useful. We answer those ourselves with chess.js.
   * (Before this fix, a checkmating move was scored as a blunder.)
   */
  private terminalEval(fen: string): EngineEval | null {
    const game = new Chess(fen);
    if (game.isCheckmate()) {
      // The side to move is mated, so the OTHER side won.
      const whiteWon = game.turn() === 'b';
      return {
        cp: whiteWon ? 10000 : -10000,
        mate: whiteWon ? 1 : -1, // sign = winner, in White's perspective
        bestMoveUci: '',
        terminal: 'checkmate',
      };
    }
    if (game.isDraw()) {
      return { cp: 0, mate: null, bestMoveUci: '', terminal: 'draw' };
    }
    return null;
  }

  /** Public entry point: queue the search so only one runs at a time. */
  evaluateFen(
    fen: string,
    depth = 16,
    moveTimeMs = DEFAULT_MOVE_TIME_MS
  ): Promise<EngineEval> {
    const run = this.queue.then(() => this.search(fen, depth, moveTimeMs));
    this.queue = run.catch(() => undefined); // a failure must not block the queue
    return run;
  }

  private async search(fen: string, depth: number, moveTimeMs: number): Promise<EngineEval> {
    // Validate BEFORE anything is sent to the engine
    if (!FEN_REGEX.test(fen)) {
      throw new Error('Invalid FEN string rejected.');
    }

    const finished = this.terminalEval(fen);
    if (finished) return finished;

    if (!this.worker || !this.isReady) {
      await this.init();
    }

    const safeDepth = Math.max(6, Math.min(24, Math.floor(depth)));
    const safeTime = Math.max(500, Math.min(15_000, Math.floor(moveTimeMs)));
    // UCI scores are from the side-to-move's view. Multiply to get White's view.
    const perspectiveSign = fen.split(' ')[1] === 'w' ? 1 : -1;

    return new Promise<EngineEval>((resolve, reject) => {
      const worker = this.worker;
      if (!worker) return reject(new Error('Worker unavailable'));

      // Latest exact score for line 1 (best) and line 2 (second best).
      // All numbers are converted to WHITE's point of view right away.
      type Line = { cp: number; mate: number | null; depth: number; move: string };
      const lines: Record<number, Line> = {};

      // Safety net only. Normally the engine ends the search on its own.
      const timer = setTimeout(() => {
        this.pending = null; // so terminate() does not report "cancelled" instead
        this.terminate(); // kills the stuck worker; next call starts a fresh one
        reject(new Error('Stockfish stopped responding. Please try again.'));
      }, safeTime + HANG_GRACE_MS);

      this.pending = { reject, timer };

      worker.onmessage = (e: MessageEvent<string>) => {
        const line = String(e.data);

        if (line.startsWith('info ') && line.includes(' score ')) {
          // Bound scores are guesses made while the search is still narrowing.
          if (line.includes(' lowerbound') || line.includes(' upperbound')) return;

          const cpMatch = line.match(/\bscore cp (-?\d+)/);
          const mateMatch = line.match(/\bscore mate (-?\d+)/);
          const pvMatch = line.match(/\bpv ([a-h][1-8][a-h][1-8][qrbn]?)/);
          const depthMatch = line.match(/\bdepth (\d+)/);
          const multiMatch = line.match(/\bmultipv (\d+)/);
          const index = multiMatch ? parseInt(multiMatch[1], 10) : 1;
          if (index !== 1 && index !== 2) return;

          let cp = 0;
          let mate: number | null = null;
          if (cpMatch) {
            cp = parseInt(cpMatch[1], 10) * perspectiveSign;
          } else if (mateMatch) {
            mate = parseInt(mateMatch[1], 10) * perspectiveSign;
            cp = mate > 0 ? 10000 : -10000;
          } else {
            return;
          }
          lines[index] = {
            cp,
            mate,
            depth: depthMatch ? parseInt(depthMatch[1], 10) : 0,
            move: pvMatch ? pvMatch[1] : '',
          };
        } else if (line.startsWith('bestmove ')) {
          clearTimeout(timer);
          this.pending = null;
          const best = lines[1];
          const second = lines[2];
          const bestMatch = line.match(/^bestmove ([a-h][1-8][a-h][1-8][qrbn]?)/);

          const result: EngineEval = {
            cp: best?.cp ?? 0,
            mate: best?.mate ?? null,
            bestMoveUci: bestMatch ? bestMatch[1] : best?.move ?? '',
          };
          // Only trust line 2 if it was searched about as deep as line 1.
          // (If time ran out mid-search, line 2 can be stale.)
          if (best && second && second.depth >= best.depth - 1) {
            result.alt = { cp: second.cp, mate: second.mate };
          }
          resolve(result);
        }
      };

      worker.postMessage(`position fen ${fen}`);
      worker.postMessage(`go depth ${safeDepth} movetime ${safeTime}`);
    });
  }

  /** Stops the engine. Any search that is waiting is rejected (not left hanging). */
  terminate(): void {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error(ANALYSIS_CANCELLED));
      this.pending = null;
    }
    this.worker?.terminate();
    this.worker = null;
    this.isReady = false;
  }
}