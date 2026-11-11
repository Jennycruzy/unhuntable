// The Hunt Map as the site shows it, worked out from what the collector stored: where the
// visible liquidation prices sit right now, and how often the price went on to reach a
// level that everyone could read. Nothing here is estimated: every row is a public account.
import type { HuntDb } from "./huntmap.js";

/** A level counts as near when it is within this share of the price. */
export const NEAR = 0.05;
/** How long a near level is followed after it is first seen. */
export const FOLLOW_MS = 24 * 60 * 60_000;
/** How long after a touch the price is given to come back. */
export const BACK_MS = 60 * 60_000;
/** The map shows levels up to this far from the price, in bands of one percent. */
export const MAP_PCT = 10;
export const MAP_COINS = 6;
export const NEAREST = 8;
export const TOUCHES = 12;

export interface MapLevel {
  account: string;
  side: "long" | "short";
  valueUsd: number;
  liqPx: number;
  /** Distance from the price as a signed percent: below the price is negative. */
  awayPct: number;
  leverage: number | null;
}

export interface MapCoin {
  coin: string;
  markPx: number;
  /** Money on visible liquidation prices within the map, in dollars. */
  usd: number;
  /** One band per percent from -MAP_PCT to +MAP_PCT: the money that is liquidated if the price gets there. */
  bands: { pct: number; usd: number; count: number }[];
  nearest: MapLevel[];
}

export interface Touch {
  account: string;
  coin: string;
  side: "long" | "short";
  valueUsd: number;
  liqPx: number;
  /** Price when the level was first seen near. */
  seenPx: number;
  seenMs: number;
  touchedMs: number;
  /** True when the price was halfway back to where it started within the hour. */
  cameBack: boolean;
}

export interface HuntMap {
  asOfMs: number;
  sinceMs: number;
  rounds: number;
  accounts: number;
  positions: number;
  usd: number;
  /** Resting stops read in the last day, each counted once. */
  stops: number;
  coins: MapCoin[];
  followed: {
    /** Visible levels first seen within NEAR of the price. */
    levels: number;
    /** How many of them the price reached within FOLLOW_MS. */
    reached: number;
    /** How many times the price reached the level the same distance away on the other side. */
    mirrorReached: number;
    /** Of the reached ones, how many saw the price halfway back within BACK_MS. */
    cameBack: number;
  };
  touches: Touch[];
}

interface LevelRow {
  ms: number;
  account: string;
  coin: string;
  side: "long" | "short";
  value_usd: number;
  mark_px: number;
  liq_px: number;
  leverage: number | null;
}

interface Candle {
  t: number;
  h: number;
  l: number;
  c: number;
}

/** What happened to one level after it was seen: the first minute the price reached it, the same for its mirror, and whether the price came back. */
export function follow(
  level: { side: "long" | "short"; liqPx: number; seenPx: number; seenMs: number },
  candles: Candle[],
): { touchedMs: number | null; mirrorMs: number | null; cameBack: boolean } {
  const gap = Math.abs(level.seenPx - level.liqPx);
  const long = level.side === "long";
  const mirror = long ? level.seenPx + gap : level.seenPx - gap;
  const half = long ? level.liqPx + gap / 2 : level.liqPx - gap / 2;
  let touchedMs: number | null = null;
  let mirrorMs: number | null = null;
  let cameBack = false;
  for (const k of candles) {
    // only whole minutes after the level was seen count
    if (k.t < level.seenMs) continue;
    if (k.t > level.seenMs + FOLLOW_MS + BACK_MS) break;
    const inWindow = k.t <= level.seenMs + FOLLOW_MS;
    if (touchedMs === null && inWindow && (long ? k.l <= level.liqPx : k.h >= level.liqPx)) touchedMs = k.t;
    if (mirrorMs === null && inWindow && (long ? k.h >= mirror : k.l <= mirror)) mirrorMs = k.t;
    if (touchedMs !== null && !cameBack && k.t > touchedMs && k.t <= touchedMs + BACK_MS && (long ? k.c >= half : k.c <= half)) cameBack = true;
  }
  return { touchedMs, mirrorMs, cameBack };
}

/** The map of the newest finished round. */
function mapCoins(rows: LevelRow[]): MapCoin[] {
  const byCoin = new Map<string, LevelRow[]>();
  for (const r of rows) byCoin.set(r.coin, [...(byCoin.get(r.coin) ?? []), r]);
  const coins: MapCoin[] = [];
  for (const [coin, list] of byCoin) {
    // every row of one coin in one round carries nearly the same mark; the middle one is used
    const marks = list.map((r) => r.mark_px).sort((a, b) => a - b);
    const markPx = marks[Math.floor(marks.length / 2)];
    const bands = Array.from({ length: MAP_PCT * 2 }, (_, i) => ({ pct: i < MAP_PCT ? i - MAP_PCT : i - MAP_PCT + 1, usd: 0, count: 0 }));
    const near: MapLevel[] = [];
    let usd = 0;
    for (const r of list) {
      const away = (r.liq_px / markPx - 1) * 100;
      // a liquidation price on the wrong side of the price is cross-margin noise, not a level
      if ((r.side === "long" && away >= 0) || (r.side === "short" && away <= 0)) continue;
      if (Math.abs(away) > MAP_PCT) continue;
      // band 3 holds levels more than 2% and up to 3% away; the small allowance keeps an exact 3% in it
      const step = Math.min(MAP_PCT, Math.max(1, Math.ceil(Math.abs(away) - 1e-9)));
      const band = bands.find((b) => b.pct === (away < 0 ? -step : step))!;
      band.usd += r.value_usd;
      band.count++;
      usd += r.value_usd;
      near.push({ account: r.account, side: r.side, valueUsd: r.value_usd, liqPx: r.liq_px, awayPct: away, leverage: r.leverage });
    }
    if (near.length === 0) continue;
    near.sort((a, b) => Math.abs(a.awayPct) - Math.abs(b.awayPct));
    coins.push({ coin, markPx, usd, bands, nearest: near.slice(0, NEAREST) });
  }
  return coins.sort((a, b) => b.usd - a.usd).slice(0, MAP_COINS);
}

export function huntMap(db: HuntDb): HuntMap | null {
  const span = db.prepare("SELECT min(ms) AS since, max(ms) AS latest, count(*) AS rounds FROM rounds").get() as { since: number | null; latest: number | null; rounds: number };
  if (span.latest === null || span.since === null) return null;
  const latest = db
    .prepare("SELECT ms, account, coin, side, value_usd, mark_px, liq_px, leverage FROM levels WHERE ms = ? AND liq_px IS NOT NULL")
    .all(span.latest) as LevelRow[];
  const stops = (db.prepare("SELECT count(DISTINCT oid) AS c FROM stops WHERE ms >= ?").get(span.latest - FOLLOW_MS) as { c: number }).c;

  // every time a level was within NEAR of the price, oldest first; the first sight of each starts a follow
  const near = db
    .prepare(
      `SELECT ms, account, coin, side, value_usd, mark_px, liq_px, leverage FROM levels
       WHERE liq_px IS NOT NULL AND abs(liq_px / mark_px - 1) <= ?
         AND ((side = 'long' AND liq_px < mark_px) OR (side = 'short' AND liq_px > mark_px))
         AND coin IN (SELECT DISTINCT coin FROM candles)
       ORDER BY ms`,
    )
    .all(NEAR) as LevelRow[];
  const candlesOf = new Map<string, Candle[]>();
  const readCandles = db.prepare("SELECT t, h, l, c FROM candles WHERE coin = ? ORDER BY t");
  const busyUntil = new Map<string, number>();
  const followed = { levels: 0, reached: 0, mirrorReached: 0, cameBack: 0 };
  const touches: Touch[] = [];
  for (const r of near) {
    const key = `${r.account} ${r.coin}`;
    if ((busyUntil.get(key) ?? 0) > r.ms) continue;
    busyUntil.set(key, r.ms + FOLLOW_MS);
    if (!candlesOf.has(r.coin)) candlesOf.set(r.coin, readCandles.all(r.coin) as Candle[]);
    const out = follow({ side: r.side, liqPx: r.liq_px, seenPx: r.mark_px, seenMs: r.ms }, candlesOf.get(r.coin)!);
    followed.levels++;
    if (out.mirrorMs !== null) followed.mirrorReached++;
    if (out.touchedMs === null) continue;
    followed.reached++;
    if (out.cameBack) followed.cameBack++;
    touches.push({
      account: r.account,
      coin: r.coin,
      side: r.side,
      valueUsd: r.value_usd,
      liqPx: r.liq_px,
      seenPx: r.mark_px,
      seenMs: r.ms,
      touchedMs: out.touchedMs,
      cameBack: out.cameBack,
    });
  }
  touches.sort((a, b) => b.valueUsd - a.valueUsd);
  return {
    asOfMs: span.latest,
    sinceMs: span.since,
    rounds: span.rounds,
    accounts: new Set(latest.map((r) => r.account)).size,
    positions: latest.length,
    usd: latest.reduce((a, r) => a + r.value_usd, 0),
    stops,
    coins: mapCoins(latest),
    followed,
    touches: touches.slice(0, TOUCHES),
  };
}

/** Serves the map from the collector's store, worked out again at most once a minute. */
export class HuntMapView {
  private cached: { at: number; map: HuntMap | null } | undefined;
  constructor(
    private readonly db: HuntDb,
    private readonly now: () => number = Date.now,
    private readonly everyMs = 60_000,
  ) {}

  read(): HuntMap | null {
    const t = this.now();
    if (!this.cached || t - this.cached.at >= this.everyMs) this.cached = { at: t, map: huntMap(this.db) };
    return this.cached.map;
  }
}
