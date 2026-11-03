import { describe, expect, it } from "vitest";
import { createLogger } from "../src/log.js";
import { OutLayerWallet, OutLayerWalletError, guardClient } from "../src/outlayer.js";
import { PAYMENT_KEY, WALLET_ID, WALLET_KEY, fakeFetch, fixture, logSink, testConfig } from "./helpers.js";

const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const TO = "0x1234567890abcdef1234567890abcdef12345678";

function wallet(answers: Array<{ status?: number; body: unknown }>) {
  const f = fakeFetch(answers);
  const sink = logSink();
  let n = 0;
  const w = new OutLayerWallet({
    baseUrl: "https://outlayer.test/",
    walletKeys: { [WALLET_ID]: WALLET_KEY },
    fetch: f.fetch,
    uuid: () => `00000000-0000-4000-8000-0000000000a${n++}`,
    log: createLogger({ level: "debug", destination: sink }),
  });
  return { w, sent: f.sent, sink };
}

async function failure(p: Promise<unknown>): Promise<OutLayerWalletError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof OutLayerWalletError) return e;
    throw e;
  }
  throw new Error("expected an error");
}

describe("OutLayer client fixtures", () => {
  it("address", async () => {
    const { w, sent } = wallet([{ body: fixture("address-base") }]);
    expect(await w.address(WALLET_ID, "base")).toEqual({
      walletId: WALLET_ID,
      chain: "base",
      address: TO,
      publicKey: "secp256k1:02" + "ab".repeat(32),
      assetAccountId: null,
      executorAccountId: null,
    });
    expect(sent[0]).toMatchObject({ method: "GET", url: "https://outlayer.test/wallet/v1/address?chain=base" });
    expect(sent[0].headers["x-idempotency-key"]).toBeUndefined();
  });

  it("balance", async () => {
    const { w } = wallet([{ body: fixture("balance") }]);
    expect(await w.balance(WALLET_ID)).toEqual({ balances: [{ token: USDC, balance: "1000000" }], accountId: "22".repeat(32) });
  });

  it("withdraw dry run, withdraw and request status", async () => {
    const { w, sent } = wallet([{ body: fixture("withdraw-dry-run") }, { body: fixture("withdraw") }, { body: fixture("request") }]);
    const body = { chain: "hypercore", to: TO, amount: "1680000", token: USDC };
    expect(await w.withdrawDryRun(WALLET_ID, body)).toEqual({ amountOut: "167902800", minAmountOut: "165913700", timeEstimateSeconds: 20 });
    const sub = await w.withdraw(WALLET_ID, body);
    expect(sub).toEqual({
      requestId: "00000000-0000-4000-8000-000000000002",
      status: "pending_deposit",
      intentHash: "3vQB7B6MrGQZaxCuFg4oh4DT4sXMLvL3DC3fA7x9yvy1",
      depositAddress: "22".repeat(32),
    });
    const st = await w.request(WALLET_ID, sub.requestId);
    expect(st).toMatchObject({ requestId: sub.requestId, type: "confidential_withdraw", status: "success" });
    expect(st.result).toMatchObject({ amount: "3000000", recipient: TO, submitted: true, amountOut: "267883100", confidential: true, originAsset: USDC });
    expect(st.result?.swapDetails).toEqual({ amountIn: "3000000", amountOut: "267883100", intentHashes: ["3vQB7B6MrGQZaxCuFg4oh4DT4sXMLvL3DC3fA7x9yvy1"] });
    expect(sent.map((s) => [s.method, s.url.replace("https://outlayer.test", "")])).toEqual([
      ["POST", "/wallet/v1/confidential/withdraw/dry-run"],
      ["POST", "/wallet/v1/confidential/withdraw"],
      ["GET", `/wallet/v1/requests/${sub.requestId}`],
    ]);
    expect(sent[0].body).toEqual(body);
    // every POST has its own idempotency key
    expect(sent[0].headers["x-idempotency-key"]).toBe("00000000-0000-4000-8000-0000000000a0");
    expect(sent[1].headers["x-idempotency-key"]).toBe("00000000-0000-4000-8000-0000000000a1");
  });

  it("swap quote and swap", async () => {
    const { w, sent } = wallet([{ body: fixture("swap-quote") }, { body: fixture("swap") }]);
    const b = { tokenIn: USDC, tokenOut: "nep141:wrap.near", amountIn: "1000000" };
    expect((await w.swapQuote(WALLET_ID, b)).amountOut).toBe("77860529997836065573769");
    expect((await w.swap(WALLET_ID, b)).status).toBe("pending_deposit");
    expect(sent[0].body).toEqual({ token_in: USDC, token_out: "nep141:wrap.near", amount_in: "1000000" });
  });

  it("cross-chain deposit", async () => {
    const { w } = wallet([{ body: fixture("deposit-cross-chain") }]);
    expect(await w.depositCrossChain(WALLET_ID, { chain: "base", token: "USDC", amount: "200000000" })).toEqual({
      intentId: "00000000-0000-4000-8000-000000000003",
      depositAddress: TO,
      amount: "200000000",
      amountOut: "1799848",
      minAmountOut: "1781849",
      expiresAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("policy", async () => {
    const { w } = wallet([{ body: fixture("policy") }]);
    const p = await w.policy(WALLET_ID);
    expect(p).toMatchObject({ walletId: WALLET_ID, frozen: false, policy: "stored", approval: null });
    expect(p.rules?.addresses).toEqual({ mode: "whitelist", list: [TO] });
    expect(p.capabilities.evm_sign.allowed).toBe(false);
    expect(p.authorizedKeyHashes).toHaveLength(1);
  });

  it("sign typed data", async () => {
    const { w, sent } = wallet([{ body: fixture("sign-typed-data") }]);
    const td = { domain: { name: "x" }, types: {}, primaryType: "X", message: {} };
    expect(await w.signTypedData(WALLET_ID, "arbitrum", td)).toEqual({ signature: "0x" + "11".repeat(65), chain: "arbitrum", walletId: WALLET_ID });
    expect(sent[0].body).toEqual({ chain: "arbitrum", typed_data: td });
  });
});

describe("OutLayer error mapping", () => {
  const cases: Array<[string, string, string, string | undefined]> = [
    ["address-hypercore-refused", "unsupported_chain", "Unsupported chain: hypercore", undefined],
    ["withdraw-dry-run-not-whitelisted", "policy_denied", `Address '${TO}' is not in whitelist`, "policy_denied"],
    ["withdraw-dry-run-too-low", "upstream_rejected", "Amount is too low for the destination chain", undefined],
    ["withdraw-dry-run-type-not-allowed", "policy_denied", "Transaction type 'confidential' is not allowed by policy", "policy_denied"],
    ["deposit-cross-chain-unsupported-token", "unsupported_token", "Token is not carried on this chain. That chain carries: USDC, wNEAR. Pick one of those.", undefined],
    ["deposit-cross-chain-too-low", "upstream_rejected", "Amount is too low", undefined],
    ["sign-typed-data-locked", "policy_denied", "EVM signing is not enabled by policy (set capabilities.evm_sign.allowed = true)", "policy_denied"],
  ];
  for (const [name, code, message, refusal] of cases) {
    it(name, async () => {
      for (const status of [400, 403, 200]) {
        const { w } = wallet([{ status, body: fixture(name) }]);
        const e = await failure(w.withdrawDryRun(WALLET_ID, { chain: "hypercore", to: TO, amount: "1", token: USDC }));
        expect(e.code).toBe(code);
        expect(e.message).toBe(message);
        expect(e.refusal).toBe(refusal);
        expect(e.status).toBe(status);
      }
    });
  }

  it("bad status, bad JSON, wrong shape, unknown wallet and no answer", async () => {
    expect((await failure(wallet([{ status: 502, body: "<html>" }]).w.balance(WALLET_ID))).code).toBe("http_error");
    expect((await failure(wallet([{ status: 500, body: { what: 1 } }]).w.balance(WALLET_ID))).code).toBe("http_error");
    expect((await failure(wallet([{ body: "not json" }]).w.balance(WALLET_ID))).code).toBe("bad_reply");
    expect((await failure(wallet([{ body: fixture("withdraw") }]).w.balance(WALLET_ID))).code).toBe("bad_reply");
    const none = wallet([]);
    expect((await failure(none.w.balance("other-wallet"))).code).toBe("unknown_wallet");
    expect(none.sent).toHaveLength(0);
    expect((await failure(none.w.balance(WALLET_ID))).code).toBe("unreachable");
  });
});

describe("API key handling", () => {
  it("goes only into the Authorization header and never into logs", async () => {
    const { w, sent, sink } = wallet([
      { body: fixture("balance") },
      { body: fixture("withdraw") },
      { status: 403, body: fixture("withdraw-dry-run-not-whitelisted") },
    ]);
    await w.balance(WALLET_ID);
    await w.withdraw(WALLET_ID, { chain: "near", to: "alice.near", amount: "1", token: USDC });
    await failure(w.withdrawDryRun(WALLET_ID, { chain: "near", to: "alice.near", amount: "1", token: USDC }));
    for (const s of sent) {
      expect(s.headers.authorization).toBe(`Bearer ${WALLET_KEY}`);
      const rest = JSON.stringify({ url: s.url, body: s.body, headers: { ...s.headers, authorization: undefined } });
      expect(rest).not.toContain(WALLET_KEY);
    }
    expect(sink.lines.length).toBeGreaterThanOrEqual(3);
    expect(sink.text()).not.toContain(WALLET_KEY);
    expect(sink.text()).not.toContain("22".repeat(16));
  });
});

describe("guard calls through the shared client", () => {
  it("pays with the configured payment key at the configured OutLayer URL", async () => {
    const { fetch, sent } = fakeFetch([{ body: { output: { hl_address: "0xab" } } }]);
    const g = guardClient(testConfig(), { owner: "alice.near", project: "guard", fetch });
    expect(await g.addr()).toEqual({ hl_address: "0xab" });
    expect(sent[0].url).toBe("https://outlayer.test/call/alice.near/guard");
    expect(sent[0].headers["x-payment-key"]).toBe(PAYMENT_KEY);
  });
});
