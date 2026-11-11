// Words and rows for the Hunt Map page.
import type { MapCoin, Replay } from "./types";

export function px(v: number): string {
  return v.toLocaleString("en-US", { maximumFractionDigits: v >= 1000 ? 0 : v >= 10 ? 2 : 4 });
}

export function money(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${Math.round(v / 1e6)}M`;
  if (v >= 1e3) return `$${Math.round(v / 1e3)}K`;
  return `$${Math.round(v)}`;
}

export function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** "3.1% below" or "0.8% above": where a level sits from the price. */
export function awayText(awayPct: number): string {
  return `${Math.abs(awayPct).toFixed(1)}% ${awayPct < 0 ? "below" : "above"}`;
}

export type BandRow = { kind: "band"; pct: number; px: number; usd: number; count: number } | { kind: "price" };

/** The bands that hold money, highest price first, with the price itself in its place between them. */
export function bandRows(coin: MapCoin): BandRow[] {
  const held = coin.bands.filter((b) => b.usd > 0).sort((a, b) => b.pct - a.pct);
  const row = (b: MapCoin["bands"][number]): BandRow => ({ kind: "band", pct: b.pct, px: coin.markPx * (1 + b.pct / 100), usd: b.usd, count: b.count });
  return [...held.filter((b) => b.pct > 0).map(row), { kind: "price" }, ...held.filter((b) => b.pct < 0).map(row)];
}

/** One replay drawn in a 100 x 40 box: the closes as a line, the liquidation price as a level, the moment as a mark. */
export function replayPath(r: Replay): { line: string; levelY: number; markX: number; extremeY: number } {
  const ys = [...r.candles.flatMap((k) => [k.h, k.l]), r.px];
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const t0 = r.candles[0].t;
  const t1 = r.candles[r.candles.length - 1].t;
  const x = (t: number) => (t1 === t0 ? 0 : ((t - t0) / (t1 - t0)) * 100);
  const y = (v: number) => (hi === lo ? 20 : 38 - ((v - lo) / (hi - lo)) * 36);
  const line = r.candles.map((k, i) => `${i ? "L" : "M"}${x(k.t).toFixed(2)} ${y(k.c).toFixed(2)}`).join(" ");
  return { line, levelY: y(r.px), markX: Math.min(100, Math.max(0, x(r.ms))), extremeY: y(r.extremePx) };
}

/** "Back above the level an hour later" or "Still below the level an hour later". */
export function replayVerdict(r: Replay): string {
  const where = r.side === "long" ? (r.cameBack ? "Back above" : "Still below") : r.cameBack ? "Back below" : "Still above";
  return `${where} the level an hour later`;
}
