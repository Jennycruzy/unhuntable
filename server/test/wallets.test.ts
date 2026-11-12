import { apiKeyBody, keyFromMnemonic, ownerAccount, piecesKeyProof } from "unhuntable-client";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/index.js";
import { testConfig } from "./helpers.js";
import { addUser, addWallet, harness, reply, type Harness } from "./world.js";

// Test-only phrase, never used for money.
const KEY = keyFromMnemonic("legal winner thank year wave sausage worth useful legal winner thank yellow");
const PK = KEY.publicKeyStr;

function app(h: Harness) {
  return buildServer({ config: testConfig(), db: h.db, now: h.ctx.now, money: h.ctx });
}

/** Make a key, register it with the fake OutLayer for a new wallet, and confirm it. */
async function makeWallet(h: Harness, cookie: string, label: string, n: number) {
  const a = app(h);
  const k = await a.inject({ method: "POST", url: "/api/wallets/key", headers: { cookie }, payload: { label } });
  const { requestId } = k.json();
  const walletId = `00000000-0000-4000-8000-0000000001${n.toString(16).padStart(2, "0")}`;
  h.world.addWallet(walletId, n);
  await h.keystore.withRequestKey(requestId, async (key) => h.world.addKey(key, walletId));
  const r = await a.inject({ method: "POST", url: "/api/wallets/confirm", headers: { cookie }, payload: { requestId, label, seed: "unh-seed-" + n } });
  return { r, walletId, requestId };
}

describe("pieces key and wallets", () => {
  it("GET /api/me answers the agreed shape", async () => {
    const h = harness();
    const alice = addUser(h);
    const a = app(h);
    let r = await a.inject({ method: "GET", url: "/api/me", headers: { cookie: alice.cookie } });
    expect(r.json()).toEqual({ accountId: "alice.near", piecesKey: "missing", wallets: [] });

    const set = await a.inject({ method: "POST", url: "/api/pieces-key", headers: { cookie: alice.cookie }, payload: piecesKeyProof(KEY, "alice.near", h.ctx.now()) });
    expect(set.json()).toEqual({ ok: true });
    await makeWallet(h, alice.cookie, "balance", 0x71);
    await makeWallet(h, alice.cookie, "piece:0", 0x72);
    r = await a.inject({ method: "GET", url: "/api/me", headers: { cookie: alice.cookie } });
    expect(r.json()).toEqual({
      accountId: "alice.near",
      piecesKey: "set",
      wallets: [
        { label: "balance", kind: "balance", ready: true },
        { label: "piece:0", kind: "piece", ready: true },
      ],
    });
    // nothing about the pieces key is read from the NEAR account
    expect(h.world.calls.filter((c) => JSON.stringify(c.body ?? "").includes("view_access_key"))).toEqual([]);
  });

  it("POST /api/pieces-key needs a fresh proof for this account signed by the key, and stores only the public key", async () => {
    const h = harness();
    const alice = addUser(h);
    const post = (payload: unknown) => app(h).inject({ method: "POST", url: "/api/pieces-key", headers: { cookie: alice.cookie }, payload: payload as object });
    const now = h.ctx.now();
    const good = piecesKeyProof(KEY, "alice.near", now);
    const other = keyFromMnemonic("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about");
    for (const [payload, why] of [
      [piecesKeyProof(KEY, "bob.near", now), "another account"],
      [piecesKeyProof(KEY, "alice.near", now - 6 * 60_000), "too old"],
      [{ ...good, publicKey: other.publicKeyStr }, "signed by another key"],
      [{ ...good, message: good.message + "0" }, "message changed"],
    ] as const) {
      const r = await post(payload);
      expect(r.statusCode, why).toBe(400);
      expect(r.json().error, why).toBe("pieces_key_unproven");
    }
    expect((await post({ ...good, publicKey: "secp256k1:abc" })).json().error).toBe("bad_request");
    expect(h.db.prepare("SELECT pieces_public_key FROM users").get()).toEqual({ pieces_public_key: null });
    expect((await post(good)).json()).toEqual({ ok: true });
    expect(h.db.prepare("SELECT pieces_public_key FROM users").get()).toEqual({ pieces_public_key: PK });
  });

  it("confirm proves the key, saves the wallet and answers its address", async () => {
    const h = harness();
    const alice = addUser(h);
    const bal = await makeWallet(h, alice.cookie, "balance", 0x71);
    expect(bal.r.json()).toEqual({ ok: true, label: "balance", address: "71".repeat(32) });
    const piece = await makeWallet(h, alice.cookie, "piece:0", 0x72);
    expect(piece.r.json()).toEqual({ ok: true, label: "piece:0", address: "0x" + "72".repeat(20) });
    const row = h.db.prepare("SELECT kind, shard_id, wallet_id, hl_address, policy_state, seed FROM pieces WHERE label = 'piece:0'").get() as any;
    expect(row).toMatchObject({ kind: "piece", wallet_id: piece.walletId, hl_address: "0x" + "72".repeat(20), policy_state: "none", seed: "unh-seed-114" });
    expect(row.shard_id).toMatch(/^[0-9a-f]{16}$/);
    // the proof is GET /wallet/v1/address?chain=near with the new key
    expect(h.world.calls.some((c) => c.path === "/wallet/v1/address?chain=near" && c.walletId === piece.walletId)).toBe(true);
    // and the OutLayer client now finds the key in the store
    expect(h.keystore.get(piece.walletId)).toMatch(/^wk_/);
  });

  it("confirm with a key that does not work is refused", async () => {
    const h = harness();
    const alice = addUser(h);
    const a = app(h);
    const k = await a.inject({ method: "POST", url: "/api/wallets/key", headers: { cookie: alice.cookie }, payload: { label: "piece:0" } });
    const r = await a.inject({
      method: "POST",
      url: "/api/wallets/confirm",
      headers: { cookie: alice.cookie },
      payload: { requestId: k.json().requestId, label: "piece:0", seed: "unh-seed" },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: "wallet_key_refused", message: "OutLayer did not accept our key for this wallet. Add the key to the wallet again, then confirm." });
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM pieces").get()).toEqual({ n: 0 });
  });

  it("a label of another user is refused, and the label must match the request", async () => {
    const h = harness();
    const alice = addUser(h, "alice.near");
    const bob = addUser(h, "bob.near");
    const a = app(h);
    const k = await a.inject({ method: "POST", url: "/api/wallets/key", headers: { cookie: bob.cookie }, payload: { label: "piece:0" } });
    const asAlice = await a.inject({
      method: "POST",
      url: "/api/wallets/confirm",
      headers: { cookie: alice.cookie },
      payload: { requestId: k.json().requestId, label: "piece:0", seed: "s" },
    });
    expect(asAlice.json().error).toBe("unknown_request");
    const wrongLabel = await a.inject({
      method: "POST",
      url: "/api/wallets/confirm",
      headers: { cookie: bob.cookie },
      payload: { requestId: k.json().requestId, label: "piece:1", seed: "s" },
    });
    expect(wrongLabel.json().error).toBe("bad_request");
    for (const label of ["piece:x", "balance2", "piece:01", ""]) {
      const r = await a.inject({ method: "POST", url: "/api/wallets/key", headers: { cookie: bob.cookie }, payload: { label } });
      expect(r.json().error, label).toBe("bad_request");
    }
  });

  it("every route needs a session", async () => {
    const h = harness();
    for (const [method, url] of [
      ["GET", "/api/me"],
      ["POST", "/api/pieces-key"],
      ["POST", "/api/wallets/key"],
      ["POST", "/api/wallets/confirm"],
      ["GET", "/api/balance"],
      ["POST", "/api/deposit/quote"],
      ["POST", "/api/plan"],
      ["POST", "/api/positions"],
      ["GET", "/api/positions"],
      ["POST", "/api/policy/confirm"],
      ["GET", "/api/guard/box-pub"],
      ["POST", "/api/home"],
      ["GET", "/api/alerts"],
    ] as const) {
      const r = await app(h).inject({ method, url, payload: method === "POST" ? {} : undefined, headers: { cookie: "sid=nope" } });
      expect(r.json().error, url).toBe("not_signed_in");
    }
  });

  it("GET /api/balance answers the private balance and each piece", async () => {
    const h = harness();
    const alice = addUser(h);
    addWallet(h, alice.userId, "balance", "none");
    const p = addWallet(h, alice.userId, "piece:0");
    h.world.privateUnits = 12_500_000n;
    h.world.setPerp(p.address, 14.68, 10.93);
    h.world.spot.set(p.address, "0.5");
    const r = await app(h).inject({ method: "GET", url: "/api/balance", headers: { cookie: alice.cookie } });
    const shard = (h.db.prepare("SELECT shard_id FROM pieces WHERE label = 'piece:0'").get() as { shard_id: string }).shard_id;
    expect(r.json()).toEqual({ privateUsdc: "12.5", pieces: [{ label: "piece:0", shard, perpUsd: "14.68", spotUsd: "0.5" }] });
    expect(reply("hl-spot").balances[0]).toHaveProperty("total");
  });
});

describe("carrying a signed key grant to OutLayer", () => {
  async function setup() {
    const h = harness();
    const alice = addUser(h);
    const a = app(h);
    await a.inject({ method: "POST", url: "/api/pieces-key", headers: { cookie: alice.cookie }, payload: piecesKeyProof(KEY, "alice.near", h.ctx.now()) });
    const k = (await a.inject({ method: "POST", url: "/api/wallets/key", headers: { cookie: alice.cookie }, payload: { label: "balance" } })).json();
    const grant = apiKeyBody(KEY, ownerAccount(KEY), "unh-seed-1", k.keyHash, h.ctx.now());
    return { h, alice, a, k, grant };
  }

  it("carries the user's own signed grant of the request's key, unchanged, with PUT", async () => {
    const { h, alice, a, k, grant } = await setup();
    const r = await a.inject({ method: "POST", url: "/api/wallets/grant", headers: { cookie: alice.cookie }, payload: { requestId: k.requestId, label: "balance", grant } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    expect(h.world.grants).toEqual([grant]);
    const call = h.world.calls.find((c) => c.path === "/wallet/v1/api-key");
    expect(call?.method).toBe("PUT");
  });

  it("refuses a grant of another key, another label, or signed by another pieces key", async () => {
    const { h, alice, a, k, grant } = await setup();
    const send = (payload: Record<string, unknown>) => a.inject({ method: "POST", url: "/api/wallets/grant", headers: { cookie: alice.cookie }, payload });
    expect((await send({ requestId: k.requestId, label: "balance", grant: { ...grant, key_hash: "ab".repeat(32) } })).statusCode).toBe(400);
    expect((await send({ requestId: k.requestId, label: "piece:0", grant })).statusCode).toBe(400);
    const other = keyFromMnemonic("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about");
    const otherGrant = apiKeyBody(other, ownerAccount(other), "unh-seed-1", k.keyHash, h.ctx.now());
    expect((await send({ requestId: k.requestId, label: "balance", grant: otherGrant })).statusCode).toBe(400);
    expect(h.world.grants).toEqual([]);
  });

  it("refuses another user's request like an unknown one", async () => {
    const { h, a, k, grant } = await setup();
    const bob = addUser(h, "bob.near");
    const r = await a.inject({ method: "POST", url: "/api/wallets/grant", headers: { cookie: bob.cookie }, payload: { requestId: k.requestId, label: "balance", grant } });
    expect(r.json().error).toBe("unknown_request");
    expect(h.world.grants).toEqual([]);
  });

  it("says so when OutLayer refuses the grant", async () => {
    const { h, alice, a, k, grant } = await setup();
    h.world.grantRefusal = { error: "invalid_signature", message: "bad signature" };
    const r = await a.inject({ method: "POST", url: "/api/wallets/grant", headers: { cookie: alice.cookie }, payload: { requestId: k.requestId, label: "balance", grant } });
    expect(r.json().error).toBe("wallet_key_refused");
  });
});
