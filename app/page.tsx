// src/app/page.tsx
'use client';

import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Chessboard } from 'react-chessboard';
import { Chess } from 'chess.js';
import {
  BookOpen,
  Star,
  ThumbsUp,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  RotateCw,
} from 'lucide-react';
import { parseAndSanitizePgn } from '@/lib/sanitizePgn';
import { StockfishAnalyzer, ANALYSIS_CANCELLED } from '@/lib/stockfishClient';
import {
  classifyPly,
  computeGameAccuracy,
  countClassifications,
  findBookMoves,
  loadOpeningBook,
  EngineEval,
  ReviewedMove,
  MoveClassification,
} from '@/lib/reviewEngine';

// react-chessboard v5 does not understand the word 'start', so use a real FEN
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const SAMPLE_PGN = `[Event "Opera Game"]
[White "Paul Morphy"]
[Black "Duke Karl / Count Isouard"]
[Result "1-0"]

1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0`;

/* -------------------------------------------------------------------------- */
/*  Analysis speed choices                                                    */
/*  depth = how many moves ahead the engine looks. Each extra level costs     */
/*  roughly 1.5x more time, so Deep is MUCH slower than Quick.                */
/*  ms    = the most time one position may take (keeps slow phones safe).     */
/* -------------------------------------------------------------------------- */
const SPEED_MODES = {
  quick: { label: 'Quick', depth: 14, ms: 2000, hint: 'Fastest. Fine for a first look.' },
  standard: { label: 'Standard', depth: 16, ms: 3000, hint: 'Good balance of speed and accuracy.' },
  deep: { label: 'Deep', depth: 19, ms: 6000, hint: 'Most accurate, but 3x slower or more.' },
} as const;
type SpeedMode = keyof typeof SPEED_MODES;

/* -------------------------------------------------------------------------- */
/*  Look of every move label (colors, symbols, and the sentence in the coach)  */
/* -------------------------------------------------------------------------- */
const CLASS_META: Record<
  MoveClassification,
  { color: string; symbol: string; phrase: string }
> = {
  Brilliant: { color: '#26c2a3', symbol: '!!', phrase: 'a brilliant move' },
  Great: { color: '#749bbf', symbol: '!', phrase: 'a great move' },
  Best: { color: '#81b64c', symbol: '★', phrase: 'the best move' },
  Excellent: { color: '#81b64c', symbol: '👍', phrase: 'an excellent move' },
  Good: { color: '#95af8a', symbol: '✓', phrase: 'a good move' },
  Book: { color: '#a88865', symbol: '📖', phrase: 'a book move' },
  Forced: { color: '#8b8987', symbol: '→', phrase: 'a forced move' },
  Inaccuracy: { color: '#f7c631', symbol: '?!', phrase: 'an inaccuracy' },
  Miss: { color: '#ff7769', symbol: '×', phrase: 'a miss' },
  Mistake: { color: '#e58f2a', symbol: '?', phrase: 'a mistake' },
  Blunder: { color: '#ca3431', symbol: '??', phrase: 'a blunder' },
};

// Order used in the summary table
const SUMMARY_ORDER: MoveClassification[] = [
  'Brilliant', 'Great', 'Best', 'Excellent', 'Good', 'Book', 'Forced',
  'Inaccuracy', 'Miss', 'Mistake', 'Blunder',
];

// Labels that mean "you had something better" (we show the better move)
const BAD_LABELS: MoveClassification[] = ['Inaccuracy', 'Miss', 'Mistake', 'Blunder'];
// Labels worth a dot on the eval graph
const GRAPH_DOT_LABELS: MoveClassification[] = ['Brilliant', 'Great', 'Miss', 'Mistake', 'Blunder'];

/** Round badge with the label's symbol. Used on the board, move list and summary. */
function MoveIcon({ type, size = 20 }: { type: MoveClassification; size?: number }) {
  const meta = CLASS_META[type];
  const inner = Math.round(size * 0.62);
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full font-extrabold leading-none text-white shadow"
      style={{ width: size, height: size, backgroundColor: meta.color, fontSize: Math.round(size * 0.5) }}
      title={type}
    >
      {type === 'Book' ? (
        <BookOpen size={inner} strokeWidth={2.5} />
      ) : type === 'Best' ? (
        <Star size={inner} fill="currentColor" strokeWidth={0} />
      ) : type === 'Excellent' ? (
        <ThumbsUp size={inner} strokeWidth={2.5} />
      ) : (
        meta.symbol
      )}
    </span>
  );
}

export default function GameReviewPage() {
  const [pgnInput, setPgnInput] = useState(SAMPLE_PGN);
  const [reviewedMoves, setReviewedMoves] = useState<ReviewedMove[]>([]);
  const [headers, setHeaders] = useState<Record<string, string>>({});
  const [currentIndex, setCurrentIndex] = useState<number>(-1);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [speed, setSpeed] = useState<SpeedMode>('standard');
  const [flipped, setFlipped] = useState(false);
  // After a review finishes we hide the PGN box. "New review" brings it back.
  const [showInput, setShowInput] = useState(true);

  const engineRef = useRef<StockfishAnalyzer | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Stop the engine when the page closes
  useEffect(() => {
    return () => {
      engineRef.current?.terminate();
    };
  }, []);

  // Stop button: terminate() makes the waiting search fail with ANALYSIS_CANCELLED
  const handleStop = () => {
    engineRef.current?.terminate();
  };

  const handleAnalyze = async () => {
    setErrorMsg(null);
    setIsAnalyzing(true);
    setProgress(0);
    setReviewedMoves([]);
    setHeaders({});
    setCurrentIndex(-1);

    try {
      const { plies, headers: pgnHeaders } = parseAndSanitizePgn(pgnInput);
      const mode = SPEED_MODES[speed];

      if (!engineRef.current) {
        engineRef.current = new StockfishAnalyzer();
      }
      const engine = engineRef.current;

      // Load the opening book and start the engine at the same time
      const [book] = await Promise.all([loadOpeningBook(), engine.init()]);
      await engine.newGame();

      // evals[0] = start position, evals[i + 1] = position after ply i.
      // The position after one move is the position before the next move,
      // so every position is analysed exactly once.
      const total = plies.length + 1;
      const evals: EngineEval[] = [];
      evals.push(await engine.evaluateFen(plies[0].fenBefore, mode.depth, mode.ms));
      setProgress(Math.round((1 / total) * 100));

      for (let i = 0; i < plies.length; i++) {
        evals.push(await engine.evaluateFen(plies[i].fenAfter, mode.depth, mode.ms));
        setProgress(Math.round(((i + 2) / total) * 100));
      }

      // Which moves are still "opening theory"?
      const bookInfo = findBookMoves(plies.map((p) => p.fenAfter), book);

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
          book: bookInfo[idx],
        })
      );

      setHeaders(pgnHeaders);
      setReviewedMoves(results);
      setCurrentIndex(-1);
      setShowInput(false);
    } catch (err) {
      // A cancelled run is not an error the user needs to see
      if (!(err instanceof Error && err.message === ANALYSIS_CANCELLED)) {
        setErrorMsg(err instanceof Error ? err.message : 'Unexpected analysis error.');
      }
    } finally {
      setIsAnalyzing(false);
    }
  };

  // Left / Right arrow keys and Home / End move through the game
  useEffect(() => {
    if (reviewedMoves.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      // Do not steal keys while the user types in the PGN box
      if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) return;
      if (e.key === 'ArrowLeft') setCurrentIndex((i) => Math.max(-1, i - 1));
      else if (e.key === 'ArrowRight') setCurrentIndex((i) => Math.min(reviewedMoves.length - 1, i + 1));
      else if (e.key === 'Home') setCurrentIndex(-1);
      else if (e.key === 'End') setCurrentIndex(reviewedMoves.length - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [reviewedMoves.length]);

  // Keep the selected move visible inside the move list (scrolls only the list,
  // never the whole page)
  useEffect(() => {
    const box = listRef.current;
    if (!box || currentIndex < 0) return;
    const el = box.querySelector<HTMLElement>(`[data-ply="${currentIndex}"]`);
    if (el) box.scrollTop = el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2;
  }, [currentIndex]);

  const activeMove = currentIndex >= 0 ? reviewedMoves[currentIndex] : null;
  const currentFen = activeMove ? activeMove.fenAfter : START_FEN;

  // Green arrow for the better move, only when the player had a better move.
  // The board shows the position AFTER the played move, so we only draw the
  // arrow if the piece that should have moved is still on its square.
  const boardArrows = useMemo(() => {
    if (!activeMove || !BAD_LABELS.includes(activeMove.classification)) return [];
    if (activeMove.bestMoveUci.length < 4) return [];
    const from = activeMove.bestMoveUci.slice(0, 2);
    const to = activeMove.bestMoveUci.slice(2, 4);
    try {
      const piece = new Chess(activeMove.fenAfter).get(from as Parameters<Chess['get']>[0]);
      if (!piece || piece.color !== activeMove.turn) return [];
    } catch {
      return [];
    }
    return [{ startSquare: from, endSquare: to, color: 'rgb(129, 182, 76)' }];
  }, [activeMove]);

  // Draws every square. We highlight the move's two squares and put the label
  // badge on the square the piece moved to (like chess.com).
  // NOTE: when squareRenderer is used, react-chessboard ignores "squareStyles",
  // so the highlight has to be drawn here.
  const activeFrom = activeMove?.uci.slice(0, 2);
  const activeTo = activeMove?.uci.slice(2, 4);
  const activeClass = activeMove?.classification;
  const squareRenderer = useCallback(
    ({ square, children }: { piece: unknown; square: string; children?: React.ReactNode }) => {
      const marked = activeClass && (square === activeFrom || square === activeTo);
      return (
        <div
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            backgroundColor: marked ? `${CLASS_META[activeClass].color}73` : undefined,
          }}
        >
          {children}
          {activeClass && square === activeTo && (
            <span style={{ position: 'absolute', top: 2, right: 2, zIndex: 10 }}>
              <MoveIcon type={activeClass} size={24} />
            </span>
          )}
        </div>
      );
    },
    [activeFrom, activeTo, activeClass]
  );

  const accuracy = useMemo(() => computeGameAccuracy(reviewedMoves), [reviewedMoves]);
  const whiteCounts = useMemo(() => countClassifications(reviewedMoves, 'w'), [reviewedMoves]);
  const blackCounts = useMemo(() => countClassifications(reviewedMoves, 'b'), [reviewedMoves]);
  const fmt = (n: number | null) => (n === null ? '—' : n.toFixed(1));

  // White's winning chance after every move (index 0 = before the first move)
  const whitePercents = useMemo(() => {
    if (reviewedMoves.length === 0) return [50];
    const toWhite = (m: ReviewedMove, p: number) => (m.turn === 'w' ? p : 100 - p);
    return [
      toWhite(reviewedMoves[0], reviewedMoves[0].winPctBefore),
      ...reviewedMoves.map((m) => toWhite(m, m.winPctAfter)),
    ];
  }, [reviewedMoves]);
  const whiteWinPct = whitePercents[currentIndex + 1] ?? 50;

  // The text on the eval bar, e.g. "1.2" or "M3"
  const evalLabel = activeMove ? activeMove.evalDisplay.replace(/^[+-]/, '') : '0.0';

  // Opening name: the last one reached at or before the move we are looking at
  const openingName = useMemo(() => {
    for (let i = currentIndex; i >= 0; i--) {
      if (reviewedMoves[i]?.opening) return reviewedMoves[i].opening;
    }
    return '';
  }, [reviewedMoves, currentIndex]);

  // Pair the moves into rows: "1. e4 e5"
  const moveRows = useMemo(() => {
    const rows: { number: number; white?: ReviewedMove; black?: ReviewedMove }[] = [];
    reviewedMoves.forEach((m, idx) => {
      const rowIndex = Math.floor(idx / 2);
      if (!rows[rowIndex]) rows[rowIndex] = { number: rowIndex + 1 };
      if (m.turn === 'w') rows[rowIndex].white = m;
      else rows[rowIndex].black = m;
    });
    return rows;
  }, [reviewedMoves]);

  const hasReview = reviewedMoves.length > 0;
  const whiteName = headers.White || 'White';
  const blackName = headers.Black || 'Black';
  const whiteElo = headers.WhiteElo && headers.WhiteElo !== '?' ? ` (${headers.WhiteElo})` : '';
  const blackElo = headers.BlackElo && headers.BlackElo !== '?' ? ` (${headers.BlackElo})` : '';

  // Click on the eval graph jumps to that move
  const handleGraphClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!hasReview) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    setCurrentIndex(Math.round(ratio * reviewedMoves.length) - 1);
  };

  // The board is always square. It is as big as fits on screen (max 640px).
  const boardSize = 'min(calc(100vw - 72px), calc(100vh - 160px), 640px)';

  // Small player name bar shown above and below the board
  const renderPlayerBar = (color: 'w' | 'b') => (
    <div className="flex items-center gap-2 px-1 text-sm font-semibold text-white">
      <span
        className={`inline-block h-4 w-4 rounded-sm border border-black/40 ${color === 'w' ? 'bg-white' : 'bg-[#403d39]'}`}
      />
      <span className="truncate">{color === 'w' ? whiteName : blackName}</span>
      <span className="text-xs font-normal text-[#989795]">{color === 'w' ? whiteElo : blackElo}</span>
    </div>
  );

  return (
    <main className="min-h-screen bg-[#262522] text-[#c3c2c1]">
      {/* Top bar */}
      <header className="border-b border-black/30 bg-[#21201d] px-5 py-3">
        <span className="text-xl font-extrabold tracking-tight text-white">
          Free<span className="text-[#81b64c]">View</span>
        </span>
        <span className="ml-3 text-xs text-[#989795]">Free chess game review · runs 100% in your browser</span>
      </header>

      <div className="mx-auto flex max-w-[1200px] flex-col items-center gap-5 p-3 lg:flex-row lg:items-start lg:justify-center lg:p-6">
        {/* ------------------------- Left: eval bar + board ------------------------- */}
        <div className="flex gap-2">
          {/* Eval bar. The white part grows with White's winning chance. */}
          <div
            className="relative w-7 shrink-0 self-end overflow-hidden rounded bg-[#403d39]"
            style={{ height: `calc(${boardSize} + 0px)`, marginBottom: 28 }}
            aria-label="Evaluation bar"
          >
            <div
              className="absolute inset-x-0 bg-white transition-all duration-300"
              style={flipped ? { top: 0, height: `${whiteWinPct}%` } : { bottom: 0, height: `${whiteWinPct}%` }}
            />
            <span
              className={`absolute inset-x-0 text-center text-[10px] font-bold ${
                whiteWinPct >= 50 ? 'text-[#403d39]' : 'text-white'
              }`}
              style={(whiteWinPct >= 50) !== flipped ? { bottom: 4 } : { top: 4 }}
            >
              {evalLabel}
            </span>
          </div>

          <div className="flex flex-col gap-1.5" style={{ width: boardSize }}>
            {renderPlayerBar(flipped ? 'w' : 'b')}
            <div className="aspect-square w-full overflow-hidden rounded shadow-2xl">
              {/* react-chessboard v5 reads everything from the "options" prop */}
              <Chessboard
                options={{
                  id: 'review-board',
                  position: currentFen,
                  boardOrientation: flipped ? 'black' : 'white',
                  allowDragging: false,
                  allowDrawingArrows: false,
                  arrows: boardArrows,
                  squareRenderer,
                  animationDurationInMs: 150,
                  lightSquareStyle: { backgroundColor: '#eeeed2' },
                  darkSquareStyle: { backgroundColor: '#769656' },
                }}
              />
            </div>
            {renderPlayerBar(flipped ? 'b' : 'w')}
          </div>
        </div>

        {/* ---------------------------- Right: the panel ---------------------------- */}
        <aside className="flex w-full max-w-[640px] flex-col overflow-hidden rounded-lg bg-[#21201d] shadow-xl lg:w-[400px]">
          <div className="flex items-center justify-between bg-[#1b1a18] px-4 py-3">
            <h1 className="text-base font-bold text-white">Game Review</h1>
            {hasReview && !showInput && (
              <button
                onClick={() => setShowInput(true)}
                className="rounded bg-[#3a3835] px-3 py-1 text-xs font-semibold text-white hover:bg-[#45433f]"
              >
                New review
              </button>
            )}
          </div>

          {/* ---- PGN input + speed choice ---- */}
          {(showInput || !hasReview) && (
            <div className="flex flex-col gap-3 p-4">
              <label className="text-xs font-semibold uppercase tracking-wider text-[#989795]">
                Paste PGN
              </label>
              <textarea
                rows={6}
                value={pgnInput}
                onChange={(e) => setPgnInput(e.target.value)}
                className="w-full resize-none rounded-md border border-[#3a3835] bg-[#262522] p-2.5 font-mono text-xs text-[#dcdbda] focus:border-[#81b64c] focus:outline-none"
                placeholder="Paste PGN here..."
              />

              <div>
                <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-[#989795]">
                  Analysis speed
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  {(Object.keys(SPEED_MODES) as SpeedMode[]).map((key) => (
                    <button
                      key={key}
                      onClick={() => setSpeed(key)}
                      disabled={isAnalyzing}
                      className={`rounded-md py-1.5 text-sm font-semibold transition ${
                        speed === key
                          ? 'bg-[#81b64c] text-white'
                          : 'bg-[#3a3835] text-[#c3c2c1] hover:bg-[#45433f]'
                      }`}
                    >
                      {SPEED_MODES[key].label}
                      <span className="block text-[10px] font-normal opacity-80">
                        depth {SPEED_MODES[key].depth}
                      </span>
                    </button>
                  ))}
                </div>
                <p className="mt-1.5 text-xs text-[#989795]">{SPEED_MODES[speed].hint}</p>
              </div>

              {errorMsg && (
                <p className="rounded border border-red-800/60 bg-red-950/50 p-2 text-xs text-red-300">
                  {errorMsg}
                </p>
              )}

              {isAnalyzing && (
                <div className="h-2 overflow-hidden rounded bg-[#3a3835]">
                  <div
                    className="h-full bg-[#81b64c] transition-all duration-300"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              )}

              <div className="flex gap-2">
                <button
                  onClick={handleAnalyze}
                  disabled={isAnalyzing}
                  className="flex-1 rounded-md bg-[#81b64c] py-3 text-base font-extrabold text-white shadow-[0_4px_0_#45753c] transition hover:bg-[#8fc255] disabled:bg-[#3a3835] disabled:shadow-none"
                >
                  {isAnalyzing ? `Analyzing... ${progress}%` : 'Start Review'}
                </button>
                {isAnalyzing && (
                  <button
                    onClick={handleStop}
                    className="rounded-md bg-[#3a3835] px-4 text-sm font-semibold text-white hover:bg-[#45433f]"
                  >
                    Stop
                  </button>
                )}
              </div>
            </div>
          )}

          {/* ---- The review itself ---- */}
          {hasReview && !showInput && (
            <>
              {/* Coach box: tells you what the current move was */}
              <div className="border-b border-black/30 bg-[#262522] p-4">
                {activeMove ? (
                  <>
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <MoveIcon type={activeMove.classification} size={30} />
                        <span
                          className="truncate text-lg font-bold"
                          style={{ color: CLASS_META[activeMove.classification].color }}
                        >
                          {activeMove.san} is {CLASS_META[activeMove.classification].phrase}
                        </span>
                      </div>
                      <span className="rounded bg-[#1b1a18] px-2 py-1 font-mono text-sm font-bold text-white">
                        {activeMove.evalDisplay}
                      </span>
                    </div>
                    {BAD_LABELS.includes(activeMove.classification) && activeMove.bestMoveSan && (
                      <p className="mt-2 text-sm text-[#c3c2c1]">
                        Best was <b className="text-[#81b64c]">{activeMove.bestMoveSan}</b>
                      </p>
                    )}
                    {activeMove.classification === 'Brilliant' && (
                      <p className="mt-2 text-sm">A smart sacrifice that the engine agrees with.</p>
                    )}
                    {activeMove.classification === 'Great' && (
                      <p className="mt-2 text-sm">The only move that kept the position strong.</p>
                    )}
                    {openingName && (
                      <p className="mt-2 text-xs text-[#a88865]">📖 {openingName}</p>
                    )}
                  </>
                ) : (
                  <p className="text-sm">
                    <b className="text-white">
                      {whiteName} vs {blackName}
                    </b>
                    {headers.Result ? ` · ${headers.Result}` : ''}
                    <br />
                    <span className="text-[#989795]">Press → or tap Next to start the review.</span>
                  </p>
                )}
              </div>

              {/* Accuracy */}
              <div className="grid grid-cols-2 gap-3 p-4">
                <div className="rounded-md bg-white p-2.5 text-center text-[#262522]">
                  <div className="truncate text-xs font-semibold">{whiteName}</div>
                  <div className="text-2xl font-extrabold">{fmt(accuracy.white)}</div>
                  <div className="text-[10px] uppercase tracking-wide opacity-70">Accuracy</div>
                </div>
                <div className="rounded-md bg-[#403d39] p-2.5 text-center text-white">
                  <div className="truncate text-xs font-semibold">{blackName}</div>
                  <div className="text-2xl font-extrabold">{fmt(accuracy.black)}</div>
                  <div className="text-[10px] uppercase tracking-wide opacity-70">Accuracy</div>
                </div>
              </div>

              {/* Eval graph. Click it to jump to a move. */}
              <div className="px-4 pb-3">
                <div
                  onClick={handleGraphClick}
                  className="relative h-16 cursor-pointer overflow-hidden rounded bg-[#403d39]"
                  role="img"
                  aria-label="Evaluation graph. Click to jump to a move."
                >
                  <svg
                    className="absolute inset-0 h-full w-full"
                    viewBox={`0 0 ${Math.max(whitePercents.length - 1, 1) * 10} 100`}
                    preserveAspectRatio="none"
                  >
                    {/* White's advantage = the white area under the line */}
                    <path
                      d={`M0,100 ${whitePercents.map((p, i) => `L${i * 10},${100 - p}`).join(' ')} L${
                        (whitePercents.length - 1) * 10
                      },100 Z`}
                      fill="#f1f1f1"
                    />
                    <line
                      x1="0"
                      x2={(whitePercents.length - 1) * 10}
                      y1="50"
                      y2="50"
                      stroke="#7a7774"
                      strokeWidth="1"
                      vectorEffect="non-scaling-stroke"
                    />
                  </svg>
                  {/* Coloured dots on the big moments */}
                  {reviewedMoves.map((m, i) =>
                    GRAPH_DOT_LABELS.includes(m.classification) ? (
                      <span
                        key={m.ply}
                        className="absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-black/40"
                        style={{
                          left: `${((i + 1) / reviewedMoves.length) * 100}%`,
                          top: `${100 - whitePercents[i + 1]}%`,
                          backgroundColor: CLASS_META[m.classification].color,
                        }}
                      />
                    ) : null
                  )}
                  {/* Marker for the move we are looking at */}
                  <span
                    className="absolute inset-y-0 w-0.5 bg-[#81b64c]"
                    style={{ left: `${((currentIndex + 1) / reviewedMoves.length) * 100}%` }}
                  />
                </div>
              </div>

              {/* Move list */}
              <div
                ref={listRef}
                className="relative mx-4 max-h-56 overflow-y-auto rounded-md bg-[#262522] p-1 text-sm"
              >
                {moveRows.map((row) => (
                  <div key={row.number} className="grid grid-cols-[2.2rem_1fr_1fr] items-center">
                    <span className="pl-1 text-xs text-[#989795]">{row.number}.</span>
                    {[row.white, row.black].map((m, col) =>
                      m ? (
                        <button
                          key={m.ply}
                          data-ply={m.ply - 1}
                          onClick={() => setCurrentIndex(m.ply - 1)}
                          className={`flex items-center gap-1.5 rounded px-1.5 py-1 text-left font-semibold transition ${
                            m.ply - 1 === currentIndex
                              ? 'bg-[#454441] text-white'
                              : 'text-[#dcdbda] hover:bg-[#32312e]'
                          }`}
                        >
                          <MoveIcon type={m.classification} size={16} />
                          {m.san}
                        </button>
                      ) : (
                        <span key={col} />
                      )
                    )}
                  </div>
                ))}
              </div>

              {/* Summary: how many moves of each kind */}
              <div className="mx-4 mt-3 rounded-md bg-[#262522] p-3 text-sm">
                {SUMMARY_ORDER.filter((c) => whiteCounts[c] + blackCounts[c] > 0).map((c) => (
                  <div key={c} className="grid grid-cols-[2rem_1fr_2rem] items-center py-0.5">
                    <span className="text-right font-mono text-white">{whiteCounts[c]}</span>
                    <span className="flex items-center justify-center gap-1.5 text-xs">
                      <MoveIcon type={c} size={16} />
                      <span className="w-20" style={{ color: CLASS_META[c].color }}>
                        {c}
                      </span>
                    </span>
                    <span className="font-mono text-white">{blackCounts[c]}</span>
                  </div>
                ))}
              </div>

              {/* Controls stay at the bottom */}
              <div className="mt-3 flex items-center justify-center gap-2 border-t border-black/30 bg-[#1b1a18] p-3">
                {[
                  { label: 'First move', icon: <ChevronsLeft size={20} />, go: () => setCurrentIndex(-1), off: currentIndex < 0 },
                  { label: 'Previous move', icon: <ChevronLeft size={20} />, go: () => setCurrentIndex((i) => Math.max(-1, i - 1)), off: currentIndex < 0 },
                  { label: 'Next move', icon: <ChevronRight size={20} />, go: () => setCurrentIndex((i) => Math.min(reviewedMoves.length - 1, i + 1)), off: currentIndex >= reviewedMoves.length - 1 },
                  { label: 'Last move', icon: <ChevronsRight size={20} />, go: () => setCurrentIndex(reviewedMoves.length - 1), off: currentIndex >= reviewedMoves.length - 1 },
                ].map((b) => (
                  <button
                    key={b.label}
                    aria-label={b.label}
                    onClick={b.go}
                    disabled={b.off}
                    className="flex h-10 w-14 items-center justify-center rounded bg-[#3a3835] text-white hover:bg-[#45433f] disabled:opacity-30"
                  >
                    {b.icon}
                  </button>
                ))}
                <button
                  aria-label="Flip board"
                  onClick={() => setFlipped((f) => !f)}
                  className="ml-2 flex h-10 w-12 items-center justify-center rounded bg-[#3a3835] text-white hover:bg-[#45433f]"
                >
                  <RotateCw size={18} />
                </button>
              </div>
            </>
          )}
        </aside>
      </div>
    </main>
  );
}