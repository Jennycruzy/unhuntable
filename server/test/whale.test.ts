import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Hyperliquid } from "../src/hl.js";
import { buildServer } from "../src/index.js";
import { WhaleWatch, largest, nearestStop, topAccounts } from "../src/whale.js";
import { fixture, memoryDb, testConfig } from "./helpers.js";

// Stored real replies: the head of Hyperliquid's public leaderboard (pretty-printed as served),
// and the public state and open orders of the largest account on it.
const LEADERBOARD = readFileSync(new URL("./fixtures/leaderboard-head.txt", import.meta.url), "utf8");
const STATE = fixture("hl-state-whale") as any;
const ORDERS = fixture("hl-open-orders-whale") as any[];
const WHALE = "0x5b5d51203a0f9079f8aeb098a6523a13f298c060";

async function* pieces(text: string, size: number) {
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size);
}

describe("top accounts from the leaderboard stream", () => {
  it("finds every row in the served format, largest first, the same however the stream is cut", async () => {
    const whole = await topAccounts(pieces(LEADERBOARD, LEADERBOARD.length), 1000);
    const rows = [...LEADERBOARD.matchAll(/"ethAddress": "(0x[0-9a-f]{40})",\s*"accountValue": "([0-9.]+)"/g)];
    expect(rows.length).toBeGreaterThan(5);
    expect(whole).toHaveLength(new Set(rows.map((r) => r[1])).size);
    const richest = rows.reduce((a, b) => (Number(b[2]) > Number(a[2]) ? b : a));
    expect(whole[0]).toBe(richest[1]);
    for (const size of [37, 199, 4096]) expect(await topAccounts(pieces(LEADERBOARD, size), 1000)).toEqual(whole);
  });

  it("keeps only the top n", async () => {
    expect(await topAccounts(pieces(LEADERBOARD, 500), 3)).toEqual((await topAccounts(pieces(LEADERBOARD, 500), 1000)).slice(0, 3));
  });
});

describe("the largest position", () => {
  it("picks the biggest position with a liquidation price on the right side of entry", () => {
    const w = largest([{ address: WHALE, state: STATE }])!;
    const sizes = STATE.assetPositions.map((a: any) => Math.abs(Number(a.position.positionValue)));
    expect(w.sizeUsd).toBe(Math.max(...sizes));
    expect(w.side).toBe(Number(STATE.assetPositions.find((a: any) => a.position.coin === w.coin).position.szi) > 0 ? "long" : "short");
    expect(w.side === "short" ? w.liqPx > w.entryPx : w.liqPx < w.entryPx).toBe(true);
  });

  it("skips a liquidation price on the wrong side of entry", () => {
    const broken = structuredClone(STATE);
    for (const a of broken.assetPositions) a.position.liquidationPx = String(Number(a.position.entryPx) / 2);
    const shortsOnly = broken.assetPositions.every((a: any) => Number(a.position.szi) < 0);
    if (shortsOnly) expect(largest([{ address: WHALE, state: broken }])).toBeUndefined();
  });

  it("is nothing when no account holds a position", () => {
    expect(largest([{ address: WHALE, state: fixture("hl-clearinghouse-empty") }])).toBeUndefined();
  });
});

describe("the nearest resting stop", () => {
  const stop = (coin: string, side: "A" | "B", px: string) => ({ ...ORDERS[0], coin, side, isTrigger: true, orderType: "Stop Market", triggerPx: px, reduceOnly: true });

  it("is none when the account rests only limit orders", () => {
    expect(nearestStop(ORDERS, "ETH", "short", 3400)).toBeNull();
  });

  it("is the closing stop nearest the price", () => {
    const orders = [...ORDERS, stop("ETH", "B", "3900"), stop("ETH", "B", "3600"), stop("ETH", "A", "3300"), stop("BTC", "B", "3500")];
    expect(nearestStop(orders, "ETH", "short", 3400)).toBe(3600);
    expect(nearestStop([...ORDERS, stop("ETH", "A", "3300"), stop("ETH", "A", "3100")], "ETH", "long", 3400)).toBe(3300);
  });
});

describe("the watcher and /api/whale", () => {
  it("reads the leaderboard once, the top accounts, prices and orders, and serves the result", async () => {
    let boards = 0;
    const hlFetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.type === "clearinghouseState") return Response.json(body.user === WHALE ? STATE : fixture("hl-clearinghouse-empty"));
      if (body.type === "frontendOpenOrders") return Response.json(ORDERS);
      if (body.type === "allMids") return Response.json({ ETH: "3400.5", BTC: "101000", SOL: "160" });
      return Response.json({});
    }) as unknown as typeof fetch;
    const top = await topAccounts(pieces(LEADERBOARD, 4096), 60);
    const board = top.includes(WHALE) ? LEADERBOARD : LEADERBOARD.replace(top[0], WHALE);
    const w = new WhaleWatch(new Hyperliquid("https://hl.test", hlFetch), { fetch: (async () => (boards++, new Response(board))) as typeof fetch, now: () => 1000 });

    const app = buildServer({ config: testConfig(), db: memoryDb(), whale: w });
    expect((await app.inject({ method: "GET", url: "/api/whale" })).json()).toEqual({ whale: null });

    const got = (await w.refresh())!;
    await w.refresh();
    expect(boards).toBe(1);
    expect(got.address).toBe(WHALE);
    expect(got.stopPx).toBeNull();
    expect(got.asOfMs).toBe(1000);
    const res = await app.inject({ method: "GET", url: "/api/whale" });
    expect(res.statusCode).toBe(200);
    expect(res.json().whale).toMatchObject({ address: WHALE, coin: got.coin, side: got.side, liqPx: got.liqPx });
  });
});
