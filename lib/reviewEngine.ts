// src/lib/reviewEngine.ts
import { Chess, PieceSymbol, Color } from 'chess.js';

/**
 * Move labels, from best to worst.
 * "Great"  = the only move that kept the position (the 2nd best move was much worse).
 * "Book"   = a known opening move.
 * "Forced" = only one legal move existed, so there was no real choice.
 * "Miss"   = the player had a forced checkmate and let it slip.
 */
export type MoveClassification =
  | 'Brilliant'
  | 'Great'
  | 'Best'
  | 'Excellent'
  | 'Good'
  | 'Book'
  | 'Forced'
  | 'Inaccuracy'
  | 'Miss'
  | 'Mistake'
  | 'Blunder';

export interface EngineEval {
  cp: number;          // Centipawns from White's perspective
  mate: number | null; // Moves to mate from White's perspective (+White, -Black)
  bestMoveUci: string; // e.g., "e2e4" (empty string if the game is already over)
  // The engine's SECOND best line (White's perspective). Used to find "Great" moves.
  alt?: { cp: number; mate: number | null };
  // How deep the engine got. On slow computers the time limit can stop it early.
  depth?: number;
  // Set when the position is a finished game (the engine can't search those).
  terminal?: 'checkmate' | 'draw';
}

export interface ReviewedMove {
  ply: number;
  san: string;
  uci: string;
  fenBefore: string;
  fenAfter: string;
  turn: Color;
  classification: MoveClassification;
  winPctBefore: number; // From the MOVER's point of view
  winPctAfter: number;  // From the MOVER's point of view
  winLoss: number;
  evalDisplay: string;
  bestMoveUci: string;
  bestMoveSan: string;  // e.g. "Nf3", handy to show "Best was Nf3"
  accuracy: number;
  opening: string;      // Opening name while still in book, otherwise ''
}

const PIECE_VALUES: Record<PieceSymbol, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 0,
};

const UCI_REGEX = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

// Tuning knobs (kept in one place so they are easy to change)
const WIN_PERCENT_K = 0.00368208; // Lichess curve: centipawns -> win chance
const ACCURACY_K = 0.065;         // Higher = harsher accuracy for each lost win%
const SACRIFICE_MIN_POINTS = 2;   // Net material given up to count as a "sacrifice"
const GREAT_MIN_GAP = 15;         // 2nd best move must be this many win% worse
const MIN_RELIABLE_DEPTH = 12;    // Below this, skip Brilliant/Great (too easy to be wrong)
const QUIESCE_DEPTH = 6;          // How many capture replies we look through

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/**
 * Converts centipawns (from the mover's perspective) to Win% [0..100].
 */
export function cpToWinPercent(cpForPlayer: number, mateForPlayer: number | null): number {
  if (mateForPlayer !== null) {
    return mateForPlayer > 0 ? 100 : 0;
  }
  const capped = clamp(cpForPlayer, -1000, 1000);
  const win = 50 + 50 * (2 / (1 + Math.exp(-WIN_PERCENT_K * capped)) - 1);
  return clamp(win, 0, 100);
}

/** Converts a UCI move ("g1f3") to SAN ("Nf3") in the given position. */
function uciToSan(fen: string, uci: string): string {
  if (!UCI_REGEX.test(uci)) return '';
  try {
    const game = new Chess(fen);
    return game.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci[4] as PieceSymbol | undefined,
    }).san;
  } catch {
    return '';
  }
}

/* -------------------------------------------------------------------------- */
/*  Sacrifice detection (used for "Brilliant")                                */
/* -------------------------------------------------------------------------- */

/** Material balance from the SIDE TO MOVE's point of view (own - opponent). */
function materialBalance(chess: Chess): number {
  const me = chess.turn();
  let total = 0;
  for (const row of chess.board()) {
    for (const sq of row) {
      if (!sq) continue;
      total += sq.color === me ? PIECE_VALUES[sq.type] : -PIECE_VALUES[sq.type];
    }
  }
  return total;
}

/**
 * Tiny capture-only search ("quiescence search").
 * It answers: "if both sides keep capturing, what does the material balance
 * settle at?" This lets us see through trades, so a piece that can simply be
 * recaptured is NOT counted as a sacrifice.
 * Returns the balance from the side-to-move's point of view.
 */
function quiesce(chess: Chess, alpha: number, beta: number, depth: number): number {
  const standPat = materialBalance(chess); // Option: stop capturing right now
  if (depth === 0 || standPat >= beta) return standPat;
  if (standPat > alpha) alpha = standPat;

  const captures = chess
    .moves({ verbose: true })
    .filter((m) => m.captured)
    // Look at the juiciest captures first (cheap piece taking big piece)
    .sort(
      (a, b) =>
        PIECE_VALUES[b.captured as PieceSymbol] - PIECE_VALUES[a.captured as PieceSymbol] ||
        PIECE_VALUES[a.piece] - PIECE_VALUES[b.piece]
    );

  for (const move of captures) {
    chess.move(move);
    const score = -quiesce(chess, -beta, -alpha, depth - 1);
    chess.undo();
    if (score >= beta) return score;
    if (score > alpha) alpha = score;
  }
  return alpha;
}

/**
 * How many material points did the mover give up with this move,
 * after all the captures settle down? (0 or less = no sacrifice)
 */
function sacrificePoints(fenBefore: string, uci: string): number {
  if (!UCI_REGEX.test(uci)) return 0;
  try {
    const game = new Chess(fenBefore);

    // Two baselines. We use the smaller gap so we never over-count.
    const staticBefore = materialBalance(game);
    const settledBefore = quiesce(game, -Infinity, Infinity, QUIESCE_DEPTH);

    game.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci[4] as PieceSymbol | undefined,
    });

    // Now the OPPONENT is to move, so flip the sign back to the mover's view.
    const settledAfter = -quiesce(game, -Infinity, Infinity, QUIESCE_DEPTH);

    return Math.min(staticBefore - settledAfter, settledBefore - settledAfter);
  } catch {
    return 0;
  }
}

/**
 * Brilliant = a real piece sacrifice that the engine still likes.
 *  1. Engine agrees with it (almost no win% lost)
 *  2. It really gives up material (a piece for a pawn or worse)
 *  3. The mover was not already winning big, and is not worse afterwards
 *     (exception: a big sacrifice that forces checkmate is always special)
 *  4. Not in the first few moves, and not a checkmating move
 */
function isBrilliantMove(params: {
  ply: number;
  uci: string;
  fenBefore: string;
  winPctBefore: number;
  winPctAfter: number;
  winLoss: number;
  givesMate: boolean;
  forcesMate: boolean; // the move leaves the mover with a forced mate
}): boolean {
  const { ply, uci, fenBefore, winPctBefore, winPctAfter, winLoss, givesMate, forcesMate } = params;

  if (givesMate || ply <= 6) return false;
  if (winLoss > 2) return false;

  const sacrificed = sacrificePoints(fenBefore, uci);

  // Giving up a piece or more to force mate: brilliant even if already winning
  if (forcesMate && sacrificed >= 3) return true;

  if (winPctBefore > 85 || winPctAfter < 45) return false;
  return sacrificed >= SACRIFICE_MIN_POINTS;
}

/* -------------------------------------------------------------------------- */
/*  Opening book                                                              */
/* -------------------------------------------------------------------------- */

export interface OpeningBook {
  names: string[];                    // names[0] is '' (= "in book, but unnamed")
  positions: Record<string, number>;  // position key -> index into names
}

// Same tiny 53-bit hash the book file was built with (keeps the file small).
function hashKey(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// Key = piece placement + side to move + castling. Move counters are ignored.
const bookKey = (fen: string) => hashKey(fen.split(' ').slice(0, 3).join(' '));

let bookPromise: Promise<OpeningBook | null> | null = null;

/** Loads /openings.json once. If it fails, the review still works (no Book labels). */
export function loadOpeningBook(): Promise<OpeningBook | null> {
  if (!bookPromise) {
    bookPromise = fetch('/openings.json')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: unknown) => {
        // Never trust loaded data: check its shape before using it
        const d = data as Partial<OpeningBook> | null;
        if (!d || !Array.isArray(d.names) || typeof d.positions !== 'object' || d.positions === null) {
          return null;
        }
        return { names: d.names.map((n) => String(n)), positions: d.positions } as OpeningBook;
      })
      .catch(() => null);
  }
  return bookPromise;
}

/**
 * For each move, says whether the position AFTER it is still "theory".
 * Once a game leaves the book it never comes back (like chess.com).
 */
export function findBookMoves(
  fensAfter: string[],
  book: OpeningBook | null
): { isBook: boolean; opening: string }[] {
  let stillInBook = book !== null;
  let lastName = '';
  return fensAfter.map((fen) => {
    if (!book || !stillInBook) return { isBook: false, opening: '' };
    const key = bookKey(fen);
    if (!Object.prototype.hasOwnProperty.call(book.positions, key)) {
      stillInBook = false;
      return { isBook: false, opening: '' };
    }
    const nameIndex = book.positions[key];
    if (nameIndex > 0 && book.names[nameIndex]) {
      // Names look like "C50 Italian Game". Show only the name part.
      lastName = book.names[nameIndex].replace(/^[A-E]\d\d\s+/, '');
    }
    return { isBook: true, opening: lastName };
  });
}

/* -------------------------------------------------------------------------- */
/*  Main classification                                                       */
/* -------------------------------------------------------------------------- */

function formatEval(ev: EngineEval): string {
  if (ev.terminal === 'checkmate') return ev.mate !== null && ev.mate > 0 ? '1-0' : '0-1';
  if (ev.terminal === 'draw') return '½-½';
  if (ev.mate !== null) return `${ev.mate > 0 ? '+' : '-'}M${Math.abs(ev.mate)}`;
  const pawns = ev.cp / 100;
  return `${pawns >= 0 ? '+' : ''}${pawns.toFixed(1)}`;
}

export function classifyPly(params: {
  ply: number;
  san: string;
  uci: string;
  fenBefore: string;
  fenAfter: string;
  turn: Color;
  evalBeforeWhite: EngineEval;
  evalAfterWhite: EngineEval;
  book?: { isBook: boolean; opening: string }; // from findBookMoves()
}): ReviewedMove {
  const { ply, san, uci, fenBefore, fenAfter, turn, evalBeforeWhite, evalAfterWhite } = params;
  const isBook = params.book?.isBook ?? false;
  const sign = turn === 'w' ? 1 : -1;

  // Flip White-perspective numbers into the mover's perspective
  const cpBeforePlayer = evalBeforeWhite.cp * sign;
  const mateBeforePlayer = evalBeforeWhite.mate !== null ? evalBeforeWhite.mate * sign : null;
  const cpAfterPlayer = evalAfterWhite.cp * sign;
  const mateAfterPlayer = evalAfterWhite.mate !== null ? evalAfterWhite.mate * sign : null;

  const winPctBefore = cpToWinPercent(cpBeforePlayer, mateBeforePlayer);
  const winPctAfter = cpToWinPercent(cpAfterPlayer, mateAfterPlayer);
  let winLoss = Math.max(0, winPctBefore - winPctAfter);

  const bestMoveUci = evalBeforeWhite.bestMoveUci;
  const playedBest = uci === bestMoveUci;
  const givesMate = evalAfterWhite.terminal === 'checkmate' && mateAfterPlayer !== null && mateAfterPlayer > 0;

  // Did the mover have a forced mate and then lose it?
  const hadMate = mateBeforePlayer !== null && mateBeforePlayer > 0;
  const keepsMate = mateAfterPlayer !== null && mateAfterPlayer > 0;
  const missedMate = hadMate && !keepsMate;

  // Only one legal move = no real decision was made
  let legalMoveCount = 0;
  try {
    legalMoveCount = new Chess(fenBefore).moves().length;
  } catch {
    legalMoveCount = 0;
  }
  const isForced = legalMoveCount === 1;

  if (isForced || givesMate || isBook) {
    winLoss = 0; // Engine noise must not punish a forced, mating or book move
  } else if (missedMate) {
    // Win% maxes out near 97%, so a lost mate can look tiny. Make it hurt.
    winLoss = Math.max(winLoss, 10);
  }

  // If the engine was stopped too early, its "only move" and "sacrifice" calls are guesses
  const reliable = (evalBeforeWhite.depth ?? MIN_RELIABLE_DEPTH) >= MIN_RELIABLE_DEPTH;

  // How much worse was the engine's 2nd best move than its best move?
  let secondBestGap = 0;
  if (evalBeforeWhite.alt) {
    const altMate = evalBeforeWhite.alt.mate !== null ? evalBeforeWhite.alt.mate * sign : null;
    const altWin = cpToWinPercent(evalBeforeWhite.alt.cp * sign, altMate);
    secondBestGap = winPctBefore - altWin;
  }

  let classification: MoveClassification;
  if (isForced) {
    classification = 'Forced';
  } else if (isBook) {
    classification = 'Book';
  } else if (
    reliable &&
    isBrilliantMove({
      ply,
      uci,
      fenBefore,
      winPctBefore,
      winPctAfter,
      winLoss,
      givesMate,
      forcesMate: keepsMate,
    })
  ) {
    classification = 'Brilliant';
  } else if (
    // Great = you found the ONLY good move. Not for mating moves, not when the
    // game was already lost (<15%) or already crushing (>90%).
    reliable &&
    playedBest &&
    !givesMate &&
    ply > 6 &&
    secondBestGap >= GREAT_MIN_GAP &&
    winPctBefore >= 15 &&
    winPctBefore <= 90
  ) {
    classification = 'Great';
  } else if (givesMate || playedBest || winLoss <= 0.5) {
    classification = 'Best';
  } else if (winLoss <= 2) {
    classification = 'Excellent';
  } else if (winLoss <= 5) {
    classification = 'Good';
  } else if (winLoss <= 10) {
    classification = 'Inaccuracy';
  } else if (winLoss <= 20) {
    classification = 'Mistake';
  } else {
    classification = 'Blunder';
  }

  // A lost mate that is not already a Mistake/Blunder is called a "Miss"
  if (missedMate && ['Best', 'Excellent', 'Good', 'Inaccuracy'].includes(classification)) {
    classification = 'Miss';
  }

  // Move accuracy (Lichess-style curve on the win% drop)
  const accuracy = clamp(103.1668 * Math.exp(-ACCURACY_K * winLoss) - 3.1669, 0, 100);

  return {
    ply,
    san,
    uci,
    fenBefore,
    fenAfter,
    turn,
    classification,
    winPctBefore,
    winPctAfter,
    winLoss,
    evalDisplay: formatEval(evalAfterWhite),
    bestMoveUci,
    bestMoveSan: uciToSan(fenBefore, bestMoveUci),
    accuracy,
    opening: params.book?.opening ?? '',
  };
}

/* -------------------------------------------------------------------------- */
/*  Whole-game numbers                                                        */
/* -------------------------------------------------------------------------- */

const stdDev = (xs: number[]) => {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
};

/**
 * Game accuracy for both sides, using the same idea as Lichess:
 *  - "Weighted mean": moves in wild, swingy positions count MORE
 *  - "Harmonic mean": one terrible move drags the score down hard
 * The final number is the average of the two.
 * A plain average (the old way) hides blunders in long games.
 */
export function computeGameAccuracy(moves: ReviewedMove[]): {
  white: number | null;
  black: number | null;
} {
  if (moves.length === 0) return { white: null, black: null };

  const toWhite = (turn: Color, pct: number) => (turn === 'w' ? pct : 100 - pct);

  // White's win% at every moment: before move 1, then after each move
  const points = [toWhite(moves[0].turn, moves[0].winPctBefore)];
  for (const m of moves) points.push(toWhite(m.turn, m.winPctAfter));

  // One "swinginess" weight per move, from a sliding window of win% values
  const windowSize = clamp(Math.floor(moves.length / 10), 2, 8);
  const firstWindow = points.slice(0, windowSize);
  const windows: number[][] = [];
  for (let i = 0; i < windowSize - 2; i++) windows.push(firstWindow);
  for (let i = 0; i + windowSize <= points.length; i++) {
    windows.push(points.slice(i, i + windowSize));
  }
  const weights = windows.map((w) => clamp(stdDev(w), 0.5, 12));

  const score = (color: Color): number | null => {
    let weightSum = 0;
    let weightedTotal = 0;
    let inverseTotal = 0;
    let count = 0;

    moves.forEach((m, i) => {
      if (m.turn !== color) return;
      const w = weights[i] ?? 1;
      weightSum += w;
      weightedTotal += m.accuracy * w;
      inverseTotal += 1 / Math.max(m.accuracy, 1); // avoid dividing by zero
      count += 1;
    });

    if (count === 0) return null;
    const weightedMean = weightedTotal / weightSum;
    const harmonicMean = count / inverseTotal;
    return clamp((weightedMean + harmonicMean) / 2, 0, 100);
  };

  return { white: score('w'), black: score('b') };
}

/** Counts how many moves of each label a side played. */
export function countClassifications(
  moves: ReviewedMove[],
  color: Color
): Record<MoveClassification, number> {
  const counts: Record<MoveClassification, number> = {
    Brilliant: 0,
    Great: 0,
    Best: 0,
    Excellent: 0,
    Good: 0,
    Book: 0,
    Forced: 0,
    Inaccuracy: 0,
    Miss: 0,
    Mistake: 0,
    Blunder: 0,
  };
  for (const m of moves) {
    if (m.turn === color) counts[m.classification] += 1;
  }
  return counts;
}