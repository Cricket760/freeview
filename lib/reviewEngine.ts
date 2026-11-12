// src/lib/reviewEngine.ts
import { Chess, PieceSymbol, Color } from 'chess.js';

export type MoveClassification =
  | 'Brilliant'
  | 'Best'
  | 'Good'
  | 'Inaccuracy'
  | 'Mistake'
  | 'Blunder';

export interface EngineEval {
  cp: number;          // Centipawns from White's perspective
  mate: number | null; // Moves to mate from White's perspective (+White, -Black)
  bestMoveUci: string; // e.g., "e2e4"
}

export interface ReviewedMove {
  ply: number;
  san: string;
  uci: string;
  fenBefore: string;
  fenAfter: string;
  turn: Color;
  classification: MoveClassification;
  winPctBefore: number;
  winPctAfter: number;
  winLoss: number;
  evalDisplay: string;
  bestMoveUci: string;
  accuracy: number;
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

/**
 * Converts centipawns (from side-to-move's perspective) to Win% [0..100]
 */
export function cpToWinPercent(cpForPlayer: number, mateForPlayer: number | null): number {
  if (mateForPlayer !== null) {
    return mateForPlayer > 0 ? 100 : 0;
  }
  const clamped = Math.max(-1000, Math.min(1000, cpForPlayer));
  const win = 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * clamped)) - 1);
  return Math.max(0, Math.min(100, win));
}

function getMaterialCount(chess: Chess, color: Color): number {
  let total = 0;
  for (const row of chess.board()) {
    for (const sq of row) {
      if (sq && sq.color === color) {
        total += PIECE_VALUES[sq.type];
      }
    }
  }
  return total;
}

/**
 * Custom Brilliant Rule:
 * 1. Win% loss is between 0% and 3%
 * 2. Player's material points strictly decrease after opponent's best engine move
 * 3. Guard: Player was not already overwhelmingly winning (> 85% Win%)
 */
// Replace the checkBrilliantMove and accuracy calculation in src/lib/reviewEngine.ts

function checkBrilliantMove(params: {
  ply: number;
  uci: string;
  bestMoveUci: string;
  fenBefore: string;
  winPctBefore: number;
  winLoss: number;
}): boolean {
  const { ply, uci, bestMoveUci, fenBefore, winPctBefore, winLoss } = params;

  // 1. Must be past move 10 (ply > 20), not already winning, and win loss must be a tiny sacrifice (0.1% - 3%)
  // 0.0% is usually just normal book/forced play, not "brilliant".
  if (ply <= 20 || winLoss < 0.2 || winLoss > 3 || winPctBefore > 85) {
    return false;
  }

  // 2. A brilliant move shouldn't be the absolute #1 engine move (otherwise it's just "Best")
  if (uci === bestMoveUci) {
    return false;
  }

  if (!UCI_REGEX.test(uci)) return false;

  try {
    const sim = new Chess(fenBefore);
    const playerColor = sim.turn();
    const materialBefore = getMaterialCount(sim, playerColor);

    sim.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci[4] as PieceSymbol | undefined,
    });

    const materialAfter = getMaterialCount(sim, playerColor);

    // 3. Your material must drop on your move (the sacrifice)
    return materialAfter < materialBefore;
  } catch {
    return false;
  }
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
}): ReviewedMove {
  const { ply, san, uci, fenBefore, fenAfter, turn, evalBeforeWhite, evalAfterWhite } = params;
  const sign = turn === 'w' ? 1 : -1;

  const cpBeforePlayer = evalBeforeWhite.cp * sign;
  const mateBeforePlayer = evalBeforeWhite.mate !== null ? evalBeforeWhite.mate * sign : null;

  const cpAfterPlayer = evalAfterWhite.cp * sign;
  const mateAfterPlayer = evalAfterWhite.mate !== null ? evalAfterWhite.mate * sign : null;

  const winPctBefore = cpToWinPercent(cpBeforePlayer, mateBeforePlayer);
  const winPctAfter = cpToWinPercent(cpAfterPlayer, mateAfterPlayer);
  const winLoss = Math.max(0, winPctBefore - winPctAfter);

  // Move accuracy formula (Lichess-inspired exponential decay on Win% drop)
  // Steeper decay factor so accuracies match Chess.com (~83% instead of ~90%)
  const accuracy = Math.max(
    0,
    Math.min(100, 103.1668 * Math.exp(-0.065 * winLoss) - 3.1669)
  );

  let classification: MoveClassification;
  if (
    checkBrilliantMove({
      ply,
      uci,
      bestMoveUci: evalBeforeWhite.bestMoveUci,
      fenBefore,
      winPctBefore,
      winLoss,
    })
  ) {
    classification = 'Brilliant';
  } else if (winLoss <= 1.5 || uci === evalBeforeWhite.bestMoveUci) {
    classification = 'Best';
  } else if (winLoss <= 4) {
    classification = 'Good';
  } else if (winLoss <= 8) {
    classification = 'Inaccuracy';
  } else if (winLoss <= 16) {
    classification = 'Mistake';
  } else {
    classification = 'Blunder';
  }

  let evalDisplay = '0.0';
  if (evalAfterWhite.mate !== null) {
    evalDisplay = `${evalAfterWhite.mate > 0 ? '+' : '-'}M${Math.abs(evalAfterWhite.mate)}`;
  } else {
    const pawns = evalAfterWhite.cp / 100;
    evalDisplay = `${pawns >= 0 ? '+' : ''}${pawns.toFixed(1)}`;
  }

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
    evalDisplay,
    bestMoveUci: evalBeforeWhite.bestMoveUci,
    accuracy,
  };
}