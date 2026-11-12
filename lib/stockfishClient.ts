// src/lib/stockfishClient.ts
import { EngineEval } from './reviewEngine';

const FEN_REGEX = /^[rnbqkpRNBQKP1-8/]+\s[wb]\s[KQkq-]+\s[a-h1-8-]+\s\d+\s\d+$/;

export class StockfishAnalyzer {
  private worker: Worker | null = null;
  private isReady = false;

  async init(): Promise<void> {
    if (this.worker) return;
    this.worker = new Worker('/engine/stockfish.js');

    await new Promise<void>((resolve, reject) => {
      if (!this.worker) return reject(new Error('Worker initialization failed'));

      const timeout = setTimeout(() => reject(new Error('Stockfish init timeout')), 10_000);

      this.worker.onmessage = (e: MessageEvent<string>) => {
        const line = String(e.data);
        if (line.includes('uciok')) {
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

  async evaluateFen(fen: string, depth = 14): Promise<EngineEval> {
    if (!this.worker || !this.isReady) {
      await this.init();
    }

    // Strict FEN validation prevents UCI command injection
    if (!FEN_REGEX.test(fen)) {
      throw new Error('Invalid FEN string rejected.');
    }

    const safeDepth = Math.max(6, Math.min(20, Math.floor(depth)));
    const sideToMove = fen.split(' ')[1]; // 'w' or 'b'
    const perspectiveSign = sideToMove === 'w' ? 1 : -1;

    return new Promise<EngineEval>((resolve, reject) => {
      if (!this.worker) return reject(new Error('Worker unavailable'));

      let latestCp = 0;
      let latestMate: number | null = null;
      let latestPvMove = '';

      const timeout = setTimeout(() => {
        this.worker?.postMessage('stop');
        resolve({ cp: latestCp, mate: latestMate, bestMoveUci: latestPvMove });
      }, 5000);

      this.worker.onmessage = (e: MessageEvent<string>) => {
        const line = String(e.data);

        if (line.startsWith('info ') && line.includes(' score ')) {
          const cpMatch = line.match(/\bscore cp (-?\d+)/);
          const mateMatch = line.match(/\bscore mate (-?\d+)/);
          const pvMatch = line.match(/\bpv ([a-h][1-8][a-h][1-8][qrbn]?)/);

          if (cpMatch) {
            latestCp = parseInt(cpMatch[1], 10) * perspectiveSign;
            latestMate = null;
          } else if (mateMatch) {
            latestMate = parseInt(mateMatch[1], 10) * perspectiveSign;
            latestCp = latestMate > 0 ? 10000 : -10000;
          }

          if (pvMatch) {
            latestPvMove = pvMatch[1];
          }
        } else if (line.startsWith('bestmove ')) {
          clearTimeout(timeout);
          const bestMatch = line.match(/^bestmove ([a-h][1-8][a-h][1-8][qrbn]?)/);
          const bestMoveUci = bestMatch ? bestMatch[1] : latestPvMove;
          resolve({
            cp: latestCp,
            mate: latestMate,
            bestMoveUci,
          });
        }
      };

      this.worker.postMessage(`position fen ${fen}`);
      this.worker.postMessage(`go depth ${safeDepth}`);
    });
  }

  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    this.isReady = false;
  }
}