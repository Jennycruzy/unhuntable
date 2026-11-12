import { describe, expect, it } from "vitest";
import { keyFromMnemonic, seedFor } from "unhuntable-client/keys";
import { Api } from "../lib/api";
import { approveBatch, checkTrade, openPosition, reviewRows } from "../lib/trade";
import type { PlanAnswer, PolicyBatch } from "../lib/types";
import { loadRecord } from "../lib/vault";
import { scriptedFetch, testWallet } from "./helpers";

const WORDS = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const key = keyFromMnemonic(WORDS);
const REQ = { coin: "ETH", side: "long", notionalUsd: 300, leverage: 3, hiding: "whale" } as const;

const PLAN: PlanAnswer = {
  plan: {
    coin: "ETH",
    side: "long",
    leverage: 3,
    openLeverage: 3,
    xyzMoveUsd: null,
    totalSize: 0.0912,
    pieces: [
      { index: 0, size: 0.0456, notionalUsd: 150.25, fundingUsd: 75, entryOffsetMs: 130000, reserveUsd: 12.5 },
      { index: 1, size: 0.0456, notionalUsd: 149.75, fundingUsd: 75, entryOffsetMs: 410000, reserveUsd: 12.5 },
    ],
    totalFundingUsd: 150,
    estFeesUsd: 0.27,
    vrfHex: "ab".repeat(32),
  },
  feesUsd: "0.93",
  exitFeeUsd: "2.40",
  world: [
    { name: "Account 1", sizeUsd: "150.25", side: "long" },
    { name: "Account 2", sizeUsd: "149.75", side: "long" },
  ],
  newPiecesNeeded: 2,
};

const BATCH: PolicyBatch = {
  summary: ["Piece 1: lock it so it can only trade.", "Piece 2: the same."],
  transactions: [
    { receiverId: "outlayer.near", actions: [{ type: "FunctionCall", params: { methodName: "store_wallet_policy", args: { a: 1 }, gas: "30000000000000", deposit: "0" } }] },
    { receiverId: "outlayer.near", actions: [{ type: "FunctionCall", params: { methodName: "store_wallet_policy", args: { a: 2 }, gas: "30000000000000", deposit: "1" } }] },
  ],
};

function walletRoutes(label: string, n: number): [string, { status?: number; body: unknown }][] {
  return [
    ["GET /wallet/v1/address", { status: 404, body: { error: "not_found", message: "no such wallet" } }],
    ["POST /register", { body: { wallet_id: `w${n}`, near_account_id: `w${n}.near` } }],
    ["POST /api/wallets/key", { body: { requestId: `r${n}`, keyHash: String(n).repeat(64) } }],
    ["POST /api/wallets/grant", { body: { ok: true } }],
    ["POST /api/wallets/confirm", { body: { ok: true, label, address: `0x${String(n).repeat(40)}` } }],
  ];
}

describe("trade", () => {
  it("review shows the plan's numbers unchanged", () => {
    const r = reviewRows(PLAN);
    expect(r.count).toBe(2);
    expect(r.pieces).toEqual([
      { n: 1, size: "0.0456", notional: "150.25", funding: "75" },
      { n: 2, size: "0.0456", notional: "149.75", funding: "75" },
    ]);
    expect(r.feesUsd).toBe("0.93");
    expect(r.exitFeeUsd).toBe("2.40");
    expect(r.builderFee).toBeNull();
    expect(reviewRows({ ...PLAN, builderFee: { rate: "0.01%", usd: "0.0300" } }).builderFee).toEqual({ rate: "0.01%", usd: "0.0300" });
  });

  it("checks the form before asking the server", () => {
    expect(checkTrade(REQ)).toBeUndefined();
    expect(checkTrade({ ...REQ, leverage: 11 })).toBe("Leverage is a whole number from 1 to 10.");
    expect(checkTrade({ ...REQ, notionalUsd: 0 })).toBe("Enter a size in USD.");
    expect(checkTrade({ ...REQ, coin: "xyz:NVDA" })).toBeUndefined();
    expect(checkTrade({ ...REQ, coin: "xyz:JIO" })).toBe("Pick a market.");
  });

  it("confirm with 2 new pieces makes 2 wallets, then continues", async () => {
    const { fetch, sent, left } = scriptedFetch([
      ["POST /api/positions", { body: { positionId: "p1", state: "funding", needWallets: ["piece:0", "piece:1"], policyBatch: null } }],
      ...walletRoutes("piece:0", 1),
      ...walletRoutes("piece:1", 2),
      ["POST /api/positions/p1/continue", { body: { positionId: "p1", state: "policy_wait", needWallets: [], policyBatch: BATCH } }],
    ]);
    const api = new Api(fetch, "");
    const a = await openPosition({ api, wallet: testWallet().wallet, key, account: "carol.near", outlayerFetch: fetch }, REQ);
    expect(left).toHaveLength(0);
    expect(a.policyBatch).toEqual(BATCH);
    const order = sent.map((s) => `${s.method} ${new URL(s.url, "http://x").pathname}`);
    expect(order).toEqual([
      "POST /api/positions",
      "GET /wallet/v1/address",
      "POST /register",
      "POST /api/wallets/key",
      "POST /api/wallets/grant",
      "POST /api/wallets/confirm",
      "GET /wallet/v1/address",
      "POST /register",
      "POST /api/wallets/key",
      "POST /api/wallets/grant",
      "POST /api/wallets/confirm",
      "POST /api/positions/p1/continue",
    ]);
    const confirms = sent.filter((s) => s.url.endsWith("/api/wallets/confirm")).map((s) => JSON.parse(s.body));
    expect(confirms).toEqual([
      { requestId: "r1", label: "piece:0", seed: seedFor(key, "piece:0") },
      { requestId: "r2", label: "piece:1", seed: seedFor(key, "piece:1") },
    ]);
    const grants = sent.filter((s) => s.url.endsWith("/api/wallets/grant")).map((s) => JSON.parse(s.body));
    expect(grants.map((g) => [g.requestId, g.label, g.grant.seed, g.grant.pubkey])).toEqual([
      ["r1", "piece:0", seedFor(key, "piece:0"), key.publicKeyStr],
      ["r2", "piece:1", seedFor(key, "piece:1"), key.publicKeyStr],
    ]);
    expect(JSON.parse(sent[0].body)).toEqual(REQ);
    expect((await loadRecord("carol.near")).addresses).toEqual({ "piece:0": "0x" + "1".repeat(40), "piece:1": "0x" + "2".repeat(40) });
  });

  it("sends the policy batch in one wallet call with the transactions unchanged", async () => {
    const { fetch, sent } = scriptedFetch([["POST /api/policy/confirm", { body: { ok: true, locked: ["piece:0", "piece:1"], unlocked: [] } }]]);
    const { wallet, calls } = testWallet();
    const before = JSON.stringify(BATCH);
    await approveBatch(new Api(fetch, ""), wallet, BATCH, { positionId: "p1" });
    expect(calls).toHaveLength(1);
    expect(calls[0].kind).toBe("signAndSendTransactions");
    expect(calls[0].arg).toBe(BATCH.transactions);
    expect(JSON.stringify(BATCH)).toBe(before);
    expect(JSON.parse(sent[0].body)).toEqual({ positionId: "p1", txHashes: ["hash1", "hash2"] });
  });
});
