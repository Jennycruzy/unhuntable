import { USDC_NEAR } from "unhuntable-client";
import { describe, expect, it } from "vitest";
import { DAY_MS, settleResult } from "../src/followers.js";
import { buildServer } from "../src/index.js";
import { walletAccount } from "../src/policy.js";
import { traderTag } from "../src/tags.js";
import { testConfig } from "./helpers.js";
import { addUser, addWallet, harness, runFor, type Harness } from "./world.js";

function setup() {
  const h = harness();
  const alice = addUser(h, "alice.near");
  const bob = addUser(h, "bob.near");
  const aliceBal = addWallet(h, alice.userId, "balance", "none");
  const bobBal = addWallet(h, bob.userId, "balance", "none");
  const app = buildServer({ config: testConfig(), db: h.db, now: h.ctx.now, money: h.ctx });
  const as = (who: { cookie: string }) => ({
    get: (url: string) => app.inject({ method: "GET", url, headers: { cookie: who.cookie } }),
    post: (url: string, payload: object = {}) => app.inject({ method: "POST", url, headers: { cookie: who.cookie }, payload }),
  });
  return { h, app, alice, bob, aliceBal, bobBal, A: as(alice), B: as(bob) };
}

type S = ReturnType<typeof setup>;

const TRADER = { handle: "alice_trades", copyUsdDay: 0.5, viewUsdDay: 0.1, open: true };

async function trader(s: S) {
  const r = await s.A.post("/api/trader", TRADER);
  expect(r.statusCode, r.body).toBe(200);
}

/** Bob buys a key: the wallet signs the lock that lists alice's private balance, then the key is on. */
async function buyKey(s: S, body: object) {
  const f = await s.B.post("/api/follow", { handle: TRADER.handle, ...body });
  expect(f.statusCode, f.body).toBe(200);
  s.h.world.policyOwner = "bob.near";
  const c = await s.B.post(`/api/follow/${f.json().keyId}/confirm`);
  expect(c.statusCode, c.body).toBe(200);
  return { keyId: f.json().keyId as string, batch: f.json().policyBatch };
}

/** An open position of alice's, as the position job leaves it. */
function leaderOpen(s: S, coin = "ETH") {
  const id = "00000000-0000-4000-8000-00000000a001";
  s.h.db
    .prepare(
      `INSERT INTO positions (id, user_id, coin, side, notional_usd, leverage, hiding, state, plan_json, vrf_hex, created_ms, network)
       VALUES (?, ?, ?, 'long', 300, 3, 'whale', 'open', '{}', 'aa', ?, 'mainnet')`,
    )
    .run(id, s.alice.userId, coin, s.h.clock.t);
  return id;
}

describe("traders", () => {
  it("a trader card shows prices, counts and closed results, and no address, position or level", async () => {
    const s = setup();
    await trader(s);
    const r = await s.app.inject({ method: "GET", url: `/api/traders/${TRADER.handle}` });
    expect(r.statusCode).toBe(200);
    const t = r.json().trader;
    expect(t).toMatchObject({ handle: "alice_trades", copyUsdDay: 0.5, viewUsdDay: 0.1, open: true, copiers: 0, viewers: 0, closedTrades: 0, record: null });
    expect(t.tag).toBe(traderTag(s.alice.userId));
    expect(JSON.stringify(r.json())).not.toMatch(/0x[0-9a-f]{40}|stop|liq|wallet/i);
    expect((await s.app.inject({ method: "GET", url: "/api/traders" })).json().traders.map((x: { handle: string }) => x.handle)).toEqual(["alice_trades"]);
  });

  it("a name is one trader's only", async () => {
    const s = setup();
    await trader(s);
    const r = await s.B.post("/api/trader", TRADER);
    expect(r.json().error).toBe("handle_taken");
  });

  it("the guard's signed record is stored and read at most every ten minutes", async () => {
    const s = setup();
    await trader(s);
    const r = await s.A.post(`/api/traders/${TRADER.handle}/record`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().trader.record).toMatchObject({ trader: traderTag(s.alice.userId), shards: 2, pnlUsd: 0.42 });
    await s.A.post(`/api/traders/${TRADER.handle}/record`);
    const calls = s.h.world.calls.filter((c) => c.inner?.op === "record");
    expect(calls).toHaveLength(1);
    expect(calls[0].inner.trader).toBe(traderTag(s.alice.userId));
  });
});

describe("buying a key", () => {
  it("the wallet approves paying this trader: the balance lock lists the trader's private balance", async () => {
    const s = setup();
    await trader(s);
    const { batch } = await buyKey(s, { kind: "view" });
    expect(batch.transactions).toHaveLength(1);
    expect(batch.summary[0]).toContain("@alice_trades");
    const enc = s.h.world.calls.filter((c) => c.path === "/wallet/v1/encrypt-policy").at(-1)!;
    expect(enc.body.rules.addresses.list).toContain(walletAccount(s.aliceBal.pubkey));
    const bal = s.h.db.prepare("SELECT policy_state FROM pieces WHERE id = ?").get(s.bobBal.id) as { policy_state: string };
    expect(bal.policy_state).toBe("locked");
  });

  it("pays the first day by private transfer to the trader's private balance, then the next day", async () => {
    const s = setup();
    await trader(s);
    const { keyId } = await buyKey(s, { kind: "view" });
    await runFor(s.h, 60_000);
    expect(s.h.world.transfers).toHaveLength(1);
    expect(s.h.world.transfers[0].walletId).toBe(s.bobBal.walletId);
    expect(s.h.world.transfers[0].body).toEqual({ to: walletAccount(s.aliceBal.pubkey), amount: "100000", token: USDC_NEAR });
    const k = (await s.B.get("/api/follow")).json().keys[0];
    expect(k).toMatchObject({ id: keyId, kind: "view", state: "active", on: true, paidUsd: "0.10" });
    expect(k.paidThroughMs).toBeGreaterThan(s.h.clock.t + DAY_MS - 120_000);
    const alerts = (await s.A.get("/api/alerts")).json().alerts.map((a: { text: string }) => a.text);
    expect(alerts.some((t: string) => /paid you \$0\.10/.test(t))).toBe(true);
    // the trader is never told who paid
    expect(alerts.join(" ")).not.toContain("bob");
    await runFor(s.h, DAY_MS, 600_000);
    expect(s.h.world.transfers).toHaveLength(2);
  });

  it("a refused payment pauses the key and says so; switching it back on pays again", async () => {
    const s = setup();
    await trader(s);
    s.h.world.transferRefusal = { error: "insufficient_balance", message: "Insufficient balance" };
    const { keyId } = await buyKey(s, { kind: "view" });
    await runFor(s.h, 60_000);
    let k = (await s.B.get("/api/follow")).json().keys[0];
    expect(k).toMatchObject({ state: "paused", pauseReason: "payment_refused", on: false });
    s.h.world.transferRefusal = undefined;
    expect((await s.B.post(`/api/follow/${keyId}/resume`)).statusCode).toBe(200);
    await runFor(s.h, 60_000);
    k = (await s.B.get("/api/follow")).json().keys[0];
    expect(k).toMatchObject({ state: "active", on: true });
  });

  it("a stopped key pays nothing more", async () => {
    const s = setup();
    await trader(s);
    const { keyId } = await buyKey(s, { kind: "view" });
    await runFor(s.h, 60_000);
    await s.B.post(`/api/follow/${keyId}/stop`);
    await runFor(s.h, 2 * DAY_MS, 3_600_000);
    expect(s.h.world.transfers).toHaveLength(1);
  });

  it("refuses your own trading, a second key of the same kind, and an unknown trader", async () => {
    const s = setup();
    await trader(s);
    expect((await s.A.post("/api/follow", { handle: TRADER.handle, kind: "view" })).json().error).toBe("follow_self");
    await buyKey(s, { kind: "view" });
    expect((await s.B.post("/api/follow", { handle: TRADER.handle, kind: "view" })).json().error).toBe("key_exists");
    expect((await s.B.post("/api/follow", { handle: "nobody_here", kind: "view" })).json().error).toBe("trader_not_found");
    expect((await s.B.post("/api/follow", { handle: TRADER.handle, kind: "copy" })).statusCode).toBe(400);
  });
});

describe("closed trades", () => {
  it("only key holders see them, and only closed ones", async () => {
    const s = setup();
    await trader(s);
    const open = leaderOpen(s);
    s.h.db
      .prepare(
        `INSERT INTO positions (id, user_id, coin, side, notional_usd, leverage, hiding, state, plan_json, vrf_hex, created_ms, network, result_json)
         VALUES ('00000000-0000-4000-8000-00000000a002', ?, 'BTC', 'short', 101, 5, 'whale', 'closed', '{}', 'bb', ?, 'mainnet', ?)`,
      )
      .run(s.alice.userId, s.h.clock.t - 3_600_000, JSON.stringify({ pnlUsd: 1.25, feesUsd: 0.1, entryPx: 70000, exitPx: 69100, closedMs: s.h.clock.t }));
    expect((await s.B.get(`/api/traders/${TRADER.handle}/trades`)).json().error).toBe("key_needed");
    await buyKey(s, { kind: "view" });
    await runFor(s.h, 60_000);
    const r = (await s.B.get(`/api/traders/${TRADER.handle}/trades`)).json();
    expect(r.trades).toEqual([
      { coin: "BTC", side: "short", notionalUsd: 101, leverage: 5, openedMs: s.h.clock.t - 3_600_000 - 60_000, closedMs: expect.any(Number), entryPx: 70000, exitPx: 69100, pnlUsd: "1.25", feesUsd: "0.10" },
    ]);
    expect(JSON.stringify(r)).not.toContain(open);
    const card = (await s.app.inject({ method: "GET", url: `/api/traders/${TRADER.handle}` })).json().trader;
    expect(card).toMatchObject({ closedTrades: 1, wins: 1, resultUsd: "1.25", viewers: 1 });
  });
});

describe("copies", () => {
  async function copier(s: S) {
    await trader(s);
    addWallet(s.h, s.bob.userId, "piece:0", "locked");
    return buyKey(s, { kind: "copy", copyUsd: 15 });
  }

  it("a trader's crypto position, once open, is copied into the follower's own ready piece after a random delay", async () => {
    const s = setup();
    const { keyId } = await copier(s);
    await runFor(s.h, 60_000);
    const lead = leaderOpen(s);
    s.h.ctx.jobs.enqueue("position_event", { positionId: lead, event: "open" }, `pe:${lead}`, s.h.clock.t);
    await runFor(s.h, 20_000);
    expect(s.h.db.prepare("SELECT COUNT(*) AS n FROM positions WHERE copy_of = ?").get(lead)).toEqual({ n: 0 });
    await runFor(s.h, 5 * 60_000);
    const copy = s.h.db.prepare("SELECT user_id, coin, side, notional_usd, leverage, hiding, copy_of FROM positions WHERE copy_of = ?").get(lead);
    expect(copy).toEqual({ user_id: s.bob.userId, coin: "ETH", side: "long", notional_usd: 15, leverage: 3, hiding: "normal", copy_of: lead });
    const k = (await s.B.get("/api/follow")).json().keys.find((x: { id: string }) => x.id === keyId);
    expect(k.copies[0].state).toBe("opened");
  });

  it("closes the copy when the trader closes", async () => {
    const s = setup();
    await copier(s);
    await runFor(s.h, 60_000);
    const lead = leaderOpen(s);
    s.h.ctx.jobs.enqueue("position_event", { positionId: lead, event: "open" }, `pe:${lead}`, s.h.clock.t);
    await runFor(s.h, 30 * 60_000);
    const copyId = (s.h.db.prepare("SELECT id FROM positions WHERE copy_of = ?").get(lead) as { id: string }).id;
    expect((s.h.db.prepare("SELECT state FROM positions WHERE id = ?").get(copyId) as { state: string }).state).toBe("open");
    s.h.db.prepare("UPDATE positions SET state = 'closing' WHERE id = ?").run(lead);
    s.h.ctx.jobs.enqueue("position_event", { positionId: lead, event: "closing" }, `pc:${lead}`, s.h.clock.t);
    await runFor(s.h, 10_000);
    expect(["closing", "closed"]).toContain((s.h.db.prepare("SELECT state FROM positions WHERE id = ?").get(copyId) as { state: string }).state);
  });

  it("does not copy stocks, and does not copy when the key is off", async () => {
    const s = setup();
    const { keyId } = await copier(s);
    await runFor(s.h, 60_000);
    const stock = leaderOpen(s, "xyz:NVDA");
    s.h.ctx.jobs.enqueue("position_event", { positionId: stock, event: "open" }, `pe:${stock}`, s.h.clock.t);
    await runFor(s.h, 10 * 60_000);
    expect(s.h.db.prepare("SELECT COUNT(*) AS n FROM copies").get()).toEqual({ n: 0 });
    await s.B.post(`/api/follow/${keyId}/stop`);
    s.h.db.prepare("UPDATE positions SET coin = 'ETH' WHERE id = ?").run(stock);
    s.h.ctx.jobs.enqueue("position_event", { positionId: stock, event: "open" }, `pe2:${stock}`, s.h.clock.t);
    await runFor(s.h, 10 * 60_000);
    expect(s.h.db.prepare("SELECT COUNT(*) AS n FROM copies").get()).toEqual({ n: 0 });
  });

  it("without ready pieces the copy waits for the follower's approval in the app", async () => {
    const s = setup();
    await trader(s);
    await buyKey(s, { kind: "copy", copyUsd: 30 });
    await runFor(s.h, 60_000);
    const lead = leaderOpen(s);
    s.h.ctx.jobs.enqueue("position_event", { positionId: lead, event: "open" }, `pe:${lead}`, s.h.clock.t);
    await runFor(s.h, 6 * 60_000);
    const copy = s.h.db.prepare("SELECT state, hiding, notional_usd FROM positions WHERE copy_of = ?").get(lead);
    expect(copy).toEqual({ state: "planned", hiding: "whale", notional_usd: 30 });
    expect(s.h.db.prepare("SELECT state FROM copies").get()).toEqual({ state: "needs_app" });
    const alerts = (await s.B.get("/api/alerts")).json().alerts.map((a: { text: string }) => a.text);
    expect(alerts.some((t: string) => /start your copy/.test(t))).toBe(true);
  });
});

describe("results and the guard tag", () => {
  it("a closed position's result is read from Hyperliquid's fills", async () => {
    const s = setup();
    const piece = addWallet(s.h, s.alice.userId, "piece:0", "locked");
    const id = "00000000-0000-4000-8000-00000000a009";
    s.h.db
      .prepare(
        `INSERT INTO positions (id, user_id, coin, side, notional_usd, leverage, hiding, state, plan_json, vrf_hex, created_ms, network)
         VALUES (?, ?, 'ETH', 'long', 30, 3, 'normal', 'closed', '{}', 'aa', ?, 'mainnet')`,
      )
      .run(id, s.alice.userId, s.h.clock.t);
    s.h.db
      .prepare("INSERT INTO position_pieces (id, position_id, piece_id, idx, size, funding_usd, entry_offset_ms, reused, state, created_ms, network) VALUES ('pp1', ?, ?, 0, 0.01, 12, 0, 0, 'closed', ?, 'mainnet')")
      .run(id, piece.id, s.h.clock.t);
    s.h.world.fills.set(piece.address.toLowerCase(), [
      { coin: "ETH", px: "3000", sz: "0.01", side: "B", closedPnl: "0", fee: "0.0135", time: s.h.clock.t + 1000, dir: "Open Long" },
      { coin: "ETH", px: "3100", sz: "0.01", side: "A", closedPnl: "1.0", fee: "0.0139", time: s.h.clock.t + 9000, dir: "Close Long" },
      { coin: "BTC", px: "1", sz: "1", side: "A", closedPnl: "99", fee: "0", time: s.h.clock.t + 9000, dir: "Close Long" },
    ]);
    await settleResult(s.h.ctx, id);
    const r = JSON.parse((s.h.db.prepare("SELECT result_json FROM positions WHERE id = ?").get(id) as { result_json: string }).result_json);
    expect(r).toEqual({ pnlUsd: expect.closeTo(0.9726, 6), feesUsd: expect.closeTo(0.0274, 6), entryPx: 3000, exitPx: 3100, closedMs: s.h.clock.t + 9000 });
  });
});

describe("agents and followers", () => {
  it("an agent asks for a key; it waits for the owner's approval in the app, then the agent reads closed trades", async () => {
    const s = setup();
    await trader(s);
    const made = (await s.B.post("/api/agents", { name: "scout", maxNotionalUsd: 50, coins: ["ETH"], dailyOpens: 2 })).json();
    const agent = (method: "GET" | "POST", url: string, payload?: object) =>
      s.app.inject({ method, url, headers: { authorization: `Bearer ${made.key}` }, ...(payload ? { payload } : {}) });
    expect((await agent("POST", "/api/agent/follow", { handle: TRADER.handle, kind: "copy", copyUsd: 80 })).json().error).toBe("agent_limit");
    const asked = await agent("POST", "/api/agent/follow", { handle: TRADER.handle, kind: "view" });
    expect(asked.statusCode, asked.body).toBe(200);
    expect(asked.json()).toMatchObject({ state: "pending" });
    // nothing is paid and nothing shows until the owner approves
    await runFor(s.h, 60_000);
    expect(s.h.world.transfers).toHaveLength(0);
    expect((await agent("GET", `/api/agent/traders/${TRADER.handle}/trades`)).json().error).toBe("key_needed");
    const alerts = (await s.B.get("/api/alerts")).json().alerts.map((a: { text: string }) => a.text);
    expect(alerts.some((t: string) => /agent scout asked for a viewing key to @alice_trades/.test(t))).toBe(true);
    // the owner approves it in the app
    const keyId = asked.json().keyId;
    const b = await s.B.post(`/api/follow/${keyId}/batch`);
    expect(b.statusCode, b.body).toBe(200);
    expect(b.json().policyBatch.transactions).toHaveLength(1);
    s.h.world.policyOwner = "bob.near";
    expect((await s.B.post(`/api/follow/${keyId}/confirm`)).statusCode).toBe(200);
    await runFor(s.h, 60_000);
    const r = await agent("GET", `/api/agent/traders/${TRADER.handle}/trades`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ handle: TRADER.handle, trades: [] });
  });
});
