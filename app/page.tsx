// src/app/page.tsx
'use client';

import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Chessboard } from 'react-chessboard';
import { parseAndSanitizePgn } from '@/lib/sanitizePgn';
import { StockfishAnalyzer } from '@/lib/stockfishClient';
import {
  classifyPly,
  EngineEval,
  ReviewedMove,
  MoveClassification,
} from '@/lib/reviewEngine';

const SAMPLE_PGN = `[Event "Sample Brilliancy"]
[White "Player 1"]
[Black "Player 2"]

1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Nf6 5. d4 exd4 6. cxd4 Bb4+ 7. Nc3 Nxe4 8. O-O Nxc3 9. bxc3 Bxc3 10. Qb3 Bxa1 11. Bxf7+ Kf8 12. Bg5 Ne7 13. Ne5 Bxd4 14. Bg6 d5 15. Qf3+ Bf5 16. Bxf5 Bxe5 17. Be6+ Bf6 18. Bxf6 gxf6 19. Qxf6+ Ke8 20. Qf7# 1-0`;

const BADGE_STYLES: Record<MoveClassification, string> = {
  Brilliant: 'bg-cyan-500/20 text-cyan-300 border-cyan-400',
  Best: 'bg-emerald-500/20 text-emerald-300 border-emerald-500',
  Good: 'bg-green-500/15 text-green-300 border-green-600',
  Inaccuracy: 'bg-yellow-500/20 text-yellow-300 border-yellow-500',
  Mistake: 'bg-orange-500/20 text-orange-300 border-orange-500',
  Blunder: 'bg-red-500/20 text-red-300 border-red-500',
};

const BADGE_SYMBOLS: Record<MoveClassification, string> = {
  Brilliant: '!!',
  Best: '★',
  Good: '✓',
  Inaccuracy: '?!',
  Mistake: '?',
  Blunder: '??',
};

export default function GameReviewPage() {
  const [pgnInput, setPgnInput] = useState(SAMPLE_PGN);
  const [reviewedMoves, setReviewedMoves] = useState<ReviewedMove[]>([]);
  const [currentIndex, setCurrentIndex] = useState<number>(-1);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const engineRef = useRef<StockfishAnalyzer | null>(null);

  useEffect(() => {
    return () => {
      engineRef.current?.terminate();
    };
  }, []);

  const handleAnalyze = async () => {
    setErrorMsg(null);
    setIsAnalyzing(true);
    setProgress(0);
    setReviewedMoves([]);
    setCurrentIndex(-1);

    try {
      const { plies } = parseAndSanitizePgn(pgnInput);

      if (!engineRef.current) {
        engineRef.current = new StockfishAnalyzer();
      }
      await engineRef.current.init();

      // Evaluate starting position + every subsequent FEN
      const evals: EngineEval[] = [];
      evals.push(await engineRef.current.evaluateFen(plies[0].fenBefore, 14));

      for (let i = 0; i < plies.length; i++) {
        const ev = await engineRef.current.evaluateFen(plies[i].fenAfter, 14);
        evals.push(ev);
        setProgress(Math.round(((i + 1) / plies.length) * 100));
      }

      const results: ReviewedMove[] = plies.map((ply, idx) =>
        classifyPly({
          ply: ply.ply,
          san: ply.san,
          uci: ply.uci,
          fenBefore: ply.fenBefore,
          fenAfter: ply.fenAfter,
          turn: ply.turn,
          evalBeforeWhite: evals[idx],
          evalAfterWhite: evals[idx + 1],
        })
      );

      setReviewedMoves(results);
      setCurrentIndex(0);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unexpected analysis error.');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const activeMove = currentIndex >= 0 ? reviewedMoves[currentIndex] : null;
  const currentFen = activeMove
    ? activeMove.fenAfter
    : reviewedMoves[0]?.fenBefore ?? 'start';

  // Draw arrow for the engine's best move when user made an Inaccuracy/Mistake/Blunder
  const customArrows = useMemo(() => {
    if (!activeMove) return [];
    if (
      ['Inaccuracy', 'Mistake', 'Blunder'].includes(activeMove.classification) &&
      activeMove.bestMoveUci.length >= 4
    ) {
      const from = activeMove.bestMoveUci.slice(0, 2);
      const to = activeMove.bestMoveUci.slice(2, 4);
      return [[from, to, 'rgb(16, 185, 129)']] as [string, string, string][];
    }
    return [];
  }, [activeMove]);

  const { whiteAccuracy, blackAccuracy } = useMemo(() => {
    const wMoves = reviewedMoves.filter((m) => m.turn === 'w');
    const bMoves = reviewedMoves.filter((m) => m.turn === 'b');
    const avg = (arr: ReviewedMove[]) =>
      arr.length
        ? (arr.reduce((sum, m) => sum + m.accuracy, 0) / arr.length).toFixed(1)
        : '—';
    return { whiteAccuracy: avg(wMoves), blackAccuracy: avg(bMoves) };
  }, [reviewedMoves]);

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 p-6">
      <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Board & Controls */}
        <div className="lg:col-span-6 flex flex-col items-center gap-4">
          <div className="w-full max-w-[480px] aspect-square rounded-lg overflow-hidden shadow-2xl border border-slate-800">
            <Chessboard
              {...({ position: currentFen, arePiecesDraggable: false, customArrows } as any)}
            />
          </div>

          {reviewedMoves.length > 0 && (
            <div className="flex items-center gap-3">
              <button
                onClick={() => setCurrentIndex(-1)}
                className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded text-sm"
              >
                |&lt;
              </button>
              <button
                onClick={() => setCurrentIndex((i) => Math.max(-1, i - 1))}
                className="px-4 py-1.5 bg-slate-800 hover:bg-slate-700 rounded text-sm"
              >
                Prev
              </button>
              <span className="text-sm text-slate-400 font-mono">
                {currentIndex + 1} / {reviewedMoves.length}
              </span>
              <button
                onClick={() =>
                  setCurrentIndex((i) => Math.min(reviewedMoves.length - 1, i + 1))
                }
                className="px-4 py-1.5 bg-slate-800 hover:bg-slate-700 rounded text-sm"
              >
                Next
              </button>
              <button
                onClick={() => setCurrentIndex(reviewedMoves.length - 1)}
                className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded text-sm"
              >
                &gt;|
              </button>
            </div>
          )}
        </div>

        {/* Right Column: PGN Input, Accuracy & Move List */}
        <div className="lg:col-span-6 flex flex-col gap-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <label className="block text-xs uppercase tracking-wider text-slate-400 mb-2">
              Paste PGN (Analyzed 100% Locally in Browser)
            </label>
            <textarea
              rows={4}
              value={pgnInput}
              onChange={(e) => setPgnInput(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-xs font-mono text-slate-200 focus:outline-none focus:border-cyan-500"
              placeholder="Paste PGN here..."
            />

            {errorMsg && (
              <p className="mt-2 text-xs text-red-400 bg-red-950/50 border border-red-800/60 p-2 rounded">
                {errorMsg}
              </p>
            )}

            <button
              onClick={handleAnalyze}
              disabled={isAnalyzing}
              className="mt-3 w-full py-2.5 bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-700 font-semibold rounded-lg text-sm transition"
            >
              {isAnalyzing ? `Analyzing Locally... ${progress}%` : 'Run Game Review'}
            </button>
          </div>

          {reviewedMoves.length > 0 && (
            <>
              {/* Accuracy Summary */}
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-slate-900 border border-slate-800 rounded-xl p-3 text-center">
                  <div className="text-xs text-slate-400">White Accuracy</div>
                  <div className="text-2xl font-bold text-white">{whiteAccuracy}%</div>
                </div>
                <div className="bg-slate-900 border border-slate-800 rounded-xl p-3 text-center">
                  <div className="text-xs text-slate-400">Black Accuracy</div>
                  <div className="text-2xl font-bold text-white">{blackAccuracy}%</div>
                </div>
              </div>

              {/* Active Move Banner */}
              {activeMove && (
                <div
                  className={`border rounded-xl p-3 flex items-center justify-between ${BADGE_STYLES[activeMove.classification]
                    }`}
                >
                  <div>
                    <span className="font-bold mr-2">
                      {BADGE_SYMBOLS[activeMove.classification]} {activeMove.san} is{' '}
                      {activeMove.classification}
                    </span>
                    <span className="text-xs opacity-80">
                      (Win% loss: {activeMove.winLoss.toFixed(1)}%)
                    </span>
                  </div>
                  <span className="font-mono text-sm font-bold">
                    Eval: {activeMove.evalDisplay}
                  </span>
                </div>
              )}

              {/* Scrollable Move List */}
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-3 max-h-72 overflow-y-auto grid grid-cols-2 gap-1.5 text-sm">
                {reviewedMoves.map((m, idx) => (
                  <button
                    key={m.ply}
                    onClick={() => setCurrentIndex(idx)}
                    className={`flex items-center justify-between px-2.5 py-1.5 rounded text-left transition ${idx === currentIndex
                      ? 'bg-slate-700 ring-1 ring-cyan-400'
                      : 'hover:bg-slate-800'
                      }`}
                  >
                    <span className="font-mono">
                      {m.turn === 'w' ? `${Math.ceil(m.ply / 2)}. ` : `${Math.ceil(m.ply / 2)}... `}
                      {m.san}
                    </span>
                    <span
                      className={`text-xs px-1.5 py-0.5 rounded border ${BADGE_STYLES[m.classification]
                        }`}
                    >
                      {BADGE_SYMBOLS[m.classification]}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </main>
  );
}