// src/lib/sanitizePgn.ts
import { Chess } from 'chess.js';

const MAX_PGN_BYTES = 32_768; // 32 KB limit prevents memory exhaustion / DoS
const MAX_PLIES = 300;        // Prevents browser freeze on massive synthetic PGNs

export interface ParsedPly {
  ply: number;
  san: string;
  uci: string;
  fenBefore: string;
  fenAfter: string;
  turn: 'w' | 'b';
}

export function parseAndSanitizePgn(rawInput: unknown): {
  plies: ParsedPly[];
  headers: Record<string, string>;
} {
  if (typeof rawInput !== 'string') {
    throw new Error('Invalid input type.');
  }

  const byteLength = new TextEncoder().encode(rawInput).length;
  if (byteLength === 0 || byteLength > MAX_PGN_BYTES) {
    throw new Error(`PGN must be between 1 byte and ${MAX_PGN_BYTES} bytes.`);
  }

  // Strip null bytes and non-printable control characters (keep \n, \r, \t)
  const cleaned = rawInput.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();

  const loader = new Chess();
  try {
    loader.loadPgn(cleaned, { strict: false });
  } catch {
    throw new Error('Malformed PGN. Please paste a valid PGN game.');
  }

  const history = loader.history({ verbose: true });
  if (history.length === 0) {
    throw new Error('No valid moves found in PGN.');
  }
  if (history.length > MAX_PLIES) {
    throw new Error(`Game exceeds maximum supported length of ${MAX_PLIES} half-moves.`);
  }

  // Sanitize header values for safe text display
  const rawHeaders = loader.getHeaders();
  const safeHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawHeaders)) {
    if (typeof v === 'string') {
      safeHeaders[k.slice(0, 32)] = v.replace(/[<>]/g, '').slice(0, 100);
    }
  }

  // Replay step-by-step to capture exact FENs
  const replay = new Chess();
  const plies: ParsedPly[] = history.map((move, index) => {
    const fenBefore = replay.fen();
    const turn = replay.turn();
    replay.move(move);
    const fenAfter = replay.fen();

    return {
      ply: index + 1,
      san: move.san,
      uci: `${move.from}${move.to}${move.promotion ?? ''}`,
      fenBefore,
      fenAfter,
      turn,
    };
  });

  return { plies, headers: safeHeaders };
}