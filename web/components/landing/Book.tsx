"use client";
// The hero: one order book, drawn as a price ladder. The heat on it is real: liquidation money read from
// Hyperliquid's public API by our collector. The position marked "you" and the price path are an
// illustration of the same trade twice: once public, once through Unhuntable.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MapCoin } from "../../lib/types";
import { money, px } from "../../lib/huntmap";

type View = "public" | "hidden";

const RANGE = 10; // percent above and below the price
const STOP = -1.5; // the example stop, percent from the price
const LIQ = -2.6; // the example liquidation
const PIECES = [
  { p: 6.2, f: 0.18 },
  { p: -7.4, f: 0.62 },
  { p: 3.4, f: 0.44 },
  { p: -4.6, f: 0.27 },
  { p: 8.1, f: 0.7 },
  { p: -8.9, f: 0.36 },
];

/* timeline, in ms from the start of a run */
const T = {
  you: 1500,
  lock: 2400,
  hunt1: 3300,
  hunt1End: 5000,
  turn: 5600,
  split: 6200,
  splitEnd: 7300,
  search: 7400,
  hunt2: 8800,
  hunt2End: 10500,
  done: 10800,
  loop: 17000,
};

const ease = (u: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, u)), 3);
const easeIO = (u: number) => {
  const x = Math.min(1, Math.max(0, u));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

/** A small, steady wiggle for the price, the same on every run. */
function drift(i: number): number {
  return Math.sin(i * 0.37) * 0.16 + Math.sin(i * 0.11 + 1.3) * 0.22 + Math.sin(i * 0.83 + 0.4) * 0.07;
}

/** How far a hunt has pushed the price at a moment: a fast push through the level, then straight back. */
function push(t: number, from: number, to: number, depth: number): number {
  if (t < from || t > to) return 0;
  const u = (t - from) / (to - from);
  if (u < 0.38) return depth * easeIO(u / 0.38);
  if (u < 0.5) return depth;
  return depth * (1 - easeIO((u - 0.5) / 0.5)) + 0.25 * easeIO((u - 0.5) / 0.5);
}

function tier(usd: number): number {
  return usd >= 6e7 ? 5 : usd >= 3e7 ? 4 : usd >= 1e7 ? 3 : usd >= 1e6 ? 2 : 1;
}

export function Book({ coin, asOfMs }: { coin: MapCoin | null; asOfMs: number | null }) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 1000, h: 640 });
  const [view, setView] = useState<View>("public");
  const [stage, setStage] = useState(0); // drives captions and classes
  const [run, setRun] = useState(0);
  const [manual, setManual] = useState(false);
  const [still, setStill] = useState(false);

  const trace = useRef<SVGPathElement>(null);
  const reticle = useRef<SVGGElement>(null);
  const you = useRef<SVGGElement>(null);
  const stopLine = useRef<SVGGElement>(null);
  const liqLine = useRef<SVGGElement>(null);
  const seal = useRef<SVGGElement>(null);
  const pieceRefs = useRef<(SVGGElement | null)[]>([]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const w = Math.max(320, Math.round(e.contentRect.width));
      const h = Math.max(300, Math.round(e.contentRect.height));
      setSize((s) => (s.w === w && s.h === h ? s : { w, h }));
    });
    ro.observe(el);
    try {
      setStill(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    } catch {
      /* no media queries: animate */
    }
    return () => ro.disconnect();
  }, []);

  const { w: W, h: H } = size;
  const narrow = W < 640;
  const padL = narrow ? 40 : 58;
  const padR = narrow ? 64 : 96;
  const y = useCallback((p: number) => H / 2 - (p * (H * 0.44)) / RANGE, [H]);
  const traceX0 = padL + 4;
  const traceX1 = W * (narrow ? 0.62 : 0.6);
  const youX = narrow ? padL + 18 : padL + 30;
  const lockX = narrow ? W - padR - 70 : W - padR - 150;

  const bands = useMemo(() => {
    if (!coin) return [];
    const maxW = (W - padL - padR) * (narrow ? 0.5 : 0.4);
    return coin.bands
      .filter((b) => b.usd > 0 && Math.abs(b.pct) <= RANGE)
      .map((b) => {
        const f = Math.min(1, Math.max(0.1, Math.log10(b.usd / 2e5) / Math.log10(2e8 / 2e5)));
        return { ...b, w: maxW * f, t: tier(b.usd) };
      });
  }, [coin, W, padL, padR, narrow]);

  /* the animation: one loop writes attributes on refs; React only changes stage for words and classes */
  useEffect(() => {
    if (still || manual) return;
    let raf = 0;
    let t0 = performance.now();
    let last = -1;
    let visible = true;
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
    });
    if (box.current) io.observe(box.current);

    const N = 70;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (!visible || document.hidden) {
        t0 = now - last;
        return;
      }
      let t = now - t0;
      if (t > T.loop) {
        t0 = now;
        t = 0;
        setRun((r) => r + 1);
      }
      last = t;
      const st = t < T.you ? 0 : t < T.lock ? 1 : t < T.hunt1 ? 2 : t < T.turn ? 3 : t < T.split ? 4 : t < T.search ? 5 : t < T.hunt2 ? 6 : t < T.done ? 7 : 8;
      setStage((s) => (s === st ? s : st));
      setView(st >= 4 ? "hidden" : "public");

      // price: a rolling line whose head is "now"
      const shift = t / 70;
      let d = "";
      for (let i = 0; i <= N; i++) {
        const k = i / N;
        const age = (1 - k) * 2200; // ms behind the head
        const at = t - age;
        const p = drift(shift - (N - i)) * 0.9 + push(at, T.hunt1, T.hunt1End, STOP - 0.55) + push(at, T.hunt2, T.hunt2End, STOP - 0.55);
        d += `${i ? "L" : "M"}${(traceX0 + (traceX1 - traceX0) * k).toFixed(1)} ${y(p).toFixed(1)}`;
      }
      trace.current?.setAttribute("d", d);

      // you: the pill, the stop and the liquidation; then split into pieces
      const appear = ease((t - T.you) / 600);
      const split = easeIO((t - T.split) / (T.splitEnd - T.split));
      you.current?.setAttribute("opacity", String(appear * (1 - split)));
      you.current?.setAttribute("transform", `translate(0 ${(1 - appear) * 10})`);
      stopLine.current?.setAttribute("opacity", String(appear * (1 - ease((t - T.split) / 500))));
      liqLine.current?.setAttribute("opacity", String(appear * (1 - ease((t - T.split) / 500))));
      seal.current?.setAttribute("opacity", String(ease((t - T.split - 300) / 600)));
      seal.current?.setAttribute("transform", `translate(${W - padR - 6} ${lerp(y(STOP), y(STOP) - 4, split)})`);
      pieceRefs.current.forEach((g, i) => {
        if (!g) return;
        const pc = PIECES[i];
        const u = easeIO((t - T.split - i * 60) / (T.splitEnd - T.split - 200));
        const tx = lerp(youX + 8 + i * 14, padL + 30 + pc.f * (W - padL - padR - 120), u);
        const ty = lerp(y(0), y(pc.p), u);
        g.setAttribute("transform", `translate(${tx.toFixed(1)} ${ty.toFixed(1)})`);
        g.setAttribute("opacity", String(t < T.split ? 0 : Math.min(1, u * 3)));
      });

      // the hunter's scope
      const r = reticle.current;
      if (r) {
        let rx = traceX1 + 80;
        let ry = y(4);
        let ro = ease((t - T.you) / 900);
        if (t >= T.lock && t < T.turn) {
          const u = ease((t - T.lock) / 700);
          rx = lerp(traceX1 + 80, lockX, u);
          ry = lerp(y(4), y(STOP), u);
        } else if (t >= T.turn && t < T.search) {
          rx = lockX;
          ry = y(STOP);
          ro = 1 - ease((t - T.turn) / 400) * 0.5;
        } else if (t >= T.search) {
          const s = (t - T.search) / 1000;
          rx = W * 0.55 + Math.sin(s * 2.1) * W * 0.18;
          ry = y(Math.sin(s * 1.3 + 0.6) * 6);
          ro = 0.85;
        }
        r.setAttribute("transform", `translate(${rx.toFixed(1)} ${ry.toFixed(1)})`);
        r.setAttribute("opacity", String(ro));
      }
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
    };
  }, [still, manual, W, H, y, traceX0, traceX1, padL, padR, youX, lockX]);

  /* a still frame for reduced motion, or after a visitor picks a view */
  useEffect(() => {
    if (!(still || manual)) return;
    const hidden = view === "hidden";
    let d = "";
    for (let i = 0; i <= 70; i++) d += `${i ? "L" : "M"}${(traceX0 + ((traceX1 - traceX0) * i) / 70).toFixed(1)} ${y(drift(i) * 0.9).toFixed(1)}`;
    trace.current?.setAttribute("d", d);
    you.current?.setAttribute("opacity", hidden ? "0" : "1");
    you.current?.setAttribute("transform", "translate(0 0)");
    stopLine.current?.setAttribute("opacity", hidden ? "0" : "1");
    liqLine.current?.setAttribute("opacity", hidden ? "0" : "1");
    seal.current?.setAttribute("opacity", hidden ? "1" : "0");
    seal.current?.setAttribute("transform", `translate(${W - padR - 6} ${y(STOP) - 4})`);
    pieceRefs.current.forEach((g, i) => {
      if (!g) return;
      const pc = PIECES[i];
      g.setAttribute("transform", `translate(${(padL + 30 + pc.f * (W - padL - padR - 120)).toFixed(1)} ${y(pc.p).toFixed(1)})`);
      g.setAttribute("opacity", hidden ? "1" : "0");
    });
    reticle.current?.setAttribute("transform", hidden ? `translate(${W * 0.5} ${y(5)})` : `translate(${lockX} ${y(STOP)})`);
    reticle.current?.setAttribute("opacity", "1");
    setStage(hidden ? 8 : 2);
  }, [still, manual, view, W, H, y, traceX0, traceX1, padL, padR, lockX]);

  const pick = (v: View) => {
    setManual(true);
    setView(v);
  };
  const replay = () => {
    setManual(false);
    setRun((r) => r + 1);
  };

  const captions = [
    "The book, as anyone can read it.",
    "Your position, in public.",
    "A hunter locks onto your stop.",
    "Pushed to your stop. Sold at the low. Price comes straight back.",
    "The same trade, through Unhuntable.",
    "Split into accounts nobody can link. The stop is sealed.",
    "The hunter looks for a level.",
    "Same push. Nothing to hit.",
    "Nothing to hunt.",
  ];
  const stamp =
    stage === 2 ? "LOCKED · STOP " + (coin ? px(coin.markPx * (1 + STOP / 100)) : "") : stage === 3 ? "STOP HIT" : stage === 6 ? "SEARCHING" : stage >= 7 ? "NO SIGNATURE" : "";

  const levelsLine = coin
    ? `${coin.coin} liquidation levels on Hyperliquid, read ${asOfMs ? agoShort(asOfMs) : "recently"} from its public API. The position and price path are an illustration.`
    : "The position and price path are an illustration.";

  return (
    <figure className={`lp-book run-${run % 2} st-${stage} v-${view}${still ? " still" : ""}`} aria-labelledby="lp-book-cap">
      <div className="lp-book-box" ref={box}>
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden="true" focusable="false">
          <g className="lp-rows">
            {Array.from({ length: RANGE * 4 + 1 }, (_, i) => {
              const p = RANGE - i / 2;
              const major = Number.isInteger(p);
              return <line key={i} className={major ? "major" : "fine"} x1={padL} x2={W - padR} y1={y(p)} y2={y(p)} pathLength={1} />;
            })}
          </g>
          <g className="lp-axis">
            {Array.from({ length: RANGE + 1 }, (_, i) => {
              const p = RANGE - i * 2;
              return (
                <text key={p} x={padL - 10} y={y(p) + 4} textAnchor="end">
                  {p > 0 ? `+${p}%` : `${p}%`}
                </text>
              );
            })}
          </g>
          <g className="lp-heat">
            {bands.map((b, i) => (
              <g key={b.pct} className={`band t${b.t}`} transform={`translate(${W - padR} ${y(b.pct)})`}>
                <rect className="bar" x={-b.w} y={-5} width={b.w} height={10} />
                <rect className="glow" x={-b.w} y={-11} width={b.w} height={22} />
                {!narrow || i % 2 === 0 ? (
                  <text className="amt" x={-b.w - 10} y={4} textAnchor="end">
                    {money(b.usd)}
                  </text>
                ) : null}
              </g>
            ))}
          </g>
          <g className="lp-mark">
            <line x1={padL} x2={W - padR} y1={y(0)} y2={y(0)} />
            <rect x={W - padR + 6} y={y(0) - 11} width={padR - 10} height={22} />
            <text x={W - padR + 6 + (padR - 10) / 2} y={y(0) + 4} textAnchor="middle">
              {coin ? px(coin.markPx) : "price"}
            </text>
          </g>
          <path className="lp-trace" ref={trace} d="" />

          <g ref={stopLine} className="lp-stop" opacity={0}>
            <line x1={padL} x2={W - padR} y1={y(STOP)} y2={y(STOP)} />
            <text x={padL + 8} y={y(STOP) - 8}>
              YOUR STOP · ON THE BOOK
            </text>
          </g>
          <g ref={liqLine} className="lp-liq" opacity={0}>
            <line x1={padL} x2={W - padR} y1={y(LIQ)} y2={y(LIQ)} />
            <text x={padL + 8} y={y(LIQ) + 16}>
              YOUR LIQUIDATION · PUBLIC
            </text>
          </g>
          <g ref={you} className="lp-you" opacity={0}>
            <rect x={youX} y={y(0) - 30} width={narrow ? 118 : 150} height={22} />
            <text x={youX + 10} y={y(0) - 15}>
              {narrow ? "YOU · $250K" : "YOU · LONG $250K"}
            </text>
          </g>
          {PIECES.map((_, i) => (
            <g key={i} className="lp-piece" opacity={0} ref={(el) => void (pieceRefs.current[i] = el)}>
              <rect x={-14} y={-4} width={28} height={8} />
              {!narrow && (
                <text x={20} y={4}>
                  {`acct ${i + 1}`}
                </text>
              )}
            </g>
          ))}
          <g ref={seal} className="lp-seal" opacity={0}>
            <rect x={-22} y={-14} width={22} height={18} />
            <path d="M-17 -14 v-5 a6 6 0 0 1 12 0 v5" />
            <text x={-30} y={0} textAnchor="end">
              STOP · SEALED IN AN ENCLAVE
            </text>
          </g>
          <g ref={reticle} className="lp-reticle" opacity={0}>
            <circle r={24} />
            <circle r={2.5} className="dot" />
            <line x1={-36} x2={-28} y1={0} y2={0} />
            <line x1={28} x2={36} y1={0} y2={0} />
            <line x1={0} x2={0} y1={-36} y2={-28} />
            <line x1={0} x2={0} y1={28} y2={36} />
            {stamp && (
              <text className="stamp" x={0} y={50} textAnchor="middle">
                {stamp}
              </text>
            )}
          </g>
          <rect className="lp-flash" x={padL} y={y(STOP) - 16} width={W - padL - padR} height={32} />
        </svg>
      </div>
      <div className="lp-book-bar">
        <p className="lp-cap" aria-live="off">
          {captions[stage]}
        </p>
        <div className="lp-views" role="group" aria-label="Pick a view">
          <button type="button" aria-pressed={view === "public"} onClick={() => pick("public")}>
            What hunters see
          </button>
          <button type="button" aria-pressed={view === "hidden"} onClick={() => pick("hidden")}>
            Through Unhuntable
          </button>
          {!still && (
            <button type="button" className="replay" onClick={replay} aria-label="Play the hunt again">
              ↻
            </button>
          )}
        </div>
      </div>
      <figcaption id="lp-book-cap" className="lp-note">
        {levelsLine}
      </figcaption>
    </figure>
  );
}

function agoShort(ms: number): string {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}
