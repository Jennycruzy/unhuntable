import { plan } from "unhuntable-client";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/index.js";
import { advancePosition } from "../src/positions.js";
import { testConfig } from "./helpers.js";
import { addUser, addWallet, harness, runFor, type Harness } from "./world.js";

const ETH = { coin: "ETH", side: "long", notionalUsd: 30, leverage: 3, hiding: "normal" } as const;
const WHALE = { coin: "ETH", side: "long", notionalUsd: 150, leverage: 3, hiding: "whale" } as const;

interface S {
  h: Harness;
  app: ReturnType<typeof buildServer>;
  cookie: string;
  userId: string;
  balWallet: string;
}

let nextWallet = 0x80;

function setup(): S {
  const h = harness();
  const alice = addUser(h);
  const bal = addWallet(h, alice.userId, "balance", "none");
  const app = buildServer({ config: testConfig(), db: h.db, now: h.ctx.now, money: h.ctx });
  return { h, app, cookie: alice.cookie, userId: alice.userId, balWallet: bal.walletId };
}

async function post(s: S, url: string, payload: unknown = {}) {
  return s.app.inject({ method: "POST", url, headers: { cookie: s.cookie }, payload: payload as object });
}

/** What the browser does for each needed wallet: make it, add our key, confirm. */
async function makeWallets(s: S, labels: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const label of labels) {
    const { requestId } = (await post(s, "/api/wallets/key", { label })).json();
    const n = nextWallet++;
    const walletId = `00000000-0000-4000-8000-000000000${n.toString(16).padStart(3, "0")}`;
    s.h.world.addWallet(walletId, n);
    s.h.world.noPolicy.add(walletId);
    await s.h.keystore.withRequestKey(requestId, async (k) => s.h.world.addKey(k, walletId));
    const r = await post(s, "/api/wallets/confirm", { requestId, label, seed: "unh-" + label });
    expect(r.statusCode).toBe(200);
    ids.push(walletId);
  }
  return ids;
}

function positionState(s: S, id: string): string {
  return (s.h.db.prepare("SELECT state FROM positions WHERE id = ?").get(id) as { state: string }).state;
}

/** Run a new position from confirm to open, as the browser and the user would. */
async function openPosition(s: S, body: object) {
  const created = (await post(s, "/api/positions", body)).json();
  const id = created.positionId;
  const wallets = await makeWallets(s, created.needWallets);
  const cont = (await post(s, `/api/positions/${id}/continue`)).json();
  await runFor(s.h, 1_300_000);
  let batch = null;
  if (positionState(s, id) === "policy_wait") {
    batch = (await post(s, `/api/positions/${id}/continue`)).json().policyBatch;
    // the user signs: the wallets now have stored policies with evm_sign off
    for (const w of wallets) s.h.world.noPolicy.delete(w);
    const conf = await post(s, "/api/policy/confirm", { positionId: id, txHashes: ["tx1"] });
    expect(conf.statusCode, conf.body).toBe(200);
  }
  await runFor(s.h, 1_300_000);
  return { id, created, cont, wallets, batch };
}

describe("plan and confirm", () => {
  it("/api/plan returns the planner's answer for fixed inputs", async () => {
    const s = setup();
    const r = await post(s, "/api/plan", WHALE);
    expect(r.statusCode).toBe(200);
    const expected = plan({ ...WHALE, markPx: 2500.5, szDecimals: 4, maxLeverage: 25 }, new Uint8Array(32).fill(0x5a));
    const body = r.json();
    expect(body.plan).toEqual(JSON.parse(JSON.stringify(expected)));
    expect(body.world).toEqual(
      (expected as any).pieces.map((p: any, i: number) => ({ name: `Account ${i + 1}`, sizeUsd: (Math.round(p.notionalUsd * 100) / 100).toFixed(2), side: "long" })),
    );
    expect(body.newPiecesNeeded).toBe((expected as any).pieces.length);
    expect(body.exitFeeUsd).toBe((1.2 * (expected as any).pieces.length).toFixed(2));
    expect(Number(body.feesUsd)).toBeCloseTo((expected as any).estFeesUsd, 2);
    expect(s.h.world.ofHost("hl.test").map((c) => c.body.type)).toEqual(["allMids", "meta"]);
  });

  it("leverage 11 -> max_leverage; too small -> shard_min_notional", async () => {
    const s = setup();
    const lev = await post(s, "/api/plan", { ...ETH, leverage: 11 });
    expect(lev.statusCode).toBe(422);
    expect(lev.json()).toEqual({ error: "max_leverage", message: "The most leverage here is 10x. Lower it and try again." });
    const small = await post(s, "/api/plan", { ...ETH, notionalUsd: 5 });
    expect(small.json().error).toBe("shard_min_notional");
    const both = await post(s, "/api/positions", { ...ETH, notionalUsd: 5 });
    expect(both.json().error).toBe("shard_min_notional");
    expect(s.h.db.prepare("SELECT COUNT(*) AS n FROM positions").get()).toEqual({ n: 0 });
  });

  it("confirm draws real VRF bytes from the guard and stores output and proof", async () => {
    const s = setup();
    s.h.world.vrfHex = "c3".repeat(32);
    const r = (await post(s, "/api/positions", ETH)).json();
    expect(r).toEqual({ positionId: r.positionId, state: "planned", needWallets: ["piece:0"], needChainSig: [], policyBatch: null });
    const row = s.h.db.prepare("SELECT vrf_hex, vrf_proof, vrf_alpha, plan_json FROM positions").get() as any;
    expect(row.vrf_hex).toBe("c3".repeat(32));
    expect(row.vrf_proof).toBe("cd".repeat(40));
    expect(row.vrf_alpha).toBe(r.positionId);
    expect(JSON.parse(row.plan_json)).toEqual(
      JSON.parse(JSON.stringify(plan({ ...ETH, markPx: 2500.5, szDecimals: 4, maxLeverage: 25 }, Buffer.from("c3".repeat(32), "hex")))),
    );
    const vrfCall = s.h.world.calls.find((c) => c.inner?.op === "vrf")!;
    expect(vrfCall.inner.label).toBe(r.positionId);
  });
});

describe("open: planned -> funding -> policy_wait -> opening -> open", () => {
  it("one piece", async () => {
    const s = setup();
    const { id, cont, batch, wallets } = await openPosition(s, ETH);
    expect(cont).toEqual({ positionId: id, state: "funding", needWallets: [], needChainSig: [], policyBatch: null });
    // one lock for the piece, one for the private balance
    expect(batch.transactions).toHaveLength(2);
    expect(batch.summary[0]).toBe("Lock piece Account 1: it can only send to its own Hyperliquid account and to alice.near. Our server cannot sign for it.");
    expect(positionState(s, id)).toBe("open");
    const pieceAddr = s.h.world.wallets.get(wallets[0])!.evm;
    // funded with the plan's ladder value, from the private balance, to the piece itself
    const p = JSON.parse((s.h.db.prepare("SELECT plan_json FROM positions").get() as any).plan_json);
    const w = s.h.world.calls.filter((c) => c.path === "/wallet/v1/confidential/withdraw");
    expect(w.map((c) => [c.walletId, c.body.to, c.body.chain, c.body.amount])).toEqual([[s.balWallet, pieceAddr, "hypercore", String(p.pieces[0].fundingUsd * 1e6)]]);
    // the piece's master approved the guard agent (chain arbitrum), and the guard registered it
    const sign = s.h.world.calls.find((c) => c.path === "/wallet/v1/evm/sign-typed-data")!;
    expect(sign.walletId).toBe(wallets[0]);
    expect(sign.body.chain).toBe("arbitrum");
    expect(sign.body.typed_data.primaryType).toBe("HyperliquidTransaction:ApproveAgent");
    expect(sign.body.typed_data.domain.chainId).toBe(0x66eee);
    const ex = s.h.world.calls.find((c) => c.path === "/exchange")!;
    expect(ex.body.action).toMatchObject({ type: "approveAgent", agentAddress: "0x" + "55".repeat(20), signatureChainId: "0x66eee" });
    const ops = s.h.world.calls.filter((c) => c.inner).map((c) => c.inner.op);
    expect(ops).toEqual(["vrf", "agent", "register", "leverage", "open"]);
    expect(s.h.world.calls.find((c) => c.inner?.op === "register")!.inner.master).toBe(pieceAddr);
    // the fill is recorded
    expect(s.h.db.prepare("SELECT kind, size, px FROM piece_orders").all()).toEqual([{ kind: "open", size: p.pieces[0].size, px: 2500.5 }]);
    const list = (await s.app.inject({ method: "GET", url: "/api/positions", headers: { cookie: s.cookie } })).json();
    expect(list.positions[0]).toMatchObject({ id, coin: "ETH", side: "long", notionalUsd: 30, leverage: 3, hiding: "normal", state: "open" });
    expect(list.positions[0].pieces[0]).toMatchObject({ label: "piece:0", size: p.pieces[0].size, entryPx: 2500.5, hasStop: false, hasTp: false, guard: "ok" });
    expect(list.positions[0].alerts.length).toBeGreaterThan(0);
    // both wallets are locked now
    expect(s.h.db.prepare("SELECT label, policy_state FROM pieces ORDER BY label").all()).toEqual([
      { label: "balance", policy_state: "locked" },
      { label: "piece:0", policy_state: "locked" },
    ]);
  });

  it("three pieces, each funded from the private balance to its own address (no_inter_piece_transfer)", async () => {
    const s = setup();
    const seen: Array<{ from: string; to: string }> = [];
    s.h.world.onWithdraw = (walletId, body) => seen.push({ from: walletId, to: body.to });
    const { id, wallets } = await openPosition(s, WHALE);
    expect(positionState(s, id)).toBe("open");
    expect(wallets).toHaveLength(3);
    const addrs = new Set(wallets.map((w) => s.h.world.wallets.get(w)!.evm));
    expect(seen).toHaveLength(3);
    for (const x of seen) {
      expect(x.from).toBe(s.balWallet);
      expect(addrs.has(x.to)).toBe(true);
    }
    expect(new Set(seen.map((x) => x.to)).size).toBe(3);
    // every withdraw of the run went to the same piece's own address recorded on its funding row
    const rows = s.h.db
      .prepare("SELECT f.piece_id, p.hl_address FROM fundings f JOIN pieces p ON p.id = f.piece_id ORDER BY f.created_ms")
      .all() as { piece_id: string; hl_address: string }[];
    expect(rows.map((r) => r.hl_address).sort()).toEqual(seen.map((x) => x.to).sort());
    // pieces never send to each other: no piece wallet ever made a withdraw
    expect(s.h.world.calls.filter((c) => c.path === "/wallet/v1/confidential/withdraw" && c.walletId !== s.balWallet)).toEqual([]);
    expect(s.h.db.prepare("SELECT COUNT(*) AS n FROM piece_orders WHERE kind = 'open'").get()).toEqual({ n: 3 });
  });

  it("confirm reuses free pieces before asking for new ones", async () => {
    const s = setup();
    const first = await openPosition(s, ETH);
    expect((await post(s, `/api/positions/${first.id}/close`, { now: true })).json()).toEqual({ ok: true, state: "closing" });
    await runFor(s.h, 10_000);
    expect(positionState(s, first.id)).toBe("closed");

    const second = (await post(s, "/api/positions", WHALE)).json();
    const p = JSON.parse((s.h.db.prepare("SELECT plan_json FROM positions WHERE id = ?").get(second.positionId) as any).plan_json);
    expect(p.pieces.length).toBe(3);
    // piece:0 is reused; two new ones are asked for
    expect(second.needWallets).toEqual(["piece:1", "piece:2"]);
    const reused = s.h.db
      .prepare("SELECT p.label, pp.reused FROM position_pieces pp JOIN pieces p ON p.id = pp.piece_id WHERE pp.position_id = ? ORDER BY pp.idx")
      .all(second.positionId);
    expect(reused).toEqual([
      { label: "piece:0", reused: 1 },
      { label: "piece:1", reused: 0 },
      { label: "piece:2", reused: 0 },
    ]);
    const preview = (await post(s, "/api/plan", ETH)).json();
    expect(preview.newPiecesNeeded).toBe(1);
  });

  it("a locked private balance missing new pieces asks for its update before funding", async () => {
    const s = setup();
    const first = await openPosition(s, ETH);
    await post(s, `/api/positions/${first.id}/close`, { now: true });
    await runFor(s.h, 10_000);
    const second = (await post(s, "/api/positions", WHALE)).json();
    await makeWallets(s, second.needWallets);
    const cont = (await post(s, `/api/positions/${second.positionId}/continue`)).json();
    expect(cont.state).toBe("planned");
    expect(cont.policyBatch.transactions).toHaveLength(1);
    expect(cont.policyBatch.summary[0]).toMatch(/^Update your private balance: it can only send to your 3 pieces/);
    const conf = (await post(s, "/api/policy/confirm", { positionId: second.positionId, txHashes: ["tx"] })).json();
    expect(conf).toEqual({ ok: true, locked: ["balance"], unlocked: [] });
    expect(positionState(s, second.positionId)).toBe("funding");
  });
});

describe("policies and refusals", () => {
  it("confirm with a wrong owner or with evm_sign on is refused", async () => {
    for (const bad of ["owner", "evm"] as const) {
      const s = setup();
      const created = (await post(s, "/api/positions", ETH)).json();
      const [w] = await makeWallets(s, created.needWallets);
      await post(s, `/api/positions/${created.positionId}/continue`);
      await runFor(s.h, 200_000);
      expect(positionState(s, created.positionId)).toBe("policy_wait");
      s.h.world.noPolicy.delete(w);
      if (bad === "owner") s.h.world.policyOwner = "bob.near";
      else s.h.world.evmOn.add(w);
      const r = await post(s, "/api/policy/confirm", { positionId: created.positionId, txHashes: ["tx"] });
      expect(r.json().error).toBe(bad === "owner" ? "policy_owner_wrong" : "policy_not_set");
      expect(positionState(s, created.positionId)).toBe("policy_wait");
      expect((s.h.db.prepare("SELECT policy_state FROM pieces WHERE label = 'piece:0'").get() as any).policy_state).toBe("none");
    }
  });

  it("server_refuses_unlocked_piece", async () => {
    const s = setup();
    const created = (await post(s, "/api/positions", ETH)).json();
    await makeWallets(s, created.needWallets);
    await post(s, `/api/positions/${created.positionId}/continue`);
    await runFor(s.h, 200_000);
    // skip the lock: force the position on without a locked policy
    s.h.db.prepare("UPDATE positions SET state = 'opening', start_ms = ? WHERE id = ?").run(s.h.clock.t, created.positionId);
    await advancePosition(s.h.ctx, created.positionId);
    await runFor(s.h, 200_000);
    expect(positionState(s, created.positionId)).toBe("opening");
    expect(s.h.world.calls.some((c) => c.inner?.op === "open" || c.inner?.op === "leverage")).toBe(false);
    expect((s.h.db.prepare("SELECT error FROM positions").get() as any).error).toBe("policy_not_set");
    const alerts = (await s.app.inject({ method: "GET", url: "/api/alerts", headers: { cookie: s.cookie } })).json().alerts.map((a: any) => a.text);
    expect(alerts).toContain("ETH piece Account 1: Your new pieces need your approval in your wallet before we can trade. Open the approval.");
  });

  it("a guard refusal maps to the right code and the open is tried again", async () => {
    for (const [fixtureName, code] of [
      ["guard-open-disagree", "prices_disagree"],
      ["guard-open-cap", "over_cap"],
      ["guard-open-venue", "venue_rejected"],
    ] as const) {
      const s = setup();
      s.h.world.guardOpen.push(fixtureName);
      const created = (await post(s, "/api/positions", ETH)).json();
      const ws = await makeWallets(s, created.needWallets);
      await post(s, `/api/positions/${created.positionId}/continue`);
      await runFor(s.h, 200_000);
      for (const w of ws) s.h.world.noPolicy.delete(w);
      await post(s, "/api/policy/confirm", { positionId: created.positionId, txHashes: ["tx"] });
      // run just past the open slot: the first open is refused
      const start = (s.h.db.prepare("SELECT start_ms FROM positions").get() as any).start_ms;
      const offset = (s.h.db.prepare("SELECT entry_offset_ms FROM position_pieces").get() as any).entry_offset_ms;
      s.h.clock.t = start + offset;
      await s.h.jobs.runDue();
      expect((s.h.db.prepare("SELECT error, state FROM positions").get() as any)).toEqual({ error: code, state: "opening" });
      if (code === "venue_rejected") {
        const alerts = (await s.app.inject({ method: "GET", url: "/api/alerts", headers: { cookie: s.cookie } })).json().alerts.map((a: any) => a.text);
        expect(alerts).toContain("ETH piece Account 1: Hyperliquid refused the order: Insufficient margin to place order.. Nothing changed.");
      }
      await runFor(s.h, 60_000);
      expect((s.h.db.prepare("SELECT error, state FROM positions").get() as any)).toEqual({ error: null, state: "open" });
    }
  });

  it("opening is idempotent: a re-run job does not open twice", async () => {
    const s = setup();
    const { id } = await openPosition(s, ETH);
    expect(positionState(s, id)).toBe("open");
    const opens = () => s.h.world.calls.filter((c) => c.inner?.op === "open").length;
    expect(opens()).toBe(1);
    // the same job again, and a run that stopped after the order went out
    await advancePosition(s.h.ctx, id);
    s.h.db.prepare("UPDATE positions SET state = 'opening' WHERE id = ?").run(id);
    s.h.db.prepare("UPDATE position_pieces SET state = 'opening' WHERE position_id = ?").run(id);
    await advancePosition(s.h.ctx, id);
    expect(opens()).toBe(1);
    expect(positionState(s, id)).toBe("open");
    expect(s.h.db.prepare("SELECT COUNT(*) AS n FROM piece_orders WHERE kind = 'open'").get()).toEqual({ n: 1 });
  });

  it("guard unreachable after retries: the position keeps its state and the API shows it", async () => {
    const s = setup();
    const created = (await post(s, "/api/positions", ETH)).json();
    const ws = await makeWallets(s, created.needWallets);
    await post(s, `/api/positions/${created.positionId}/continue`);
    await runFor(s.h, 200_000);
    for (const w of ws) s.h.world.noPolicy.delete(w);
    await post(s, "/api/policy/confirm", { positionId: created.positionId, txHashes: ["tx"] });
    s.h.world.guardDown = true;
    await runFor(s.h, 400_000);
    expect(positionState(s, created.positionId)).toBe("opening");
    const list = (await s.app.inject({ method: "GET", url: "/api/positions", headers: { cookie: s.cookie } })).json();
    expect(list.positions[0].pieces[0].guard).toBe("unreachable");
    s.h.world.guardDown = false;
    await runFor(s.h, 1_200_000, 30_000);
    expect(positionState(s, created.positionId)).toBe("open");
    const again = (await s.app.inject({ method: "GET", url: "/api/positions", headers: { cookie: s.cookie } })).json();
    expect(again.positions[0].pieces[0].guard).toBe("ok");
  });
});

describe("hunter's view", () => {
  const get = (s: S, url: string, cookie = s.cookie) => s.app.inject({ method: "GET", url, headers: { cookie } });
  const held = (szi: string, value: string, liq: string) => ({
    type: "oneWay",
    position: { coin: "ETH", szi, leverage: { type: "cross", value: 3 }, entryPx: "2500.5", positionValue: value, liquidationPx: liq },
  });

  it("shows each piece as Hyperliquid shows it to anyone: its own account, and no resting orders", async () => {
    const s = setup();
    const { id, wallets } = await openPosition(s, WHALE);
    const addrs = wallets.map((w) => s.h.world.wallets.get(w)!.evm);
    addrs.forEach((a, i) => s.h.world.setPerp(a, 20, 5, [held(`0.0${i + 1}`, `${25 * (i + 1)}`, `${1700 + i}`)]));
    const before = s.h.world.calls.length;
    const r = await get(s, `/api/positions/${id}/hunter`);
    expect(r.statusCode, r.body).toBe(200);
    const v = r.json();
    expect(v.coin).toBe("ETH");
    expect(v.markPx).toBeGreaterThan(0);
    expect(v.accounts).toHaveLength(3);
    expect(v.accounts.map((a: any) => a.address)).toEqual(addrs);
    expect(v.accounts[1]).toEqual({ address: addrs[1], side: "long", size: 0.02, valueUsd: 50, entryPx: 2500.5, liqPx: 1701, leverage: 3, restingOrders: 0, triggerPxs: [] });
    // read the way a tracker reads: account state and resting orders, per account
    const asked = s.h.world.calls.slice(before).filter((c) => c.host === "hl.test").map((c) => c.body.type);
    expect(asked.filter((t) => t === "clearinghouseState")).toHaveLength(3);
    expect(asked.filter((t) => t === "frontendOpenOrders")).toHaveLength(3);
    // a second look inside the keeping time asks Hyperliquid for nothing
    const again = s.h.world.calls.length;
    expect((await get(s, `/api/positions/${id}/hunter`)).json()).toEqual(v);
    expect(s.h.world.calls.length).toBe(again);
  });

  it("an order left on the book is counted, with its trigger price, and other markets are left out", async () => {
    const s = setup();
    const { id, wallets } = await openPosition(s, ETH);
    const addr = s.h.world.wallets.get(wallets[0])!.evm;
    s.h.world.setPerp(addr, 20, 5, [held("-0.012", "30", "3100")]);
    s.h.world.openOrders.set(addr, [
      { coin: "ETH", side: "B", isTrigger: true, triggerPx: "2700.0", orderType: "Stop Market" },
      { coin: "ETH", side: "B", isTrigger: false, triggerPx: "0.0", orderType: "Limit" },
      { coin: "BTC", side: "A", isTrigger: true, triggerPx: "90000.0", orderType: "Stop Market" },
    ]);
    const v = (await get(s, `/api/positions/${id}/hunter`)).json();
    expect(v.accounts[0]).toMatchObject({ side: "short", size: 0.012, liqPx: 3100, restingOrders: 2, triggerPxs: [2700] });
  });

  it("an account that holds nothing in the market shows no position", async () => {
    const s = setup();
    const { id, wallets } = await openPosition(s, ETH);
    s.h.world.setPerp(s.h.world.wallets.get(wallets[0])!.evm, 20, 20, []);
    const v = (await get(s, `/api/positions/${id}/hunter`)).json();
    expect(v.accounts[0]).toMatchObject({ side: null, size: null, valueUsd: null, liqPx: null, restingOrders: 0 });
  });

  it("is only for the position's owner", async () => {
    const s = setup();
    const { id } = await openPosition(s, ETH);
    const bob = addUser(s.h, "bob.near");
    expect((await get(s, `/api/positions/${id}/hunter`, bob.cookie)).statusCode).toBe(404);
    expect((await get(s, `/api/positions/${id}/hunter`, "")).statusCode).toBe(401);
  });
});

describe("close", () => {
  it("closes each piece at VRF-staggered times inside 0-90 s", async () => {
    const s = setup();
    const { id } = await openPosition(s, WHALE);
    const t0 = s.h.clock.t;
    expect((await post(s, `/api/positions/${id}/close`)).json()).toEqual({ ok: true, state: "closing" });
    const at = (s.h.db.prepare("SELECT close_at_ms FROM position_pieces WHERE position_id = ? ORDER BY idx").all(id) as any[]).map((r) => r.close_at_ms - t0);
    for (const x of at) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(90_000);
    }
    expect(new Set(at).size).toBeGreaterThan(1);
    await runFor(s.h, 95_000, 1_000);
    expect(positionState(s, id)).toBe("closed");
    const closes = s.h.world.calls.filter((c) => c.inner?.op === "close");
    expect(closes).toHaveLength(3);
    expect(s.h.db.prepare("SELECT COUNT(*) AS n FROM piece_orders WHERE kind = 'close'").get()).toEqual({ n: 3 });
  });

  it("a position of another user cannot be closed or continued", async () => {
    const s = setup();
    const created = (await post(s, "/api/positions", ETH)).json();
    const bob = addUser(s.h, "bob.near");
    for (const url of [`/api/positions/${created.positionId}/close`, `/api/positions/${created.positionId}/continue`]) {
      const r = await s.app.inject({ method: "POST", url, headers: { cookie: bob.cookie }, payload: {} });
      expect(r.json().error).toBe("not_found");
    }
  });
});
