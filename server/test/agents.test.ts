import { describe, expect, it } from "vitest";
import { buildServer } from "../src/index.js";
import type { Paywall } from "../src/x402.js";
import { testConfig } from "./helpers.js";
import { addUser, addWallet, harness, runFor, type Harness } from "./world.js";

const ETH = { coin: "ETH", side: "long", notionalUsd: 30, leverage: 3, hiding: "normal" } as const;
const BOX = { epk: "11".repeat(32), nonce: "22".repeat(12), ct: "33".repeat(48) };

/** A paywall that takes any request carrying a PAYMENT-SIGNATURE header. No network. */
function fakePaywall() {
  const charged: string[] = [];
  const p: Paywall = {
    price: "0.002",
    payTo: "unhuntable.near",
    network: "near:mainnet",
    routes: [{ name: "near", price: "0.002" }],
    async charge(req) {
      const sig = req.headers["payment-signature"];
      if (sig === "bad") return { reply: { status: 402, headers: { "PAYMENT-REQUIRED": "challenge" }, body: { error: "invalid_signature" } } };
      if (!sig) return { reply: { status: 402, headers: { "PAYMENT-REQUIRED": "challenge" }, body: {} } };
      charged.push(req.url);
      return { paid: { tx: `paytx${charged.length}`, payer: "agent.near", price: "0.002" }, headers: { "PAYMENT-RESPONSE": "settled" } };
    },
  };
  return { p, charged };
}

interface S {
  h: Harness;
  app: ReturnType<typeof buildServer>;
  cookie: string;
  userId: string;
  charged: string[];
}

let nextWallet = 0xa0;

function setup(): S {
  const h = harness();
  const alice = addUser(h);
  addWallet(h, alice.userId, "balance", "none");
  const pay = fakePaywall();
  const app = buildServer({ config: testConfig(), db: h.db, now: h.ctx.now, money: h.ctx, paywall: pay.p });
  return { h, app, cookie: alice.cookie, userId: alice.userId, charged: pay.charged };
}

const owner = (s: S, method: "GET" | "POST", url: string, payload?: object) => s.app.inject({ method, url, headers: { cookie: s.cookie }, payload });
const agent = (s: S, key: string, method: "GET" | "POST", url: string, payload?: object, pay = true) =>
  s.app.inject({ method, url, headers: { authorization: `Bearer ${key}`, ...(pay ? { "payment-signature": "signed" } : {}) }, payload });

/** The owner opens and closes one position in the app, which leaves one ready piece. */
async function readyPiece(s: S) {
  const created = (await owner(s, "POST", "/api/positions", ETH)).json();
  for (const label of created.needWallets) {
    const { requestId } = (await owner(s, "POST", "/api/wallets/key", { label })).json();
    const n = nextWallet++;
    const walletId = `00000000-0000-4000-8000-000000000${n.toString(16).padStart(3, "0")}`;
    s.h.world.addWallet(walletId, n);
    s.h.world.noPolicy.add(walletId);
    await s.h.keystore.withRequestKey(requestId, async (k) => s.h.world.addKey(k, walletId));
    expect((await owner(s, "POST", "/api/wallets/confirm", { requestId, label, seed: "unh-" + label })).statusCode).toBe(200);
  }
  await owner(s, "POST", `/api/positions/${created.positionId}/continue`);
  await runFor(s.h, 1_300_000);
  if ((s.h.db.prepare("SELECT state FROM positions WHERE id = ?").get(created.positionId) as any).state === "policy_wait") {
    for (const id of s.h.world.noPolicy) s.h.world.noPolicy.delete(id);
    expect((await owner(s, "POST", "/api/policy/confirm", { positionId: created.positionId, txHashes: ["t"] })).statusCode).toBe(200);
  }
  await runFor(s.h, 1_300_000);
  await owner(s, "POST", `/api/positions/${created.positionId}/close`, { now: true });
  await runFor(s.h, 100_000, 1_000);
  expect((s.h.db.prepare("SELECT state FROM positions WHERE id = ?").get(created.positionId) as any).state).toBe("closed");
}

async function newKey(s: S, over: object = {}) {
  const r = await owner(s, "POST", "/api/agents", { name: "my bot", maxNotionalUsd: 100, coins: ["ETH", "BTC"], dailyOpens: 3, ...over });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as { id: string; key: string };
}

describe("agent keys", () => {
  it("are made by the signed-in owner, shown once, stored only as a hash, and can be revoked", async () => {
    const s = setup();
    const { id, key } = await newKey(s);
    expect(key).toMatch(/^uak_[0-9a-f]{64}$/);
    const row = s.h.db.prepare("SELECT * FROM agent_keys").get() as any;
    expect(JSON.stringify(row)).not.toContain(key.slice(4));
    const list = (await owner(s, "GET", "/api/agents")).json();
    expect(list.keys).toHaveLength(1);
    expect(list.keys[0]).toMatchObject({ id, name: "my bot", maxNotionalUsd: 100, coins: ["ETH", "BTC"], dailyOpens: 3, revoked: false, calls: 0 });
    expect(JSON.stringify(list)).not.toContain(key);
    expect(list).toMatchObject({ price: "0.002", payTo: "unhuntable.near", network: "near:mainnet" });
    expect((await owner(s, "POST", `/api/agents/${id}/revoke`)).statusCode).toBe(200);
    expect((await agent(s, key, "GET", "/api/agent/positions")).json().error).toBe("agent_key_refused");
  });

  it("need a session to make, and refuse bad limits", async () => {
    const s = setup();
    expect((await s.app.inject({ method: "POST", url: "/api/agents", payload: { name: "x", maxNotionalUsd: 10, coins: ["ETH"], dailyOpens: 1 } })).statusCode).toBe(401);
    for (const bad of [{ coins: ["xyz:NVDA"] }, { coins: [] }, { maxNotionalUsd: 0 }, { maxNotionalUsd: 9000 }, { dailyOpens: 0 }, { name: "" }]) {
      expect((await owner(s, "POST", "/api/agents", { name: "b", maxNotionalUsd: 10, coins: ["ETH"], dailyOpens: 1, ...bad })).statusCode).toBe(400);
    }
  });
});

describe("agent calls", () => {
  it("without a key, or with an unknown one, are refused before any payment", async () => {
    const s = setup();
    expect((await s.app.inject({ method: "GET", url: "/api/agent/positions" })).json().error).toBe("agent_key_missing");
    expect((await agent(s, "uak_" + "0".repeat(64), "GET", "/api/agent/positions")).json().error).toBe("agent_key_refused");
    expect(s.charged).toEqual([]);
  });

  it("unpaid, answer 402 with the x402 challenge and do nothing", async () => {
    const s = setup();
    const { key } = await newKey(s);
    const r = await agent(s, key, "GET", "/api/agent/positions", undefined, false);
    expect(r.statusCode).toBe(402);
    expect(r.headers["payment-required"]).toBe("challenge");
    expect(r.json()).toMatchObject({ error: "payment_required", message: "This call costs 0.002 USDC on NEAR, paid with x402. Pay and send it again." });
    const bad = await agent(s, key, "GET", "/api/agent/positions", undefined, false);
    expect(bad.statusCode).toBe(402);
    const failed = await s.app.inject({ method: "GET", url: "/api/agent/positions", headers: { authorization: `Bearer ${key}`, "payment-signature": "bad" } });
    expect(failed.json().error).toBe("payment_failed");
    expect(s.h.db.prepare("SELECT COUNT(*) AS n FROM agent_calls").get()).toEqual({ n: 0 });
  });

  it("outside the key's limits are refused before payment: coin, size, stocks, and no ready piece", async () => {
    const s = setup();
    const { key } = await newKey(s, { coins: ["ETH"], maxNotionalUsd: 50 });
    const open = (b: object) => agent(s, key, "POST", "/api/agent/positions", { ...ETH, ...b });
    expect((await open({ coin: "BTC" })).json()).toMatchObject({ error: "agent_limit", message: "This agent key does not allow that: it trades only ETH." });
    expect((await open({ notionalUsd: 60 })).json()).toMatchObject({ error: "agent_limit", message: "This agent key does not allow that: its largest size is $50." });
    expect((await open({ coin: "xyz:NVDA" })).json().error).toBe("agent_stocks");
    // agents never make pieces: that needs the owner's wallet and pieces key
    expect((await open({})).json()).toMatchObject({ error: "agent_needs_pieces", message: "This trade needs 1 ready pieces and the account has 0. The owner sets up more pieces in the app first." });
    expect(s.charged).toEqual([]);
    expect(s.h.db.prepare("SELECT COUNT(*) AS n FROM positions").get()).toEqual({ n: 0 });
  });

  it("open on a ready piece, seal a stop, read status and close; each call paid and recorded", async () => {
    const s = setup();
    await readyPiece(s);
    const { id: keyId, key } = await newKey(s);

    const opened = await agent(s, key, "POST", "/api/agent/positions", ETH);
    expect(opened.statusCode, opened.body).toBe(200);
    expect(opened.headers["payment-response"]).toBe("settled");
    const { positionId, state, paid } = opened.json();
    expect(state).toBe("funding");
    expect(paid).toEqual({ tx: "paytx1", price: "0.002" });
    // the same ready piece, no new one
    expect(s.h.db.prepare("SELECT COUNT(*) AS n FROM pieces WHERE kind = 'piece'").get()).toEqual({ n: 1 });
    expect(s.h.db.prepare("SELECT agent_key_id FROM positions WHERE id = ?").get(positionId)).toEqual({ agent_key_id: keyId });
    await runFor(s.h, 1_300_000);
    expect((s.h.db.prepare("SELECT state FROM positions WHERE id = ?").get(positionId) as any).state).toBe("open");

    // the stop is sealed on the agent's side; the server passes the box to the guard unopened
    const shard = (s.h.db.prepare("SELECT shard_id FROM pieces WHERE kind = 'piece'").get() as any).shard_id;
    const sealed = await agent(s, key, "POST", `/api/agent/positions/${positionId}/stop`, { boxes: [{ shard, box: BOX }] });
    expect(sealed.statusCode, sealed.body).toBe(200);
    const fwd = s.h.world.calls.filter((c) => c.outer?.box);
    expect(fwd.at(-1)!.outer).toMatchObject({ shard, box: BOX });

    const status = (await agent(s, key, "GET", "/api/agent/positions")).json();
    expect(status.positions).toHaveLength(1);
    expect(status.positions[0]).toMatchObject({ id: positionId, coin: "ETH", side: "long", state: "open" });
    // the shard id and size to seal with, but no Hyperliquid address and no level
    expect(status.positions[0].pieces[0]).toMatchObject({ shard, hasStop: false });
    expect(JSON.stringify(status)).not.toMatch(/0x[0-9a-f]{40}/);

    const closed = await agent(s, key, "POST", `/api/agent/positions/${positionId}/close`, { now: true });
    expect(closed.json()).toMatchObject({ ok: true, state: "closing" });
    const calls = s.h.db.prepare("SELECT op, result, paid_tx, payer, price FROM agent_calls ORDER BY created_ms, rowid").all();
    expect(calls).toEqual([
      { op: "open", result: "ok", paid_tx: "paytx1", payer: "agent.near", price: "0.002" },
      { op: "stop", result: "ok", paid_tx: "paytx2", payer: "agent.near", price: "0.002" },
      { op: "status", result: "ok", paid_tx: "paytx3", payer: "agent.near", price: "0.002" },
      { op: "close", result: "ok", paid_tx: "paytx4", payer: "agent.near", price: "0.002" },
    ]);
    const list = (await owner(s, "GET", "/api/agents")).json();
    expect(list.keys[0]).toMatchObject({ calls: 4, paidCalls: 4 });
  });

  it("an agent cannot touch the owner's own positions or another agent's", async () => {
    const s = setup();
    await readyPiece(s);
    const a = await newKey(s, { name: "a" });
    const b = await newKey(s, { name: "b" });
    const { positionId } = (await agent(s, a.key, "POST", "/api/agent/positions", ETH)).json();
    expect((await agent(s, b.key, "POST", `/api/agent/positions/${positionId}/close`, {})).statusCode).toBe(404);
    const ownerPos = (s.h.db.prepare("SELECT id FROM positions WHERE agent_key_id IS NULL").get() as any).id;
    expect((await agent(s, a.key, "POST", `/api/agent/positions/${ownerPos}/close`, {})).statusCode).toBe(404);
    expect((await agent(s, b.key, "GET", "/api/agent/positions")).json().positions).toEqual([]);
  });

  it("stop counting opens at the key's daily limit", async () => {
    const s = setup();
    await readyPiece(s);
    const { key } = await newKey(s, { dailyOpens: 1 });
    const first = (await agent(s, key, "POST", "/api/agent/positions", ETH)).json();
    await runFor(s.h, 1_300_000);
    await agent(s, key, "POST", `/api/agent/positions/${first.positionId}/close`, { now: true });
    await runFor(s.h, 100_000, 1_000);
    expect((await agent(s, key, "POST", "/api/agent/positions", ETH)).json()).toMatchObject({ error: "agent_limit", message: "This agent key does not allow that: it may open 1 positions a day." });
  });
});
