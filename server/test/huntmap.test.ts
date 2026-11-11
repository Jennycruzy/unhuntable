import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Hyperliquid } from "../src/hl.js";
import { HuntCollector, MIN_FREE_BYTES, Pacer, biggestAccounts, candleCoins, levelsOf, openHuntDb, stopsOf, type Level } from "../src/huntmap.js";
import { topAccounts } from "../src/whale.js";
import { fixture } from "./helpers.js";

// Stored real replies: the head of Hyperliquid's public leaderboard and the public state of
// the largest account on it.
const LEADERBOARD = readFileSync(new URL("./fixtures/leaderboard-head.txt", import.meta.url), "utf8");
const STATE = fixture("hl-state-whale") as any;
const EMPTY = fixture("hl-clearinghouse-empty");
const WHALE = "0x5b5d51203a0f9079f8aeb098a6523a13f298c060";

async function* whole(text: string) {
  yield text;
}

const level = (over: Partial<Level>): Level => ({
  account: "0xa",
  coin: "BTC",
  side: "long",
  szi: 1,
  valueUsd: 1_000_000,
  entryPx: 100_000,
  markPx: 100_000,
  liqPx: 90_000,
  leverage: 10,
  cross: true,
  ...over,
});

describe("levels of one account", () => {
  it("keeps every position at or over the minimum, with its side, mark and liquidation price", () => {
    const found = levelsOf(WHALE, STATE, 250_000);
    const large = STATE.assetPositions.filter((a: any) => Math.abs(Number(a.position.positionValue)) >= 250_000);
    expect(found.map((l) => l.coin)).toEqual(large.map((a: any) => a.position.coin));
    const btc = found.find((l) => l.coin === "BTC")!;
    const raw = STATE.assetPositions.find((a: any) => a.position.coin === "BTC").position;
    expect(btc.side).toBe("short");
    expect(btc.liqPx).toBe(Number(raw.liquidationPx));
    expect(btc.valueUsd).toBe(Number(raw.positionValue));
    expect(btc.markPx).toBeCloseTo(Number(raw.positionValue) / Math.abs(Number(raw.szi)), 6);
    expect(btc.leverage).toBe(5);
    expect(btc.cross).toBe(true);
  });

  it("stores a position without a liquidation price as a null level, and reads isolated margin", () => {
    const state = { assetPositions: [{ position: { coin: "ETH", szi: "10", positionValue: "400000", entryPx: "39000", liquidationPx: null, leverage: { type: "isolated", value: 3 } } }] };
    expect(levelsOf("0xb", state)).toEqual([level({ account: "0xb", coin: "ETH", szi: 10, valueUsd: 400_000, entryPx: 39_000, markPx: 40_000, liqPx: null, leverage: 3, cross: false })]);
  });

  it("returns nothing for an account with no positions or a reply without them", () => {
    expect(levelsOf(WHALE, EMPTY)).toEqual([]);
    expect(levelsOf(WHALE, undefined)).toEqual([]);
  });
});

describe("stops of one account", () => {
  const orders = [
    { coin: "BTC", side: "A", isTrigger: true, orderType: "Stop Market", triggerPx: "95000", origSz: "0.5", sz: "0.5", oid: 11 },
    { coin: "BTC", side: "A", isTrigger: true, orderType: "Take Profit Market", triggerPx: "120000", origSz: "0.5", oid: 12 },
    { coin: "BTC", side: "B", isTrigger: true, orderType: "Stop Market", triggerPx: "101000", origSz: "1", oid: 13 },
    { coin: "BTC", side: "A", isTrigger: false, orderType: "Limit", triggerPx: "0.0", origSz: "1", oid: 14 },
    { coin: "DOGE", side: "A", isTrigger: true, orderType: "Stop Market", triggerPx: "0.1", origSz: "1", oid: 15 },
  ];

  it("keeps only trigger orders that close a stored position, named stop or take-profit", () => {
    expect(stopsOf("0xa", orders, [level({})])).toEqual([
      { account: "0xa", coin: "BTC", side: "long", kind: "stop", triggerPx: 95_000, size: 0.5, oid: 11 },
      { account: "0xa", coin: "BTC", side: "long", kind: "take_profit", triggerPx: 120_000, size: 0.5, oid: 12 },
    ]);
  });

  it("reads the buy side as the closing side of a short", () => {
    expect(stopsOf("0xa", orders, [level({ side: "short" })]).map((s) => s.oid)).toEqual([13]);
  });

  it("ignores positions of other accounts", () => {
    expect(stopsOf("0xb", orders, [level({})])).toEqual([]);
  });
});

describe("which coins and accounts get the extra reads", () => {
  const levels = [
    level({ coin: "ZEC", valueUsd: 9e6 }),
    level({ coin: "xyz:NVDA", valueUsd: 8e6 }),
    level({ coin: "DOGE", valueUsd: 7e6 }),
    level({ account: "0xb", coin: "BTC", valueUsd: 5e6 }),
    level({ account: "0xc", coin: "LINK", valueUsd: 6e6 }),
  ];

  it("always reads candles for the base coins, then the coins with the most money, and no other market lists", () => {
    expect(candleCoins(levels, 6)).toEqual(["BTC", "ETH", "SOL", "HYPE", "ZEC", "DOGE"]);
  });

  it("ranks accounts by their largest position", () => {
    expect(biggestAccounts(levels, 2)).toEqual(["0xa", "0xc"]);
  });
});

describe("the pacer", () => {
  it("lets the first request through and spaces the next ones by their weight", async () => {
    let t = 0;
    const slept: number[] = [];
    const pacer = new Pacer(600, () => t, async (ms) => {
      slept.push(ms);
      t += ms;
    });
    await pacer.take(2);
    await pacer.take(20);
    await pacer.take(2);
    expect(slept).toEqual([200, 2000]);
  });
});

describe("a collector round", () => {
  const candle = (t: number, px: number) => ({ t, T: t + 59_999, s: "BTC", i: "1m", o: String(px), c: String(px + 1), h: String(px + 2), l: String(px - 2), v: "1", n: 1 });

  async function world() {
    const top = await topAccounts(whole(LEADERBOARD), 5);
    const board = top.includes(WHALE) ? LEADERBOARD : LEADERBOARD.replace(top[0], WHALE);
    const calls: any[] = [];
    let boards = 0;
    let failing = "";
    const hlFetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push(body);
      if (body.user && body.user === failing) return new Response("busy", { status: 429 });
      if (body.type === "clearinghouseState") return Response.json(body.user === WHALE ? STATE : EMPTY);
      if (body.type === "frontendOpenOrders")
        return Response.json([{ coin: "BTC", side: "B", isTrigger: true, orderType: "Stop Market", triggerPx: "140000", origSz: "5", oid: 77 }]);
      if (body.type === "candleSnapshot") return Response.json(body.req.coin === "BTC" ? [candle(body.req.endTime - 120_000, 100_000), candle(body.req.endTime - 60_000, 100_010)] : []);
      return Response.json({});
    }) as unknown as typeof fetch;
    let t = 10_000_000;
    let free = MIN_FREE_BYTES * 2;
    const db = openHuntDb(":memory:");
    const collector = new HuntCollector(db, new Hyperliquid("https://hl.test", hlFetch), {
      fetch: (async () => (boards++, new Response(board))) as typeof fetch,
      now: () => t,
      pacer: new Pacer(1e9, () => t, async () => {}),
      freeBytes: () => free,
      topAccounts: 5,
      scanPerRound: 2,
      accountsPerRound: 5,
    });
    return {
      db,
      collector,
      others: (await topAccounts(whole(board), 5)).filter((a) => a !== WHALE),
      calls,
      boards: () => boards,
      tick: (ms: number) => (t += ms),
      fail: (a: string) => (failing = a),
      disk: (b: number) => (free = b),
      count: (table: string) => (db.prepare(`SELECT count(*) AS c FROM ${table}`).get() as { c: number }).c,
    };
  }

  it("stores the large positions, the stops under them and the candles, and counts the round", async () => {
    const w = await world();
    const r = await w.collector.round();
    const large = levelsOf(WHALE, STATE);
    expect(r).toEqual({ ms: 10_000_000, accounts: 5, levels: large.length, stops: 1, errors: 0 });
    expect(w.count("levels")).toBe(large.length);
    const btc = w.db.prepare("SELECT side, liq_px, value_usd FROM levels WHERE coin = 'BTC'").get() as any;
    expect(btc).toEqual({ side: "short", liq_px: large.find((l) => l.coin === "BTC")!.liqPx, value_usd: large.find((l) => l.coin === "BTC")!.valueUsd });
    expect(w.db.prepare("SELECT account, coin, side, kind, trigger_px, size FROM stops").all()).toEqual([{ account: WHALE, coin: "BTC", side: "short", kind: "stop", trigger_px: 140_000, size: 5 }]);
    expect(w.count("candles")).toBe(2);
    expect(w.calls.filter((c) => c.type === "frontendOpenOrders").map((c) => c.user)).toEqual([WHALE]);
    expect(w.db.prepare("SELECT accounts, levels, stops, errors FROM rounds").all()).toEqual([{ accounts: 5, levels: large.length, stops: 1, errors: 0 }]);
  });

  it("reads the leaderboard once a day, keeps reading accounts that hold a position, and takes the rest in turn", async () => {
    const w = await world();
    await w.collector.round();
    w.calls.length = 0;
    w.tick(300_000);
    const r = await w.collector.round();
    expect(w.boards()).toBe(1);
    const read = w.calls.filter((c) => c.type === "clearinghouseState").map((c) => c.user);
    expect(read).toContain(WHALE);
    // the whale plus a slice of at least two others
    expect(r.accounts).toBeGreaterThanOrEqual(3);
    expect(new Set(read).size).toBe(read.length);
    // the newest stored candle is asked for again, not the whole hour
    const btc = w.calls.find((c) => c.type === "candleSnapshot" && c.req.coin === "BTC");
    expect(btc.req.startTime).toBe(10_000_000 - 60_000);
    expect(w.count("candles")).toBe(4);
  });

  it("counts an account that fails to answer and still stores the rest", async () => {
    const w = await world();
    w.fail(w.others[0]);
    const r = await w.collector.round();
    expect(r.errors).toBe(1);
    expect(r.levels).toBe(levelsOf(WHALE, STATE).length);
  });

  it("moves the stop reads through every holder in turn", async () => {
    const holders = ["0x01", "0x02", "0x03"];
    const asked: string[] = [];
    const hlFetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.type === "clearinghouseState") {
        const i = holders.indexOf(body.user);
        return Response.json(i < 0 ? EMPTY : { assetPositions: [{ position: { coin: "BTC", szi: "1", positionValue: String(9e6 - i * 1e6), entryPx: "100000", liquidationPx: "90000", leverage: { type: "cross", value: 5 } } }] });
      }
      if (body.type === "frontendOpenOrders") asked.push(body.user);
      return Response.json([]);
    }) as unknown as typeof fetch;
    let t = 5_000_000;
    const board = holders.map((a, i) => `"ethAddress": "${a.padEnd(42, "0")}", "accountValue": "${100 - i}"`).join("\n");
    const padded = holders.map((a) => a.padEnd(42, "0"));
    holders.splice(0, 3, ...padded);
    const collector = new HuntCollector(openHuntDb(":memory:"), new Hyperliquid("https://hl.test", hlFetch), {
      fetch: (async () => new Response(board)) as typeof fetch,
      now: () => t,
      pacer: new Pacer(1e9, () => t, async () => {}),
      stopAccounts: 2,
    });
    await collector.round();
    t += 300_000;
    await collector.round();
    expect(asked).toEqual([padded[0], padded[1], padded[2], padded[0]]);
  });

  it("skips the round when the disk is nearly full", async () => {
    const w = await world();
    w.disk(MIN_FREE_BYTES - 1);
    expect(await w.collector.round()).toEqual({ ms: 10_000_000, accounts: 0, levels: 0, stops: 0, errors: 0, skipped: "disk_full" });
    expect(w.calls).toHaveLength(0);
    expect(w.count("rounds")).toBe(0);
  });
});
