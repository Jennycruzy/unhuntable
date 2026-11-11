import { describe, expect, it } from "vitest";
import { Hyperliquid } from "../src/hl.js";
import { HuntCollector, Pacer, REPLAY_WINDOW_MS, liquidationsOf, openHuntDb } from "../src/huntmap.js";
import { huntMap, replayOf } from "../src/huntview.js";

const A = "0x0423b4b2acb4f219ae4a270abd5dde2360e455bb";
const B = "0x" + "b2".repeat(20);
const T = 1_793_131_664_774;
const FIVE = 5 * 60_000;

// The shape of a real liquidation fill on trade.xyz, from Hyperliquid's userFillsByTime.
const fill = (over: Record<string, unknown> = {}) => ({
  coin: "xyz:HOOD",
  side: "A",
  px: "89.834",
  sz: "22.858",
  time: T,
  dir: "Close Long",
  liquidation: { liquidatedUser: A, markPx: "89.987", method: "market" },
  ...over,
});

describe("liquidations in a fill history", () => {
  it("groups the fills of one liquidation into one event with their average price", () => {
    const fills = [fill(), fill({ px: "89.818", sz: "0.701" }), fill({ px: "89.807", sz: "2.163", time: T + 400 })];
    const [l, ...rest] = liquidationsOf(A.toUpperCase().replace("0X", "0x"), fills);
    expect(rest).toEqual([]);
    expect(l).toMatchObject({ account: A, coin: "xyz:HOOD", ms: T, side: "long", markPx: 89.987, method: "market" });
    expect(l.size).toBeCloseTo(25.722, 6);
    expect(l.valueUsd).toBeCloseTo(89.834 * 22.858 + 89.818 * 0.701 + 89.807 * 2.163, 6);
    expect(l.px).toBeCloseTo(l.valueUsd / l.size, 9);
  });

  it("keeps only fills where this account was the one liquidated, reads a buy as a short, and splits by coin and time", () => {
    const fills = [
      fill({ liquidation: { liquidatedUser: B, markPx: "1", method: "market" } }),
      fill({ liquidation: undefined }),
      fill({ coin: "ETH", side: "B", px: "2400", sz: "100", dir: "Close Short" }),
      fill({ time: T + 2 * 60_000 }),
    ];
    const out = liquidationsOf(A, fills);
    expect(out.map((l) => [l.coin, l.side, l.ms])).toEqual([
      ["ETH", "short", T],
      ["xyz:HOOD", "long", T + 2 * 60_000],
    ]);
    expect(liquidationsOf(A, {} as any)).toEqual([]);
  });
});

describe("a replay", () => {
  const k = (t: number, o: number, h: number, l: number, c: number) => ({ t, o, h, l, c });
  const around = (closes: number[]) => closes.map((c, i) => k(T - REPLAY_WINDOW_MS + i * FIVE, c, c + 0.3, c - 0.3, c));

  it("says the price came back when it is past the liquidation price an hour later", () => {
    const candles = around([92, 92, 91.5, 91, 90.8, 90.6, 90.4, 90.2, 90.1, 90, 89.9, 90, 91.3, 91.4, 91.6, 91.6, 91.7, 91.7, 91.8, 91.8, 91.9, 92, 92, 92.1, 92.2]);
    candles[12] = k(T, 90, 91.6, 89.53, 91.26);
    const r = replayOf({ account: A, coin: "xyz:HOOD", ms: T, side: "long", px: 89.83, value_usd: 2310 }, candles)!;
    expect(r).toMatchObject({ beforePx: 92, afterPx: 92.2, extremePx: 89.53, cameBack: true });
    expect(r.candles).toHaveLength(25);
  });

  it("says it did not when the price stayed through the level, and reads a short the other way", () => {
    const down = around(Array.from({ length: 25 }, (_, i) => 92 - i * 0.2));
    expect(replayOf({ account: A, coin: "xyz:HOOD", ms: T, side: "long", px: 89.83, value_usd: 1 }, down)!.cameBack).toBe(false);
    // a short is liquidated on a spike up; it came back when the price is below the level an hour later
    const spike = around(Array.from({ length: 25 }, (_, i) => (i <= 12 ? 100 + i * 0.13 : 101.56 - (i - 12) * 0.08)));
    const r = replayOf({ account: A, coin: "ETH", ms: T, side: "short", px: 101.5, value_usd: 1 }, spike)!;
    expect(r.extremePx).toBeCloseTo(101.86, 6);
    expect(r.cameBack).toBe(true);
    const stays = around(Array.from({ length: 25 }, (_, i) => 100 + i * 0.1));
    expect(replayOf({ account: A, coin: "ETH", ms: T, side: "short", px: 101.5, value_usd: 1 }, stays)!.cameBack).toBe(false);
  });

  it("is not made without the hour after", () => {
    const short = around([92, 92, 91.5, 91, 90.8, 90.6, 90.4, 90.2, 90.1, 90, 89.9, 90, 91.3]);
    expect(replayOf({ account: A, coin: "xyz:HOOD", ms: T, side: "long", px: 89.83, value_usd: 1 }, short)).toBeNull();
  });
});

describe("the collector and the map", () => {
  it("reads fill histories in turn, stores big liquidations with their candles, and the map counts the comebacks", async () => {
    const db = openHuntDb(":memory:");
    let t = T + 3 * REPLAY_WINDOW_MS;
    db.prepare("INSERT INTO accounts (address, first_ms, read_ms, held_ms) VALUES (?, 1, 1, 0), (?, 2, 1, 0)").run(A, B);
    const calls: any[] = [];
    const hlFetch = (async (_u: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body));
      calls.push(b);
      if (b.type === "userFillsByTime") {
        // $200K liquidated: big enough for a replay
        return Response.json(b.user === A ? [fill({ px: "89.834", sz: "2226.3" })] : []);
      }
      if (b.type === "candleSnapshot" && b.req.interval === "5m") {
        return Response.json(
          Array.from({ length: 25 }, (_, i) => {
            const at = b.req.startTime + i * FIVE;
            const c = i === 12 ? 91.26 : i < 12 ? 92 - i * 0.15 : 91.3 + (i - 12) * 0.07;
            return { t: at, T: at + FIVE - 1, s: b.req.coin, i: "5m", o: String(c), c: String(c), h: String(c + 0.3), l: String(i === 12 ? 89.53 : c - 0.3), v: "1", n: 1 };
          }),
        );
      }
      if (b.type === "clearinghouseState") return Response.json({ assetPositions: [] });
      return Response.json([]);
    }) as unknown as typeof fetch;
    const collector = new HuntCollector(db, new Hyperliquid("https://hl.test", hlFetch), {
      fetch: (async () => new Response("[]")) as typeof fetch,
      now: () => t,
      pacer: new Pacer(1e9, () => t, async () => {}),
      fillsPerRound: 1,
      accountsPerRound: 0,
      scanPerRound: 0,
    });
    db.prepare("INSERT INTO rounds (ms, accounts, levels, stops, errors, took_ms) VALUES (?, 0, 0, 0, 0, 1)").run(t - 1);
    await collector.round();
    // one account per round, the one read longest ago first
    expect(calls.filter((c) => c.type === "userFillsByTime").map((c) => c.user)).toEqual([A]);
    expect(db.prepare("SELECT account, coin, side FROM liquidations").all()).toEqual([{ account: A, coin: "xyz:HOOD", side: "long" }]);
    expect((db.prepare("SELECT count(*) AS n FROM replay_candles").get() as { n: number }).n).toBe(25);
    t += 5 * 60_000;
    await collector.round();
    expect(calls.filter((c) => c.type === "userFillsByTime").map((c) => c.user)).toEqual([A, B]);
    // candles are not asked for again
    expect(calls.filter((c) => c.type === "candleSnapshot" && c.req.interval === "5m")).toHaveLength(1);

    const map = huntMap(db)!;
    expect(map.replays).toMatchObject({ days: 17, minUsd: 100_000, events: 1, cameBack: 1 });
    expect(map.replays.items[0]).toMatchObject({ account: A, coin: "xyz:HOOD", side: "long", extremePx: 89.53, cameBack: true });
  });
});
