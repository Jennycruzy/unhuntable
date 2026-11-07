import { describe, expect, it } from "vitest";
import { balancePolicy, buildBatch, piecePolicy, readBack, STORE_DEPOSIT, STORE_GAS, walletAccount } from "../src/policy.js";
import { walletByLabel } from "../src/ctx.js";
import { ApiError } from "../src/refusals.js";
import { addUser, addWallet, harness } from "./world.js";

const ADDR_ONE = "0x1111111111111111111111111111111111111111";
const ADDR_TWO = "0x2222222222222222222222222222222222222222";
const HASH = "11".repeat(32);
const OWN = "ab".repeat(32);

describe("policy JSON", () => {
  it("a piece's policy is exactly the agreed rule", () => {
    expect(piecePolicy({ evmAddress: ADDR_ONE.toUpperCase().replace("0X", "0x"), owner: "alice.near", walletAccount: OWN, keyHash: HASH })).toEqual({
      rules: {
        addresses: { mode: "whitelist", list: [ADDR_ONE, "alice.near", OWN] },
        transaction_types: ["transfer", "call", "intents_withdraw", "intents_swap", "cross_chain_withdraw", "confidential"],
      },
      capabilities: {
        confidential: { allowed: true },
        swap: { allowed: true },
        cross_chain_withdraw: { allowed: true },
        evm_sign: { allowed: false },
        solana_sign: { allowed: false },
      },
      authorized_key_hashes: [HASH],
    });
    const p = piecePolicy({ evmAddress: ADDR_ONE, owner: "alice.near", walletAccount: OWN, keyHash: HASH });
    expect(JSON.stringify(p)).toMatchInlineSnapshot(
      `"{"rules":{"addresses":{"mode":"whitelist","list":["0x1111111111111111111111111111111111111111","alice.near","abababababababababababababababababababababababababababababababab"]},"transaction_types":["transfer","call","intents_withdraw","intents_swap","cross_chain_withdraw","confidential"]},"capabilities":{"confidential":{"allowed":true},"swap":{"allowed":true},"cross_chain_withdraw":{"allowed":true},"evm_sign":{"allowed":false},"solana_sign":{"allowed":false}},"authorized_key_hashes":["1111111111111111111111111111111111111111111111111111111111111111"]}"`,
    );
    // confidential is in both the types and the capabilities
    expect(p.rules.transaction_types).toContain("confidential");
    expect(p.capabilities.confidential.allowed).toBe(true);
    expect(piecePolicy({ evmAddress: ADDR_ONE, owner: "alice.near", walletAccount: OWN, keyHash: HASH, evmSign: true }).capabilities.evm_sign.allowed).toBe(true);
  });

  it("the private balance lists every piece and the owner's exit addresses, with evm_sign off", () => {
    const p = balancePolicy({ pieceAddresses: [ADDR_ONE, ADDR_TWO, ADDR_ONE], exitAddresses: ["alice.near"], walletAccount: OWN, keyHash: HASH });
    expect(p.rules.addresses.list).toEqual([ADDR_ONE, ADDR_TWO, "alice.near", OWN]);
    expect(p.capabilities.evm_sign.allowed).toBe(false);
    expect(p.authorized_key_hashes).toEqual([HASH]);
  });
});

describe("the wallet's own account", () => {
  // A private swap pays out to the wallet itself; OutLayer refuses it unless that account is on the whitelist.
  it("is on every whitelist, so private swaps are allowed", () => {
    expect(piecePolicy({ evmAddress: ADDR_ONE, owner: "alice.near", walletAccount: OWN, keyHash: HASH }).rules.addresses.list).toContain(OWN);
    expect(balancePolicy({ pieceAddresses: [ADDR_ONE], exitAddresses: [], walletAccount: OWN, keyHash: HASH }).rules.addresses.list).toContain(OWN);
  });

  it("is read from OutLayer's hex form and from base58", () => {
    expect(walletAccount("ed25519:" + OWN)).toBe(OWN);
    // ed25519:11111111111111111111111111111111 is 32 zero bytes in base58
    expect(walletAccount("ed25519:11111111111111111111111111111111")).toBe("00".repeat(32));
  });

  it("refuses a missing or malformed key", () => {
    for (const bad of [null, "", "secp256k1:" + OWN, "ed25519:", "ed25519:0OIl", "ed25519:" + "ab".repeat(31)]) {
      expect(() => walletAccount(bad)).toThrow(ApiError);
    }
  });
});

describe("policy batch", () => {
  it("has one store_wallet_policy transaction and one sentence per wallet", async () => {
    const h = harness();
    const { userId } = addUser(h);
    const p0 = addWallet(h, userId, "piece:0", "none");
    const p1 = addWallet(h, userId, "piece:1", "none");
    const items = [p0, p1].map((p, i) => ({
      wallet: walletByLabel(h.ctx, userId, `piece:${i}`)!,
      policy: piecePolicy({ evmAddress: p.address, owner: "alice.near", walletAccount: walletAccount(p.pubkey), keyHash: p.keyHash }),
      sentence: `Lock piece Account ${i + 1}: it can only send to its own Hyperliquid account and to alice.near. Our server cannot sign for it.`,
    }));
    const batch = await buildBatch(h.ctx, "alice.near", items);
    expect(batch.summary).toEqual([
      "Lock piece Account 1: it can only send to its own Hyperliquid account and to alice.near. Our server cannot sign for it.",
      "Lock piece Account 2: it can only send to its own Hyperliquid account and to alice.near. Our server cannot sign for it.",
    ]);
    expect(batch.transactions).toHaveLength(2);
    expect(batch.transactions[0]).toEqual({
      receiverId: "outlayer.near",
      actions: [
        {
          type: "FunctionCall",
          params: {
            methodName: "store_wallet_policy",
            args: { wallet_pubkey: p0.pubkey, encrypted_data: "ZW5jcnlwdGVkLXBvbGljeS1ieXRlcw==", wallet_signature: "c2lnbmVkLXBvbGljeS1ieXRlcw==", storage_refund_to: "alice.near" },
            gas: STORE_GAS,
            deposit: STORE_DEPOSIT,
          },
        },
      ],
    });
    // the policy went to encrypt-policy as built; sign-policy names the owner as caller
    const enc = h.world.calls.filter((c) => c.path === "/wallet/v1/encrypt-policy");
    expect(enc.map((c) => c.body)).toEqual(items.map((i) => i.policy));
    const sign = h.world.calls.filter((c) => c.path === "/wallet/v1/sign-policy");
    expect(sign.map((c) => c.body.caller)).toEqual(["alice.near", "alice.near"]);
  });

  it("read back: wrong owner and evm_sign on are refused", async () => {
    const h = harness();
    const { userId } = addUser(h);
    const p = addWallet(h, userId, "piece:0", "none");
    const w = walletByLabel(h.ctx, userId, "piece:0")!;
    await expect(readBack(h.ctx, "alice.near", w, false)).resolves.toBeUndefined();
    const get = h.world.calls.find((c) => c.host === "near.test" && c.body.params.request_type === "call_function")!;
    expect(get.body.params).toMatchObject({ account_id: "outlayer.near", method_name: "get_wallet_policy" });
    expect(JSON.parse(Buffer.from(get.body.params.args_base64, "base64").toString())).toEqual({ wallet_pubkey: p.pubkey });

    h.world.policyOwner = "bob.near";
    await expect(readBack(h.ctx, "alice.near", w, false)).rejects.toMatchObject({ code: "policy_owner_wrong" });
    h.world.policyOwner = "alice.near";
    h.world.evmOn.add(p.walletId);
    const e = await readBack(h.ctx, "alice.near", w, false).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.code).toBe("policy_not_set");
    await expect(readBack(h.ctx, "alice.near", w, true)).resolves.toBeUndefined();
  });
});
