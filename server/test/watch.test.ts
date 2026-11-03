import { boxSeal, CALL_AAD } from "unhuntable-client";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/index.js";
import { HEARTBEAT_MS, heartbeat, tickCoin, watchMids } from "../src/watch.js";
import { testConfig } from "./helpers.js";
import { addUser, addWallet, BOX_PUB, harness, reply, runFor, type Harness } from "./world.js";

interface S {
  h: Harness;
  userId: string;
  cookie: string;
  balWallet: string;
  pieces: { id: string; walletId: string; address: string; shard: string }[];
  positionId: string;
}

/** An open ETH position of n pieces, each with a band of 2400-2600. */
function openSetup(n = 2, settings: { auto?: boolean; cap?: number } = {}): S {
  const h = harness();
  const alice = addUser(h);
  const bal = addWallet(h, alice.userId, "balance", "locked");
  const positionId = "00000000-0000-4000-8000-0000000000f1";
  const planJson = { pieces: Array.from({ length: n }, () => ({ reserveUsd: 3.9, fundingUsd: 15 })) };
  h.db
    .prepare("INSERT INTO positions (id, user_id, coin, side, notional_usd, leverage, hiding, state, plan_json, vrf_hex, created_ms, network) VALUES (?, ?, 'ETH', 'long', 30, 3, 'whale', 'open', ?, ?, 1, 'mainnet')")
    .run(positionId, alice.userId, JSON.stringify(planJson), "ab".repeat(32));
  const pieces = Array.from({ length: n }, (_, i) => {
    const p = addWallet(h, alice.userId, `piece:${i}`, "locked");
    const shard = (h.db.prepare("SELECT shard_id FROM pieces WHERE id = ?").get(p.id) as { shard_id: string }).shard_id;
    h.db
      .prepare(
        `INSERT INTO position_pieces (id, position_id, piece_id, idx, size, funding_usd, entry_offset_ms, state, band_lo, band_hi, last_tick_ms, created_ms, network)
         VALUES (?, ?, ?, ?, 0.006, 15, 0, 'open', 2400, 2600, ?, 1, 'mainnet')`,
      )
      .run(`pp${i}`, positionId, p.id, i, h.clock.t);
    return { ...p, shard };
  });
  if (settings.auto !== undefined) {
    h.db
      .prepare("INSERT INTO settings (user_id, auto_refill, refill_cap_usd_per_day, created_ms, network) VALUES (?, ?, ?, 1, 'mainnet')")
      .run(alice.userId, settings.auto ? 1 : 0, settings.cap ?? 100);
  }
  return { h, userId: alice.userId, cookie: alice.cookie, balWallet: bal.walletId, pieces, positionId };
}

function tickAnswer(s: S, defence: Record<string, unknown> | null, which = 0) {
  const t = reply("guard-tick-coin");
  const shards: Record<string, unknown> = {};
  s.pieces.forEach((p, i) => {
    shards[p.shard] = { done: "watch", band: [2450, 2550], has_stop: true, has_tp: i === 0, defence: i === which ? defence : { action: "none", rung: 0, distance: 0.3 }, order: null };
  });
  t.output.shards = shards;
  return t;
}

const ticks = (s: S) => s.h.world.calls.filter((c) => c.inner?.op === "tick_coin");
const alerts = (s: S) => (s.h.db.prepare("SELECT text FROM alerts ORDER BY created_ms, rowid").all() as { text: string }[]).map((r) => r.text);

describe("heartbeat", () => {
  it("ticks every open piece of a coin in one call every 120 s", async () => {
    const s = openSetup(2);
    expect(await heartbeat(s.h.ctx)).toEqual([]);
    s.h.clock.t += HEARTBEAT_MS - 1;
    expect(await heartbeat(s.h.ctx)).toEqual([]);
    s.h.clock.t += 1;
    expect(await heartbeat(s.h.ctx)).toEqual(["ETH"]);
    expect(ticks(s)).toHaveLength(1);
    expect(ticks(s)[0].inner.shards).toEqual(s.pieces.map((p) => p.shard));
    s.h.clock.t += 60_000;
    await heartbeat(s.h.ctx);
    expect(ticks(s)).toHaveLength(1);
    s.h.clock.t += 60_000;
    await heartbeat(s.h.ctx);
    expect(ticks(s)).toHaveLength(2);
    // the answer's band and flags are stored; never a level
    const row = s.h.db.prepare("SELECT band_lo, band_hi, has_stop FROM position_pieces WHERE id = 'pp0'").get();
    expect(row).toEqual({ band_lo: 2400, band_hi: 2600, has_stop: 0 });
  });

  it("band exit triggers a tick at once", async () => {
    const s = openSetup(2);
    s.h.world.mids.ETH = "2500";
    expect(await watchMids(s.h.ctx)).toEqual([]);
    expect(ticks(s)).toHaveLength(0);
    s.h.world.mids.ETH = "2650.5";
    expect(await watchMids(s.h.ctx)).toEqual(["ETH"]);
    expect(ticks(s)).toHaveLength(1);
    s.h.world.guardTick = tickAnswer(s, null);
    s.h.world.mids.ETH = "2390";
    await watchMids(s.h.ctx);
    expect(ticks(s)).toHaveLength(2);
    // the new band from the guard is used from now on
    expect(s.h.db.prepare("SELECT band_lo, band_hi, has_stop, has_tp FROM position_pieces WHERE id = 'pp0'").get()).toEqual({ band_lo: 2450, band_hi: 2550, has_stop: 1, has_tp: 1 });
    s.h.world.mids.ETH = "2500";
    await watchMids(s.h.ctx);
    expect(ticks(s)).toHaveLength(2);
  });
});

describe("defence and refills", () => {
  it("a cut writes a plain alert and queues one refill per cut", async () => {
    const s = openSetup(2, { auto: true, cap: 100 });
    s.h.world.guardTick = tickAnswer(s, { action: "cut", rung: 1, distance: 0.11, size: 0.0015 }, 1);
    await tickCoin(s.h.ctx, "ETH");
    expect(alerts(s)).toContain("ETH piece Account 2: cut 25% when liquidation was 11% away.");
    // the piece keeps the rest of its size
    expect(s.h.db.prepare("SELECT size FROM position_pieces WHERE id = 'pp1'").get()).toEqual({ size: 0.0045 });
    expect(s.h.db.prepare("SELECT piece_id, amount, status FROM refills").all()).toEqual([{ piece_id: s.pieces[1].id, amount: 12, status: "queued" }]);
    // while it is in flight a second cut does not queue another
    await tickCoin(s.h.ctx, "ETH");
    expect(s.h.db.prepare("SELECT COUNT(*) AS n FROM refills").get()).toEqual({ n: 1 });
    expect(alerts(s)).toContain("ETH piece Account 2: A refill is on its way (about 1–3 minutes).");
    await runFor(s.h, 5_000);
    expect(s.h.db.prepare("SELECT status FROM refills").get()).toEqual({ status: "sent" });
    // later, a new cut can refill again
    s.h.clock.t += 4 * 60_000;
    await tickCoin(s.h.ctx, "ETH");
    expect(s.h.db.prepare("SELECT COUNT(*) AS n FROM refills").get()).toEqual({ n: 2 });
  });

  it("refills only ever go from the private balance to the same piece", async () => {
    const s = openSetup(3, { auto: true, cap: 1000 });
    for (let i = 0; i < 3; i++) {
      s.h.world.guardTick = tickAnswer(s, { action: "cut", rung: 1, distance: 0.11, size: 0.0015 }, i);
      await tickCoin(s.h.ctx, "ETH");
    }
    await runFor(s.h, 5_000);
    const w = s.h.world.calls.filter((c) => c.path === "/wallet/v1/confidential/withdraw");
    expect(w).toHaveLength(3);
    for (const c of w) expect(c.walletId).toBe(s.balWallet);
    expect(w.map((c) => c.body.to).sort()).toEqual(s.pieces.map((p) => p.address).sort());
    const rows = s.h.db
      .prepare("SELECT r.piece_id, p.hl_address FROM refills r JOIN pieces p ON p.id = r.piece_id ORDER BY r.created_ms, r.rowid")
      .all() as { piece_id: string; hl_address: string }[];
    expect(rows.map((r) => r.hl_address)).toEqual(w.map((c) => c.body.to));
    expect(w.every((c) => c.body.chain === "hypercore" && c.body.amount === "12000000")).toBe(true);
  });

  it("the day's refill cap is respected", async () => {
    const s = openSetup(3, { auto: true, cap: 30 });
    for (let i = 0; i < 3; i++) {
      s.h.world.guardTick = tickAnswer(s, { action: "cut", rung: 1, distance: 0.11, size: 0.0015 }, i);
      await tickCoin(s.h.ctx, "ETH");
    }
    expect(s.h.db.prepare("SELECT COUNT(*) AS n, SUM(amount) AS t FROM refills").get()).toEqual({ n: 2, t: 24 });
    expect(alerts(s)).toContain("ETH piece Account 3: Today's refill limit is reached. Add funds or lower the position.");
  });

  it("no refill without auto_refill; a close is an alert", async () => {
    const s = openSetup(2, { auto: false });
    s.h.world.guardTick = tickAnswer(s, { action: "close", rung: 3, distance: 0.04, size: 0.006 }, 0);
    await tickCoin(s.h.ctx, "ETH");
    expect(s.h.db.prepare("SELECT COUNT(*) AS n FROM refills").get()).toEqual({ n: 0 });
    expect(alerts(s)).toContain("ETH piece Account 1: closed to keep it away from liquidation.");
    expect(s.h.db.prepare("SELECT state FROM position_pieces WHERE id = 'pp0'").get()).toEqual({ state: "closed" });
  });

  it("a fired stop closes the piece, and a position with every piece closed is closed", async () => {
    const s = openSetup(1);
    const t = tickAnswer(s, null);
    t.output.shards[s.pieces[0].shard].done = "fired";
    s.h.world.guardTick = t;
    await tickCoin(s.h.ctx, "ETH");
    expect(alerts(s)).toContain("ETH piece Account 1: the stop fired and the piece is closed.");
    expect(s.h.db.prepare("SELECT state FROM positions").get()).toEqual({ state: "closed" });
  });
});

describe("stop forwarder", () => {
  it("forwards each box unchanged with the shard outside", async () => {
    const s = openSetup(2);
    const app = buildServer({ config: testConfig(), db: s.h.db, now: s.h.ctx.now, money: s.h.ctx });
    const boxes = s.pieces.map((p) => ({
      shard: p.shard,
      box: boxSeal(BOX_PUB, Buffer.from(JSON.stringify({ op: "seal", shard: p.shard, stop: { coin: "ETH", side: "long", trigger: 2100.5, size: 0.006 }, salt: "00" })), CALL_AAD),
    }));
    const r = await app.inject({ method: "POST", url: `/api/positions/${s.positionId}/stop`, headers: { cookie: s.cookie }, payload: { boxes } });
    expect(r.json()).toEqual({ ok: true, sealed: 2 });
    const sent = s.h.world.calls.filter((c) => c.outer);
    expect(sent.map((c) => c.body)).toEqual(boxes.map((b) => ({ input: { box: b.box, shard: b.shard } })));
    const box = await app.inject({ method: "GET", url: "/api/guard/box-pub", headers: { cookie: s.cookie } });
    expect(box.json()).toEqual({ boxPub: BOX_PUB });
  });

  it("a box for a shard of another user's position is refused", async () => {
    const s = openSetup(1);
    const bob = addUser(s.h, "bob.near");
    const bobPiece = addWallet(s.h, bob.userId, "piece:0", "locked");
    const bobShard = (s.h.db.prepare("SELECT shard_id FROM pieces WHERE id = ?").get(bobPiece.id) as { shard_id: string }).shard_id;
    const app = buildServer({ config: testConfig(), db: s.h.db, now: s.h.ctx.now, money: s.h.ctx });
    const box = boxSeal(BOX_PUB, Buffer.from("{}"), CALL_AAD);
    // alice's position, bob's shard
    const r = await app.inject({ method: "POST", url: `/api/positions/${s.positionId}/stop`, headers: { cookie: s.cookie }, payload: { boxes: [{ shard: bobShard, box }] } });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe("shard_not_yours");
    // bob, alice's position
    const r2 = await app.inject({ method: "POST", url: `/api/positions/${s.positionId}/stop`, headers: { cookie: bob.cookie }, payload: { boxes: [{ shard: s.pieces[0].shard, box }] } });
    expect(r2.json().error).toBe("not_found");
    expect(s.h.world.calls.filter((c) => c.outer)).toHaveLength(0);
  });
});
