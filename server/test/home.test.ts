import { describe, expect, it } from "vitest";
import { buildServer } from "../src/index.js";
import { testConfig } from "./helpers.js";
import { addUser, addWallet, harness, runFor, type Harness } from "./world.js";

interface S {
  h: Harness;
  app: ReturnType<typeof buildServer>;
  cookie: string;
  pieces: { walletId: string; address: string }[];
}

function setup(amounts: number[]): S {
  const h = harness();
  const alice = addUser(h);
  addWallet(h, alice.userId, "balance", "locked");
  const pieces = amounts.map((a, i) => {
    const p = addWallet(h, alice.userId, `piece:${i}`, "locked");
    h.world.setPerp(p.address, a, a);
    return p;
  });
  const app = buildServer({ config: testConfig(), db: h.db, now: h.ctx.now, money: h.ctx });
  return { h, app, cookie: alice.cookie, pieces };
}

async function post(s: S, url: string, payload: unknown = {}) {
  return s.app.inject({ method: "POST", url, headers: { cookie: s.cookie }, payload: payload as object });
}

async function home(s: S, id: string) {
  return (await s.app.inject({ method: "GET", url: `/api/home/${id}`, headers: { cookie: s.cookie } })).json();
}

describe("go home", () => {
  it("runs unlock_wait -> moving -> relock_wait -> done", async () => {
    const s = setup([10, 20]);
    s.h.world.privateUnits = 0n;
    const start = await post(s, "/api/home", {});
    expect(start.statusCode).toBe(200);
    const { homeId, feeUsd, unlockBatch } = start.json();
    expect(feeUsd).toBe("2.40");
    expect(unlockBatch.transactions).toHaveLength(2);
    expect(unlockBatch.summary[0]).toBe("Unlock piece Account 1 so it can send its money home: it can sign Hyperliquid transfers until you lock it again.");
    // the unlock is the same piece policy with evm_sign on
    const enc = s.h.world.calls.filter((c) => c.path === "/wallet/v1/encrypt-policy");
    expect(enc.map((c) => c.body.capabilities.evm_sign.allowed)).toEqual([true, true]);
    expect((await home(s, homeId)).state).toBe("unlock_wait");
    const alerts = (await s.app.inject({ method: "GET", url: "/api/alerts", headers: { cookie: s.cookie } })).json().alerts.map((a: any) => a.text);
    expect(alerts).toContain("Leaving Hyperliquid costs about $1.20 per piece (Hyperliquid's new-account fee plus routing).");

    for (const p of s.pieces) s.h.world.evmOn.add(p.walletId);
    const conf = (await post(s, "/api/policy/confirm", { homeId, txHashes: ["t1", "t2"] })).json();
    expect(conf).toEqual({ ok: true, locked: [], unlocked: ["piece:0", "piece:1"] });
    expect((await home(s, homeId)).state).toBe("moving");

    await runFor(s.h, 120_000);
    const st = await home(s, homeId);
    expect(st.state).toBe("relock_wait");
    expect(st.relockBatch.transactions).toHaveLength(2);
    expect(st.relockBatch.summary[1]).toBe("Lock piece Account 2: it can only send to its own Hyperliquid account and to alice.near. Our server cannot sign for it.");
    expect(st.steps.map((x: any) => [x.label, x.step, x.status])).toEqual([
      ["piece:0", "to_spot", "done"],
      ["piece:0", "deposit_address", "done"],
      ["piece:0", "send", "done"],
      ["piece:0", "arrive", "done"],
      ["piece:1", "to_spot", "done"],
      ["piece:1", "deposit_address", "done"],
      ["piece:1", "send", "done"],
      ["piece:1", "arrive", "done"],
    ]);
    for (const x of st.steps) expect(typeof x.ms).toBe("number");
    expect(st.arrivedUsdc).toBe("28");

    // the money moved as on the exit tool: perp -> spot of the withdrawable, a fresh hypercore deposit, spotSend of total - 1
    const ex = s.h.world.calls.filter((c) => c.path === "/exchange").map((c) => c.body.action);
    expect(ex.map((a) => [a.type, a.amount])).toEqual([
      ["usdClassTransfer", "10"],
      ["spotSend", "9"],
      ["usdClassTransfer", "20"],
      ["spotSend", "19"],
    ]);
    expect(ex[0].toPerp).toBe(false);
    expect(ex[1].destination).toBe("0x3333333333333333333333333333333333333333");
    const deps = s.h.world.calls.filter((c) => c.path === "/wallet/v1/confidential/deposit/cross-chain");
    expect(deps.map((c) => c.body)).toEqual([
      { chain: "hypercore", token: "USDC", amount: "900000000" },
      { chain: "hypercore", token: "USDC", amount: "1900000000" },
    ]);
    // signing went through each piece's own key on chain arbitrum
    const signs = s.h.world.calls.filter((c) => c.path === "/wallet/v1/evm/sign-typed-data");
    expect(signs.map((c) => c.walletId)).toEqual([s.pieces[0].walletId, s.pieces[0].walletId, s.pieces[1].walletId, s.pieces[1].walletId]);
    expect(new Set(signs.map((c) => c.body.chain))).toEqual(new Set(["arbitrum"]));

    for (const p of s.pieces) s.h.world.evmOn.delete(p.walletId);
    const relock = (await post(s, "/api/policy/confirm", { homeId, txHashes: ["t3"] })).json();
    expect(relock).toEqual({ ok: true, locked: ["piece:0", "piece:1"], unlocked: [] });
    expect((await home(s, homeId)).state).toBe("done");
    expect((await home(s, homeId)).relockBatch).toBeNull();
    expect(s.h.db.prepare("SELECT label, policy_state FROM pieces WHERE kind = 'piece' ORDER BY label").all()).toEqual([
      { label: "piece:0", policy_state: "locked" },
      { label: "piece:1", policy_state: "locked" },
    ]);
  });

  it("a piece under 3 USDC is skipped with its reason", async () => {
    const s = setup([2.5, 10]);
    const { homeId } = (await post(s, "/api/home", {})).json();
    for (const p of s.pieces) s.h.world.evmOn.add(p.walletId);
    await post(s, "/api/policy/confirm", { homeId, txHashes: ["t"] });
    await runFor(s.h, 120_000);
    const st = await home(s, homeId);
    expect(st.steps[0]).toMatchObject({ label: "piece:0", step: "skip", status: "skipped" });
    expect(st.steps[0].detail).toBe("Only 2.50 USDC here. Under 3 USDC is not worth moving: Hyperliquid keeps 1 USDC per send.");
    expect(st.steps.filter((x: any) => x.label === "piece:1").map((x: any) => x.step)).toEqual(["to_spot", "deposit_address", "send", "arrive"]);
    expect(st.state).toBe("relock_wait");
    // nothing was signed for the skipped piece
    expect(s.h.world.calls.some((c) => c.path === "/wallet/v1/evm/sign-typed-data" && c.walletId === s.pieces[0].walletId)).toBe(false);
  });

  it("signing refused (policy still locked) stops with exit_needs_unlock; relock is still asked for", async () => {
    const s = setup([10, 10]);
    const { homeId } = (await post(s, "/api/home", {})).json();
    for (const p of s.pieces) s.h.world.evmOn.add(p.walletId);
    await post(s, "/api/policy/confirm", { homeId, txHashes: ["t"] });
    // the policy is locked again before the server signs
    for (const p of s.pieces) s.h.world.evmOn.delete(p.walletId);
    await runFor(s.h, 60_000);
    const st = await home(s, homeId);
    expect(st.state).toBe("relock_wait");
    expect(st.relockBatch.transactions).toHaveLength(2);
    expect(st.steps).toEqual([
      {
        label: "piece:0",
        step: "sign",
        status: "failed",
        ms: st.steps[0].ms,
        detail: "Sending money home needs your approval in your wallet (one tap), then a second tap to lock it again.",
      },
    ]);
    expect(s.h.world.calls.some((c) => c.path === "/exchange")).toBe(false);
    await post(s, "/api/policy/confirm", { homeId, txHashes: ["t"] });
    expect((await home(s, homeId)).state).toBe("failed");
  });

  it("an unlock that was not stored is refused, and pieces in an open position cannot go home", async () => {
    const s = setup([10]);
    const { homeId } = (await post(s, "/api/home", {})).json();
    const r = await post(s, "/api/policy/confirm", { homeId, txHashes: ["t"] });
    expect(r.json().error).toBe("policy_not_set");
    expect((await home(s, homeId)).state).toBe("unlock_wait");

    const userId = (s.h.db.prepare("SELECT id FROM users").get() as any).id;
    const pieceId = (s.h.db.prepare("SELECT id FROM pieces WHERE label = 'piece:0'").get() as any).id;
    s.h.db.prepare("INSERT INTO positions (id, user_id, coin, side, notional_usd, leverage, hiding, state, created_ms, network) VALUES ('x', ?, 'ETH', 'long', 30, 3, 'normal', 'open', 1, 'mainnet')").run(userId);
    s.h.db.prepare("INSERT INTO position_pieces (id, position_id, piece_id, idx, size, funding_usd, entry_offset_ms, state, created_ms, network) VALUES ('pp', 'x', ?, 0, 0.01, 12, 0, 'open', 1, 'mainnet')").run(pieceId);
    const busy = await post(s, "/api/home", { labels: ["piece:0"] });
    expect(busy.json().error).toBe("piece_in_use");
    const other = await post(s, "/api/home", { labels: ["piece:7"] });
    expect(other.json().error).toBe("not_found");
  });
});
