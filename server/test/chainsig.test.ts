// Pieces controlled by NEAR Chain Signatures, end to end against a fake signer contract
// and a fake MPC network that sign the way the real ones do: the contract checks the
// piece key's ed25519 signature over the exact message and bumps the counter; the MPC
// network signs the EIP-712 digest with the key it derives for the piece's path.
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { base58 } from "@scure/base";
import {
  USDC_SPOT_TOKEN,
  actionDigest,
  chainSigMessage,
  chainSigPieceKey,
  ethAddress,
  keyFromMnemonic,
  recoverSigner,
  signPieceAction,
  type ChainSigAction,
} from "unhuntable-client";
import { ed25519 } from "@noble/curves/ed25519";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/index.js";
import { functionCallTx, readSecretKey, signTx } from "../src/relay.js";
import { testConfig } from "./helpers.js";
import { addUser, addWallet, harness, runFor, type Harness } from "./world.js";

const WORDS = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const CONTRACT = "unhuntable.test";
const ETH = { coin: "ETH", side: "long", notionalUsd: 30, leverage: 3, hiding: "normal" } as const;

// ------------------------------------------------------------ fake contract + MPC

function decodeAction(b: Uint8Array): { action: ChainSigAction; rest: Uint8Array } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 1;
  const s = () => {
    const n = dv.getUint32(o, true);
    const v = new TextDecoder().decode(b.subarray(o + 4, o + 4 + n));
    o += 4 + n;
    return v;
  };
  const u64 = () => {
    const v = Number(dv.getBigUint64(o, true));
    o += 8;
    return v;
  };
  let action: ChainSigAction;
  switch (b[0]) {
    case 0:
      action = { kind: "approveAgent", agentAddress: s(), agentName: s(), nonce: u64() };
      break;
    case 1: {
      const amount = s();
      const toPerp = b[o++] === 1;
      action = { kind: "usdClassTransfer", amount, toPerp, nonce: u64() };
      break;
    }
    case 4:
      action = { kind: "spotSend", destination: s(), token: s(), amount: s(), time: u64() };
      break;
    default:
      throw new Error(`fake contract: action tag ${b[0]}`);
  }
  return { action, rest: b.subarray(o) };
}

class FakeChain {
  counters = new Map<string, number>();
  calls: { method: string; args: Uint8Array }[] = [];
  refuse = false;

  mpcKey(path: string): Uint8Array {
    return sha256(new TextEncoder().encode(`mpc:${CONTRACT}:${path}`));
  }

  accountOf(keyHex: string): string {
    return ethAddress(secp256k1.getPublicKey(this.mpcKey("u1/" + keyHex), false));
  }

  /** NEAR view calls on the signer contract and v1.signer. */
  view = (params: any): unknown | undefined => {
    if (params.request_type !== "call_function") return undefined;
    const args = Buffer.from(params.args_base64, "base64");
    const out = (bytes: Uint8Array) => ({ jsonrpc: "2.0", id: "unhuntable", result: { result: [...bytes], logs: [], block_height: 1, block_hash: "x" } });
    if (params.account_id === CONTRACT) {
      const keyHex = bytesToHex(args.subarray(5, 37));
      if (params.method_name === "counter") {
        const c = this.counters.get(keyHex);
        if (c === undefined) return out(new Uint8Array([0]));
        const b = new Uint8Array(9);
        b[0] = 1;
        new DataView(b.buffer).setBigUint64(1, BigInt(c), true);
        return out(b);
      }
      if (params.method_name === "path") {
        const p = new TextEncoder().encode("u1/" + keyHex);
        const b = new Uint8Array(4 + p.length);
        new DataView(b.buffer).setUint32(0, p.length, true);
        b.set(p, 4);
        return out(b);
      }
    }
    if (params.account_id === "v1.signer" && params.method_name === "derived_public_key") {
      const a = JSON.parse(args.toString());
      expect(a.predecessor).toBe(CONTRACT);
      const pub = secp256k1.getPublicKey(this.mpcKey(a.path), false).subarray(1);
      return out(new TextEncoder().encode(JSON.stringify("secp256k1:" + base58.encode(pub))));
    }
    return undefined;
  };

  relay = {
    call: async (receiver: string, method: string, args: Uint8Array, gas: bigint, deposit: bigint) => {
      expect(receiver).toBe(CONTRACT);
      this.calls.push({ method, args });
      const keyBytes = args.subarray(5, 37);
      const keyHex = bytesToHex(keyBytes);
      if (method === "add_piece") {
        expect(deposit).toBeGreaterThan(0n);
        this.counters.set(keyHex, 0);
        return { txHash: "addtx", value: new Uint8Array() };
      }
      expect(method).toBe("sign");
      expect(gas).toBeGreaterThanOrEqual(50_000_000_000_000n);
      expect(deposit).toBe(1n);
      const counter = this.counters.get(keyHex);
      const { action, rest } = decodeAction(args.subarray(37));
      const sig = rest.subarray(4);
      const ok = counter !== undefined && ed25519.verify(sig, new TextEncoder().encode(chainSigMessage(CONTRACT, keyBytes, counter, action)), keyBytes);
      if (!ok || this.refuse) {
        const { RelayError } = await import("../src/relay.js");
        throw new RelayError("Smart contract panicked: the piece key did not sign this action", false, true);
      }
      this.counters.set(keyHex, counter! + 1);
      const s = secp256k1.sign(actionDigest(action), this.mpcKey("u1/" + keyHex));
      const R = (s.recovery ? "03" : "02") + s.r.toString(16).padStart(64, "0");
      const mpc = { scheme: "Secp256k1", big_r: { affine_point: R }, s: { scalar: s.s.toString(16).padStart(64, "0") }, recovery_id: s.recovery };
      return { txHash: `signtx${this.calls.length}`, value: new TextEncoder().encode(JSON.stringify(mpc)) };
    },
  };
}

interface S {
  h: Harness;
  app: ReturnType<typeof buildServer>;
  cookie: string;
  userId: string;
  chain: FakeChain;
}

function setup(balanceState: "none" | "locked" = "none"): S {
  const h = harness();
  const chain = new FakeChain();
  h.ctx.chainsig = { contract: CONTRACT, relay: chain.relay, chain: "Mainnet" };
  h.world.nearHook = chain.view;
  h.world.exchangeSigner = (body) => {
    if (!body.action?.signatureChainId) return undefined;
    const a = body.action;
    const act: ChainSigAction | null =
      a.type === "usdClassTransfer"
        ? { kind: "usdClassTransfer", amount: a.amount, toPerp: a.toPerp, nonce: a.nonce }
        : a.type === "spotSend"
          ? { kind: "spotSend", destination: a.destination, token: a.token, amount: a.amount, time: a.time }
          : a.type === "approveAgent"
            ? { kind: "approveAgent", agentAddress: a.agentAddress, agentName: a.agentName, nonce: a.nonce }
            : null;
    return act ? recoverSigner(actionDigest(act), body.signature) : undefined;
  };
  const alice = addUser(h);
  addWallet(h, alice.userId, "balance", balanceState);
  const app = buildServer({ config: testConfig(), db: h.db, now: h.ctx.now, money: h.ctx });
  return { h, app, cookie: alice.cookie, userId: alice.userId, chain };
}

async function post(s: S, url: string, payload: unknown = {}) {
  return s.app.inject({ method: "POST", url, headers: { cookie: s.cookie }, payload: payload as object });
}

const key = keyFromMnemonic(WORDS);

/** What the browser does for each chain-signature piece: register its key, check the action, sign it. */
async function browserSetup(s: S, labels: string[]) {
  const out = [];
  for (const label of labels) {
    const piece = chainSigPieceKey(key, Number(label.split(":")[1]));
    const r = await post(s, "/api/chainsig/register", { label, publicKey: piece.publicKeyStr });
    expect(r.statusCode, r.body).toBe(200);
    const reg = r.json();
    expect(reg.contract).toBe(CONTRACT);
    expect(reg.approve.action.kind).toBe("approveAgent");
    const sig = signPieceAction(piece, reg.contract, reg.approve.counter, reg.approve.action);
    const a = await post(s, "/api/chainsig/approve", { label, signature: bytesToHex(sig) });
    expect(a.statusCode, a.body).toBe(200);
    out.push({ label, piece, account: reg.account as string, approve: reg.approve });
  }
  return out;
}

function state(s: S, table: string, id: string): string {
  return (s.h.db.prepare(`SELECT state FROM ${table} WHERE id = ?`).get(id) as { state: string }).state;
}

// ------------------------------------------------------------ the relay's own transactions

describe("relay transactions", () => {
  it("match near-api-js byte for byte", () => {
    // Made with near-api-js 5.1.1: createTransaction + functionCall("sign", [1,2,3], 60 TGas, 1 yocto), signed.
    const secret = "ed25519:99eUso3aSbE9tqGSTXzo3TLfKb9RkMTURrHKQ1K7Zh3StnzFNUx8FKCPPPPpR479qsw5zv2WNBKmgiz7WqgAJfM";
    const k = readSecretKey(secret);
    const tx = functionCallTx({
      signerId: "relay.near",
      publicKey: k.publicKey,
      nonce: 42n,
      receiverId: "unhuntable.near",
      blockHash: new Uint8Array(32).fill(9),
      method: "sign",
      args: new Uint8Array([1, 2, 3]),
      gas: 60_000_000_000_000n,
      deposit: 1n,
    });
    const { signed, hash } = signTx(tx, k.secret);
    expect(hash).toBe("6qMiwExC3ddCAbFFjcqJA4jgUS6neaQBJUJ9TkXBUXvw");
    expect(bytesToHex(signed)).toBe(
      "0a00000072656c61792e6e65617200ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c2a000000000000000f000000756e68756e7461626c652e6e65617209090909090909090909090909090909090909090909090909090909090909090100000002040000007369676e0300000001020300c0afd69136000001000000000000000000000000000000007ea292b26abaa1ce554ca98955c44c0eacbd60a68f0d3be74edf407cd3e8ee16fd564fda2a0aafad47bfd6ced73c653ab0a82eec128889136d37793c4b385a07",
    );
  });

  it("refuses a key whose halves do not match", () => {
    const raw = base58.decode("99eUso3aSbE9tqGSTXzo3TLfKb9RkMTURrHKQ1K7Zh3StnzFNUx8FKCPPPPpR479qsw5zv2WNBKmgiz7WqgAJfM");
    raw[40] ^= 1;
    expect(() => readSecretKey("ed25519:" + base58.encode(raw))).toThrow(/does not match/);
  });
});

// ------------------------------------------------------------ opening a position

describe("a position on chain-signature pieces", () => {
  it("asks the browser for piece keys, not OutLayer wallets, then funds, approves through NEAR and opens", async () => {
    const s = setup();
    const created = (await post(s, "/api/positions", ETH)).json();
    expect(created.needWallets).toEqual([]);
    expect(created.needChainSig).toEqual(["piece:0"]);
    const id = created.positionId;

    const [p] = await browserSetup(s, created.needChainSig);
    // the account is the one NEAR's MPC network derives for this contract and piece key
    expect(p.account).toBe(s.chain.accountOf(bytesToHex(p.piece.publicKey)));
    expect(s.chain.calls.map((c) => c.method)).toEqual(["add_piece"]);
    const agent = s.h.db.prepare("SELECT agent, control, piece_key, hl_address, policy_state FROM pieces WHERE label = 'piece:0'").get() as any;
    expect(agent).toEqual({ agent: null, control: "near", piece_key: bytesToHex(p.piece.publicKey), hl_address: p.account, policy_state: "locked" });

    const cont = (await post(s, `/api/positions/${id}/continue`)).json();
    expect(cont).toMatchObject({ state: "funding", needWallets: [], needChainSig: [] });
    await runFor(s.h, 1_300_000);
    // funded and approved; the only lock left is the private balance, whose list now holds the NEAR-controlled account
    expect(state(s, "positions", id)).toBe("policy_wait");
    const batch = (await post(s, `/api/positions/${id}/continue`)).json().policyBatch;
    expect(batch.summary).toEqual(["Update your private balance: it can only send to your 1 piece and to your own addresses (alice.near)."]);
    const enc = s.h.world.calls.filter((c) => c.path === "/wallet/v1/encrypt-policy").at(-1)!;
    expect(enc.body.rules.addresses.list).toContain(p.account);
    expect((await post(s, "/api/policy/confirm", { positionId: id, txHashes: ["t"] })).statusCode).toBe(200);
    await runFor(s.h, 1_300_000);
    expect(state(s, "positions", id)).toBe("open");
    // funded from the private balance straight to the NEAR-controlled account
    const w = s.h.world.calls.find((c) => c.path === "/wallet/v1/confidential/withdraw")!;
    expect(w.body.to).toBe(p.account);
    // NEAR signed the approval the piece key made, and Hyperliquid got it from that account
    expect(s.chain.calls.map((c) => c.method)).toEqual(["add_piece", "sign"]);
    const ex = s.h.world.calls.find((c) => c.host === "hl.test" && c.path === "/exchange" && c.body.action.type === "approveAgent")!;
    expect(ex.body.action.agentAddress).toBe(p.approve.action.agentAddress);
    expect(s.h.world.exchangeSigner!(ex.body)).toBe(p.account);
    const row = s.h.db.prepare("SELECT agent FROM pieces WHERE label = 'piece:0'").get() as any;
    expect(row.agent).toBe(p.approve.action.agentAddress);
    const req = s.h.db.prepare("SELECT state, near_tx FROM chainsig_requests").get() as any;
    expect(req).toEqual({ state: "done", near_tx: "signtx2" });
    // OutLayer never signed anything for this piece: there is no OutLayer wallet
    expect(s.h.world.calls.filter((c) => c.path === "/wallet/v1/evm/sign-typed-data")).toEqual([]);
  });

  it("refuses a signature that is not the piece key's, and a key of another label", async () => {
    const s = setup();
    const created = (await post(s, "/api/positions", ETH)).json();
    const piece = chainSigPieceKey(key, 0);
    const reg = (await post(s, "/api/chainsig/register", { label: "piece:0", publicKey: piece.publicKeyStr })).json();
    const other = chainSigPieceKey(key, 7);
    const bad = await post(s, "/api/chainsig/approve", { label: "piece:0", signature: bytesToHex(signPieceAction(other, CONTRACT, reg.approve.counter, reg.approve.action)) });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error).toBe("bad_signature");
    const changed = { ...reg.approve.action, agentAddress: "0x" + "99".repeat(20) };
    const bad2 = await post(s, "/api/chainsig/approve", { label: "piece:0", signature: bytesToHex(signPieceAction(piece, CONTRACT, reg.approve.counter, changed)) });
    expect(bad2.json().error).toBe("bad_signature");
    // a second key for the same label is refused
    expect((await post(s, "/api/chainsig/register", { label: "piece:0", publicKey: other.publicKeyStr })).json().error).toBe("bad_request");
    expect((await post(s, `/api/positions/${created.positionId}/continue`)).json().needChainSig).toEqual(["piece:0"]);
  });

  it("an approval the contract refuses is marked failed and the browser is asked again", async () => {
    const s = setup("locked");
    const created = (await post(s, "/api/positions", ETH)).json();
    await browserSetup(s, created.needChainSig);
    s.chain.refuse = true;
    const c = (await post(s, `/api/positions/${created.positionId}/continue`)).json();
    if (c.policyBatch) await post(s, "/api/policy/confirm", { positionId: created.positionId, txHashes: ["t"] });
    await runFor(s.h, 600_000);
    const req = s.h.db.prepare("SELECT state FROM chainsig_requests").get() as any;
    expect(req.state).toBe("failed");
    expect((await post(s, `/api/positions/${created.positionId}/continue`)).json().needChainSig).toEqual(["piece:0"]);
  });
});

// ------------------------------------------------------------ going home

/** A chain-signature piece that is set up and holds money on Hyperliquid. */
function nearPiece(s: S, n: number, perp: number) {
  const piece = chainSigPieceKey(key, n);
  const keyHex = bytesToHex(piece.publicKey);
  const account = s.chain.accountOf(keyHex);
  s.chain.counters.set(keyHex, 1);
  s.h.db
    .prepare(
      `INSERT INTO pieces (id, user_id, label, kind, shard_id, control, piece_key, hl_address, hl_master, agent, policy_state, created_ms, network)
       VALUES (?, ?, ?, 'piece', ?, 'near', ?, ?, ?, ?, 'locked', 1, 'mainnet')`,
    )
    .run(`p${n}`, s.userId, `piece:${n}`, (n + 1).toString(16).padStart(16, "0"), keyHex, account, account, "0x" + "55".repeat(20));
  s.h.world.setPerp(account, perp, perp);
  return { piece, account };
}

const DEPOSIT = "0x" + "d0".repeat(20);

/** What the browser does: a deposit address it got from OutLayer itself, and the piece key's signatures. */
function signHome(plan: any, piece: ReturnType<typeof chainSigPieceKey>, t: number, dest = DEPOSIT) {
  const signed = [];
  let c = plan.counter;
  if (plan.toSpot !== "0") {
    const a: ChainSigAction = { kind: "usdClassTransfer", amount: plan.toSpot, toPerp: false, nonce: t };
    signed.push({ counter: c, action: a, signature: bytesToHex(signPieceAction(piece, CONTRACT, c++, a)) });
  }
  const send: ChainSigAction = { kind: "spotSend", destination: dest, token: USDC_SPOT_TOKEN, amount: plan.send, time: t + 1 };
  signed.push({ counter: c, action: send, signature: bytesToHex(signPieceAction(piece, CONTRACT, c, send)) });
  return { label: plan.label, signed };
}

describe("going home with chain-signature pieces", () => {
  it("takes no unlock: the browser signs, we relay, the money arrives, and there is nothing to lock again", async () => {
    const s = setup("locked");
    const { piece, account } = nearPiece(s, 0, 12.5);
    s.h.world.privateUnits = 0n;
    const start = (await post(s, "/api/home", {})).json();
    expect(start.unlockBatch).toBeNull();
    expect(start.chainSig).toEqual([{ label: "piece:0", account, counter: 1, toSpot: "12.5", send: "11.5" }]);
    const status = (await s.app.inject({ method: "GET", url: `/api/home/${start.homeId}`, headers: { cookie: s.cookie } })).json();
    expect(status).toMatchObject({ state: "unlock_wait", needChainSig: true });

    const r = await post(s, `/api/home/${start.homeId}/chainsig`, { pieces: [signHome(start.chainSig[0], piece, s.h.clock.t)] });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().state).toBe("moving");
    await runFor(s.h, 120_000);

    expect(state(s, "homes", start.homeId)).toBe("done");
    const posted = s.h.world.calls.filter((c) => c.host === "hl.test" && c.path === "/exchange").map((c) => c.body);
    expect(posted.map((b) => b.action.type)).toEqual(["usdClassTransfer", "spotSend"]);
    expect(posted.map((b) => s.h.world.exchangeSigner!(b))).toEqual([account, account]);
    expect(posted[1].action.destination).toBe(DEPOSIT);
    expect(s.h.world.privateUnits).toBe(11_500_000n);
    const steps = (await s.app.inject({ method: "GET", url: `/api/home/${start.homeId}`, headers: { cookie: s.cookie } })).json().steps.map((x: any) => `${x.step}:${x.status}`);
    expect(steps).toEqual(["to_spot:done", "send:done", "arrive:done"]);
    // OutLayer was asked for nothing on the piece's behalf
    expect(s.h.world.calls.filter((c) => c.path === "/wallet/v1/evm/sign-typed-data" || c.path === "/wallet/v1/encrypt-policy")).toEqual([]);
  });

  it("takes only perps -> spot then a USDC send, at the next counters, signed by the piece key", async () => {
    const s = setup("locked");
    const { piece } = nearPiece(s, 0, 12.5);
    const start = (await post(s, "/api/home", {})).json();
    const plan = start.chainSig[0];
    const url = `/api/home/${start.homeId}/chainsig`;
    const t = s.h.clock.t;

    // perps -> spot must come first and must not go back to perps
    const toPerp: ChainSigAction = { kind: "usdClassTransfer", amount: "12.5", toPerp: true, nonce: t };
    expect((await post(s, url, { pieces: [{ label: "piece:0", signed: [{ counter: 1, action: toPerp, signature: bytesToHex(signPieceAction(piece, CONTRACT, 1, toPerp)) }, signHome(plan, piece, t).signed[1]] }] })).json().error).toBe("bad_request");
    // a token other than USDC
    const other: ChainSigAction = { kind: "spotSend", destination: DEPOSIT, token: "PURR:0xc1fb593aeffbeb02f85e0308e9956a90", amount: "11.5", time: t };
    expect((await post(s, url, { pieces: [{ label: "piece:0", signed: [{ counter: 1, action: other, signature: bytesToHex(signPieceAction(piece, CONTRACT, 1, other)) }] }] })).json().error).toBe("bad_request");
    // a counter that is not the piece's next one
    const good = signHome(plan, piece, t);
    const skewed = { label: "piece:0", signed: good.signed.map((x) => ({ ...x, counter: x.counter + 1 })) };
    expect((await post(s, url, { pieces: [skewed] })).json().error).toBe("bad_request");
    // a signature by another key
    const thief = chainSigPieceKey(key, 9);
    expect((await post(s, url, { pieces: [signHome(plan, thief, t)] })).json().error).toBe("bad_signature");
    // nothing was kept and nothing moved
    expect(s.h.db.prepare("SELECT COUNT(*) AS n FROM chainsig_requests").get()).toEqual({ n: 0 });
    expect(state(s, "homes", start.homeId)).toBe("unlock_wait");
  });

  it("a piece with open size or too little money is not signed for", async () => {
    const s = setup("locked");
    nearPiece(s, 0, 2);
    const start = (await post(s, "/api/home", {})).json();
    expect(start.chainSig[0].send).toBeNull();
    // nothing to sign, so moving starts at once and the piece is skipped with its reason
    await runFor(s.h, 30_000);
    expect(state(s, "homes", start.homeId)).toBe("done");
  });
});

// The fake contract's message check is the client's chainSigMessage; the real contract's
// check is pinned to the same text by client/test/chainsig.test.ts (piece C on mainnet).
it("the fake MPC network's account is a real secp256k1 address", () => {
  const c = new FakeChain();
  expect(c.accountOf("00".repeat(32))).toMatch(/^0x[0-9a-f]{40}$/);
  expect(hexToBytes(c.accountOf("00".repeat(32)).slice(2))).toHaveLength(20);
});
