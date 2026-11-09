import { secp256k1 } from "@noble/curves/secp256k1";
import { ed25519 } from "@noble/curves/ed25519";
import { hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import { base58 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { chainSigMessage, chainSigPieceKey, ethAddress, type ChainSigAction } from "unhuntable-client/chainsig";
import { keyFromMnemonic } from "unhuntable-client/keys";
import { Api } from "../lib/api";
import { setupChainSigPiece, signHomeAll, usdcUnits8 } from "../lib/chainsig";
import { scriptedFetch } from "./helpers";

const WORDS = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const key = keyFromMnemonic(WORDS);
const piece0 = chainSigPieceKey(key, 0);
const MPC_PRIV = new Uint8Array(32).fill(0x42);
const DERIVED = "secp256k1:" + base58.encode(secp256k1.getPublicKey(MPC_PRIV, false).subarray(1));
const ACCOUNT = ethAddress(secp256k1.getPublicKey(MPC_PRIV, false));
const AGENT = "0x" + "54".repeat(20);
const APPROVE: ChainSigAction = { kind: "approveAgent", agentAddress: AGENT, agentName: "", nonce: 1800000000000 };

/** NEAR RPC's answer to v1.signer derived_public_key. */
const rpcDerived = { body: { jsonrpc: "2.0", result: { result: [...utf8ToBytes(JSON.stringify(DERIVED))] } } };

function signedOk(body: string, counter: number, action: ChainSigAction): boolean {
  const sig = JSON.parse(body).signature;
  return ed25519.verify(hexToBytes(sig), utf8ToBytes(chainSigMessage("unhuntable.near", piece0.publicKey, counter, action)), piece0.publicKey);
}

describe("setting up a NEAR-controlled piece", () => {
  it("checks the account with NEAR itself, then signs only the agent approval", async () => {
    const f = scriptedFetch([
      ["POST /api/chainsig/register", { body: { label: "piece:0", account: ACCOUNT, contract: "unhuntable.near", approve: { counter: 0, action: APPROVE } } }],
      ["POST fastnear.com", (s) => {
        const p = JSON.parse(s.body).params;
        expect(p.account_id).toBe("v1.signer");
        expect(JSON.parse(atob(p.args_base64))).toEqual({ path: "u1/" + Buffer.from(piece0.publicKey).toString("hex"), predecessor: "unhuntable.near", domain_id: 0 });
        return rpcDerived;
      }],
      ["POST /api/chainsig/approve", (s) => {
        expect(signedOk(s.body, 0, APPROVE)).toBe(true);
        return { body: { ok: true, label: "piece:0" } };
      }],
    ]);
    const api = new Api(f.fetch, "https://api.test");
    expect(await setupChainSigPiece({ api, key, account: "alice.near", outlayerFetch: f.fetch }, "piece:0")).toBe(ACCOUNT);
    // the server only ever saw the public key
    expect(JSON.parse(f.sent[0].body)).toEqual({ label: "piece:0", publicKey: piece0.publicKeyStr });
    expect(f.sent.map((s) => s.body).join(" ")).not.toContain(Buffer.from(piece0.secret).toString("hex"));
  });

  it("refuses another contract, an account NEAR did not derive, and anything but an agent approval", async () => {
    const cases: [object, RegExp][] = [
      [{ label: "piece:0", account: ACCOUNT, contract: "evil.near", approve: { counter: 0, action: APPROVE } }, /signs only for unhuntable.near/],
      [{ label: "piece:0", account: "0x" + "66".repeat(20), contract: "unhuntable.near", approve: { counter: 0, action: APPROVE } }, /not the one NEAR derives/],
      [
        { label: "piece:0", account: ACCOUNT, contract: "unhuntable.near", approve: { counter: 0, action: { kind: "withdraw", destination: AGENT, amount: "10", time: 1 } } },
        /not an agent approval/,
      ],
    ];
    for (const [reply, err] of cases) {
      const f = scriptedFetch([
        ["POST /api/chainsig/register", { body: reply }],
        ["POST fastnear.com", rpcDerived],
      ]);
      const api = new Api(f.fetch, "https://api.test");
      await expect(setupChainSigPiece({ api, key, account: "alice.near", outlayerFetch: f.fetch }, "piece:0")).rejects.toThrow(err);
      expect(f.sent.some((s) => s.url.includes("/api/chainsig/approve"))).toBe(false);
    }
  });
});

describe("a NEAR-controlled piece for a trade.xyz stock", () => {
  const MOVE: ChainSigAction = { kind: "sendAsset", destination: ACCOUNT, sourceDex: "", destinationDex: "xyz", token: "USDC:0x6d1e7cde53ba9467b783cb7c530ce054", amount: "11", nonce: 1800000000001 };

  it("also signs moving its own USDC onto trade.xyz, right after the approval", async () => {
    const f = scriptedFetch([
      ["POST /api/chainsig/register", { body: { label: "piece:0", account: ACCOUNT, contract: "unhuntable.near", approve: { counter: 0, action: APPROVE }, move: { counter: 1, action: MOVE } } }],
      ["POST fastnear.com", rpcDerived],
      ["POST /api/chainsig/approve", (s) => {
        const b = JSON.parse(s.body);
        expect(signedOk(s.body, 0, APPROVE)).toBe(true);
        expect(ed25519.verify(hexToBytes(b.moveSignature), utf8ToBytes(chainSigMessage("unhuntable.near", piece0.publicKey, 1, MOVE)), piece0.publicKey)).toBe(true);
        return { body: { ok: true, label: "piece:0" } };
      }],
    ]);
    const api = new Api(f.fetch, "https://api.test");
    expect(await setupChainSigPiece({ api, key, account: "alice.near", outlayerFetch: f.fetch }, "piece:0")).toBe(ACCOUNT);
  });

  it("a piece already set up signs just the move", async () => {
    const f = scriptedFetch([
      ["POST /api/chainsig/register", { body: { label: "piece:0", account: ACCOUNT, contract: "unhuntable.near", approve: null, move: { counter: 4, action: MOVE } } }],
      ["POST fastnear.com", rpcDerived],
      ["POST /api/chainsig/approve", (s) => {
        const b = JSON.parse(s.body);
        expect(b.signature).toBeUndefined();
        expect(ed25519.verify(hexToBytes(b.moveSignature), utf8ToBytes(chainSigMessage("unhuntable.near", piece0.publicKey, 4, MOVE)), piece0.publicKey)).toBe(true);
        return { body: { ok: true, label: "piece:0" } };
      }],
    ]);
    const api = new Api(f.fetch, "https://api.test");
    await setupChainSigPiece({ api, key, account: "alice.near", outlayerFetch: f.fetch }, "piece:0");
  });

  it("refuses a move to anyone else, to another market list, or out of order", async () => {
    const bad: [ChainSigAction, number][] = [
      [{ ...MOVE, destination: "0x" + "66".repeat(20) } as ChainSigAction, 1],
      [{ ...MOVE, destinationDex: "flx" } as ChainSigAction, 1],
      [{ ...MOVE, sourceDex: "xyz", destinationDex: "" } as ChainSigAction, 1],
      [{ ...MOVE, amount: "5000" } as ChainSigAction, 1],
      [{ kind: "spotSend", destination: ACCOUNT, token: "USDC:0x6d1e7cde53ba9467b783cb7c530ce054", amount: "11", time: 1 }, 1],
      [MOVE, 3],
    ];
    for (const [action, counter] of bad) {
      const f = scriptedFetch([
        ["POST /api/chainsig/register", { body: { label: "piece:0", account: ACCOUNT, contract: "unhuntable.near", approve: { counter: 0, action: APPROVE }, move: { counter, action } } }],
        ["POST fastnear.com", rpcDerived],
      ]);
      const api = new Api(f.fetch, "https://api.test");
      await expect(setupChainSigPiece({ api, key, account: "alice.near", outlayerFetch: f.fetch }, "piece:0")).rejects.toThrow(/not a move of this piece's own USDC/);
      expect(f.sent.some((s) => s.url.includes("/api/chainsig/approve"))).toBe(false);
    }
  });

  it("going home, moves trade.xyz back to the piece's own main balance first", async () => {
    const DEP = "0x" + "d0".repeat(20);
    const f = scriptedFetch([
      ["POST fastnear.com", rpcDerived],
      ["POST /wallet/v1/confidential/deposit/cross-chain", { body: { deposit_address: DEP } }],
      ["POST /api/home/h1/chainsig", (s) => {
        const signed = JSON.parse(s.body).pieces[0].signed;
        expect(signed.map((x: any) => [x.action.kind, x.counter])).toEqual([
          ["sendAsset", 3],
          ["usdClassTransfer", 4],
          ["spotSend", 5],
        ]);
        expect(signed[0].action).toMatchObject({ destination: ACCOUNT, sourceDex: "xyz", destinationDex: "", amount: "12" });
        return { body: { ok: true, state: "moving" } };
      }],
    ]);
    const api = new Api(f.fetch, "https://api.test");
    const start = { homeId: "h1", feeUsd: "1.20", unlockBatch: null, chainSig: [{ label: "piece:0", account: ACCOUNT, counter: 3, fromXyz: "12", toSpot: "12.5", send: "11.5" }] };
    expect(await signHomeAll({ api, key, account: "alice.near", outlayerFetch: f.fetch, now: () => 1800000000000 }, start)).toBe(1);
  });
});

describe("going home from a NEAR-controlled piece", () => {
  it("sends only to a deposit address this page asked OutLayer for, with the piece key", async () => {
    const DEP = "0x" + "d0".repeat(20);
    const f = scriptedFetch([
      ["POST fastnear.com", rpcDerived],
      ["POST /wallet/v1/confidential/deposit/cross-chain", (s) => {
        expect(s.url).toContain("api.outlayer.ai");
        expect(s.headers.authorization).toMatch(/^Bearer near:/);
        expect(JSON.parse(s.body)).toEqual({ chain: "hypercore", token: "USDC", amount: "1150000000" });
        return { body: { deposit_address: DEP } };
      }],
      ["POST /api/home/h1/chainsig", (s) => {
        const b = JSON.parse(s.body);
        const [toSpot, send] = b.pieces[0].signed;
        expect(toSpot.action).toEqual({ kind: "usdClassTransfer", amount: "12.5", toPerp: false, nonce: 1800000000000 });
        expect(send.action.destination).toBe(DEP);
        expect(send.action.amount).toBe("11.5");
        expect([toSpot.counter, send.counter]).toEqual([3, 4]);
        expect(ed25519.verify(hexToBytes(send.signature), utf8ToBytes(chainSigMessage("unhuntable.near", piece0.publicKey, 4, send.action)), piece0.publicKey)).toBe(true);
        return { body: { ok: true, state: "moving" } };
      }],
    ]);
    const api = new Api(f.fetch, "https://api.test");
    const start = { homeId: "h1", feeUsd: "1.20", unlockBatch: null, chainSig: [{ label: "piece:0", account: ACCOUNT, counter: 3, toSpot: "12.5", send: "11.5" }] };
    expect(await signHomeAll({ api, key, account: "alice.near", outlayerFetch: f.fetch, now: () => 1800000000000 }, start)).toBe(1);
  });

  it("signs nothing for a piece whose account is not NEAR's, or that has nothing to send", async () => {
    const f = scriptedFetch([["POST fastnear.com", rpcDerived]]);
    const api = new Api(f.fetch, "https://api.test");
    const bad = { homeId: "h1", feeUsd: "1.20", unlockBatch: null, chainSig: [{ label: "piece:0", account: "0x" + "77".repeat(20), counter: 0, toSpot: "0", send: "5" }] };
    await expect(signHomeAll({ api, key, account: "alice.near", outlayerFetch: f.fetch }, bad)).rejects.toThrow(/not the one NEAR derives/);
    const none = { homeId: "h1", feeUsd: "1.20", unlockBatch: null, chainSig: [{ label: "piece:0", account: ACCOUNT, counter: 0, toSpot: "0", send: null }] };
    expect(await signHomeAll({ api, key, account: "alice.near", outlayerFetch: scriptedFetch([]).fetch }, none)).toBe(0);
  });

  it("writes USDC amounts in Hyperliquid's 8 decimals", () => {
    expect(usdcUnits8("11.5")).toBe("1150000000");
    expect(usdcUnits8("2")).toBe("200000000");
    expect(() => usdcUnits8("1e3")).toThrow();
  });
});
