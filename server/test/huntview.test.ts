import { describe, expect, it } from "vitest";
import { openHuntDb, type HuntDb } from "../src/huntmap.js";
import { BACK_MS, FOLLOW_MS, HuntMapView, follow, huntMap } from "../src/huntview.js";
import { buildServer } from "../src/index.js";
import { memoryDb, testConfig } from "./helpers.js";

const MIN = 60_000;
const T0 = 1_000 * MIN;

function store() {
  const db = openHuntDb(":memory:");
  const level = db.prepare(
    "INSERT INTO levels (ms, account, coin, side, szi, value_usd, entry_px, mark_px, liq_px, leverage, cross_margin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
  );
  const candle = db.prepare("INSERT INTO candles (coin, t, o, h, l, c) VALUES (?, ?, ?, ?, ?, ?)");
  const round = db.prepare("INSERT INTO rounds (ms, accounts, levels, stops, errors, took_ms) VALUES (?, 1, 1, 0, 0, 1)");
  return {
    db,
    round: (ms: number) => round.run(ms),
    level: (ms: number, account: string, coin: string, side: "long" | "short", usd: number, mark: number, liq: number | null) =>
      level.run(ms, account, coin, side, side === "long" ? 1 : -1, usd, mark, mark, liq, 10),
    candle: (coin: string, t: number, h: number, l: number, c: number) => candle.run(coin, t, c, h, l, c),
  };
}

describe("following one level", () => {
  const long = { side: "long" as const, liqPx: 97, seenPx: 100, seenMs: T0 };
  const flat = (t: number) => ({ t, h: 100.5, l: 99.5, c: 100 });

  it("is untouched while the price stays between the level and its mirror", () => {
    expect(follow(long, [flat(T0), flat(T0 + MIN)])).toEqual({ touchedMs: null, mirrorMs: null, cameBack: false });
  });

  it("is touched by the first low at the level, and came back when a close is halfway back within the hour", () => {
    const candles = [flat(T0), { t: T0 + MIN, h: 100, l: 96.9, c: 97.2 }, { t: T0 + 2 * MIN, h: 99, l: 97, c: 98.6 }];
    expect(follow(long, candles)).toEqual({ touchedMs: T0 + MIN, mirrorMs: null, cameBack: true });
  });

  it("does not count a comeback that takes longer than the hour", () => {
    const candles = [{ t: T0 + MIN, h: 100, l: 96.9, c: 97 }, { t: T0 + MIN + BACK_MS + MIN, h: 99, l: 97, c: 99 }];
    expect(follow(long, candles).cameBack).toBe(false);
  });

  it("reads a short the other way round: the level is above, the mirror below", () => {
    const short = { side: "short" as const, liqPx: 103, seenPx: 100, seenMs: T0 };
    expect(follow(short, [{ t: T0 + MIN, h: 103.1, l: 99, c: 102 }])).toMatchObject({ touchedMs: T0 + MIN, mirrorMs: null });
    expect(follow(short, [{ t: T0 + MIN, h: 101, l: 96.9, c: 98 }])).toMatchObject({ touchedMs: null, mirrorMs: T0 + MIN });
  });

  it("ignores minutes before the level was seen and after a day has passed", () => {
    const candles = [{ t: T0 - MIN, h: 100, l: 90, c: 95 }, { t: T0 + FOLLOW_MS + MIN, h: 100, l: 90, c: 95 }];
    expect(follow(long, candles).touchedMs).toBeNull();
  });
});

describe("the map", () => {
  it("is null before the first round", () => {
    expect(huntMap(openHuntDb(":memory:"))).toBeNull();
  });

  function filled(): HuntDb {
    const s = store();
    s.round(T0);
    s.round(T0 + 5 * MIN);
    // seen near in the first round, still there in the second: followed once
    for (const ms of [T0, T0 + 5 * MIN]) s.level(ms, "0xa", "BTC", "long", 2_000_000, 100, 97);
    // a short whose level is reached while its mirror is not
    s.level(T0, "0xb", "BTC", "short", 5_000_000, 100, 102);
    // far away: on the map's edge, not followed
    s.level(T0 + 5 * MIN, "0xc", "BTC", "short", 1_000_000, 100, 109.5);
    // beyond the map, wrong side, no level, and a coin without candles
    s.level(T0 + 5 * MIN, "0xd", "BTC", "long", 9_000_000, 100, 50);
    s.level(T0 + 5 * MIN, "0xe", "BTC", "long", 9_000_000, 100, 101);
    s.level(T0 + 5 * MIN, "0xf", "BTC", "long", 9_000_000, 100, null);
    s.level(T0 + 5 * MIN, "0xa", "DOGE", "long", 3_000_000, 1, 0.98);
    s.candle("BTC", T0, 100.2, 99.8, 100);
    s.candle("BTC", T0 + MIN, 102.1, 100, 101.9);
    s.candle("BTC", T0 + 2 * MIN, 101.5, 100.4, 100.6);
    s.db.prepare("INSERT INTO stops (ms, account, coin, side, kind, trigger_px, size, oid) VALUES (?, '0xa', 'BTC', 'long', 'stop', 98, 1, ?)").run(T0, 7);
    s.db.prepare("INSERT INTO stops (ms, account, coin, side, kind, trigger_px, size, oid) VALUES (?, '0xa', 'BTC', 'long', 'stop', 98, 1, ?)").run(T0 + 5 * MIN, 7);
    return s.db;
  }

  it("draws the newest round: money per band, nearest levels first, coins by money", () => {
    const map = huntMap(filled())!;
    expect(map).toMatchObject({ asOfMs: T0 + 5 * MIN, sinceMs: T0, rounds: 2, stops: 1 });
    // positions with a visible liquidation price in the newest round
    expect(map.positions).toBe(5);
    expect(map.coins.map((c) => c.coin)).toEqual(["BTC", "DOGE"]);
    const btc = map.coins[0];
    expect(btc.markPx).toBe(100);
    expect(btc.usd).toBe(3_000_000);
    expect(btc.bands).toHaveLength(20);
    expect(btc.bands.filter((b) => b.usd > 0)).toEqual([
      { pct: -3, usd: 2_000_000, count: 1 },
      { pct: 10, usd: 1_000_000, count: 1 },
    ]);
    expect(btc.nearest.map((l) => l.account)).toEqual(["0xa", "0xc"]);
    expect(btc.nearest[0].awayPct).toBeCloseTo(-3, 6);
  });

  it("follows each near level once and counts the ones the price reached, their mirrors and the comebacks", () => {
    const map = huntMap(filled())!;
    // 0xa long BTC and 0xb short BTC; DOGE has no candles and is left out
    expect(map.followed).toEqual({ levels: 2, reached: 1, mirrorReached: 0, cameBack: 1 });
    expect(map.touches).toEqual([
      { account: "0xb", coin: "BTC", side: "short", valueUsd: 5_000_000, liqPx: 102, seenPx: 100, seenMs: T0, touchedMs: T0 + MIN, cameBack: true },
    ]);
  });

  it("is served at /api/hunt-map, worked out again only after a minute", async () => {
    const db = filled();
    let t = 0;
    const view = new HuntMapView(db, () => t);
    const app = buildServer({ config: testConfig(), db: memoryDb(), huntMap: view });
    const first = (await app.inject({ method: "GET", url: "/api/hunt-map" })).json().map;
    expect(first.rounds).toBe(2);
    db.prepare("INSERT INTO rounds (ms, accounts, levels, stops, errors, took_ms) VALUES (?, 1, 0, 0, 0, 1)").run(T0 + 10 * MIN);
    t = 59_000;
    expect((await app.inject({ method: "GET", url: "/api/hunt-map" })).json().map.rounds).toBe(2);
    t = 61_000;
    expect((await app.inject({ method: "GET", url: "/api/hunt-map" })).json().map.rounds).toBe(3);
    await app.close();
  });

  it("serves no map when the server has no collector store", async () => {
    const app = buildServer({ config: testConfig(), db: memoryDb() });
    expect((await app.inject({ method: "GET", url: "/api/hunt-map" })).json()).toEqual({ map: null });
    await app.close();
  });
});
