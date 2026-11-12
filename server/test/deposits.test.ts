import { USDC_NEAR } from "unhuntable-client";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/index.js";
import { testConfig } from "./helpers.js";
import { addUser, addWallet, harness, reply, runFor, type Harness } from "./world.js";

function setup() {
  const h = harness();
  const alice = addUser(h);
  const bal = addWallet(h, alice.userId, "balance", "none");
  const app = buildServer({ config: testConfig(), db: h.db, now: h.ctx.now, money: h.ctx });
  return { h, alice, bal, app };
}

async function status(s: { app: any; alice: { cookie: string } }, id: string) {
  return (await s.app.inject({ method: "GET", url: `/api/deposit/${id}`, headers: { cookie: s.alice.cookie } })).json();
}

function alerts(h: Harness): string[] {
  return (h.db.prepare("SELECT text FROM alerts ORDER BY created_ms, rowid").all() as { text: string }[]).map((r) => r.text);
}

describe("deposit route near", () => {
  it("asks OutLayer for a cross-chain confidential deposit on the balance wallet and polls until done", async () => {
    const s = setup();
    const r = await s.app.inject({
      method: "POST",
      url: "/api/deposit/quote",
      headers: { cookie: s.alice.cookie },
      payload: { route: "near", chain: "base", token: "USDC", amount: "25", refundTo: "0x" + "12".repeat(20) },
    });
    expect(r.statusCode).toBe(200);
    const q = r.json();
    expect(q).toEqual({
      id: q.id,
      depositAddress: "0x3333333333333333333333333333333333333333",
      amountIn: "25",
      amountOut: "24.68",
      feeUsd: "0.32",
      ourFeeBps: 0,
      expiresMs: Date.parse("2030-01-01T00:00:00.000Z"),
      minAmount: "2",
    });
    const call = s.h.world.calls.find((c) => c.path === "/wallet/v1/confidential/deposit/cross-chain")!;
    expect(call.walletId).toBe(s.bal.walletId);
    expect(call.body).toEqual({ chain: "base", token: "USDC", amount: "25000000" });

    expect(await status(s, q.id)).toEqual({ id: q.id, status: "waiting", amountIn: "25", amountOut: "24.68" });
    await runFor(s.h, 30_000);
    expect((await status(s, q.id)).status).toBe("waiting");
    s.h.world.privateUnits += 24_680_000n;
    await runFor(s.h, 15_000);
    expect((await status(s, q.id)).status).toBe("done");
    // polling stops once done
    const polls = s.h.world.calls.length;
    await runFor(s.h, 60_000);
    expect(s.h.world.calls.length).toBe(polls);
  });

  it("NEAR from a NEAR wallet goes to OutLayer as wNEAR, with 24 decimals", async () => {
    const s = setup();
    const r = await s.app.inject({
      method: "POST",
      url: "/api/deposit/quote",
      headers: { cookie: s.alice.cookie },
      payload: { route: "near", chain: "near", token: "NEAR", amount: "20", refundTo: "alice.near" },
    });
    expect(r.statusCode).toBe(200);
    const call = s.h.world.calls.find((c) => c.path === "/wallet/v1/confidential/deposit/cross-chain")!;
    expect(call.body).toEqual({ chain: "near", token: "wNEAR", amount: "20" + "0".repeat(24) });
  });

  it("below the minimum is refused with the minimum", async () => {
    const s = setup();
    const small = await s.app.inject({
      method: "POST",
      url: "/api/deposit/quote",
      headers: { cookie: s.alice.cookie },
      payload: { route: "near", chain: "base", token: "USDC", amount: "1.5", refundTo: "alice.near" },
    });
    expect(small.statusCode).toBe(422);
    expect(small.json()).toEqual({ error: "deposit_below_min", message: "The smallest deposit for this route is 2 USDC." });
    s.h.world.depositStatus = 400;
    const low = await s.app.inject({
      method: "POST",
      url: "/api/deposit/quote",
      headers: { cookie: s.alice.cookie },
      payload: { route: "near", chain: "base", token: "USDC", amount: "3", refundTo: "alice.near" },
    });
    expect(low.json().error).toBe("deposit_below_min");
  });
});

describe("refund address", () => {
  it("must be on the chain the money comes from, with a sentence that says so", async () => {
    const s = setup();
    const ask = (route: string, chain: string, token: string, refundTo: string) =>
      s.app.inject({ method: "POST", url: "/api/deposit/quote", headers: { cookie: s.alice.cookie }, payload: { route, chain, token, amount: "25.5", refundTo } });
    const r = await ask("aurora", "base", "USDC", "jennycruzy.near");
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("refund_wrong_chain");
    expect(r.json().message).toContain("on Base");
    expect((await ask("aurora", "sol", "USDC", "0x" + "12".repeat(20))).json().error).toBe("refund_wrong_chain");
    expect((await ask("near", "near", "USDC", "Jenny Cruzy!")).json().error).toBe("refund_wrong_chain");
    expect(s.h.world.ofHost("oneclick.test")).toHaveLength(0);
  });
});

describe("deposit route aurora", () => {
  it("quotes with confidentiality advanced, our 6 bps fee, refund to refundTo; status waiting -> seen -> done", async () => {
    const s = setup();
    const r = await s.app.inject({
      method: "POST",
      url: "/api/deposit/quote",
      headers: { cookie: s.alice.cookie },
      payload: { route: "aurora", chain: "base", token: "nep141:base-usdc.omft.near", amount: "50", refundTo: "0x" + "12".repeat(20) },
    });
    expect(r.statusCode).toBe(200);
    const q = r.json();
    expect(q).toEqual({
      id: q.id,
      depositAddress: "0x4444444444444444444444444444444444444444",
      amountIn: "50.0",
      amountOut: "49.95",
      feeUsd: "0.05",
      ourFeeBps: 6,
      expiresMs: Date.parse("2030-01-01T00:30:00.000Z"),
      minAmount: "1",
    });
    const sent = s.h.world.ofHost("oneclick.test")[0];
    expect(sent.path).toBe("/v0/quote");
    expect(sent.body).toMatchObject({
      dry: false,
      swapType: "EXACT_INPUT",
      originAsset: "nep141:base-usdc.omft.near",
      depositType: "ORIGIN_CHAIN",
      destinationAsset: USDC_NEAR,
      amount: "50000000",
      refundTo: "0x" + "12".repeat(20),
      refundType: "ORIGIN_CHAIN",
      recipient: s.h.world.wallets.get(s.bal.walletId)!.near,
      recipientType: "CONFIDENTIAL_INTENTS",
      confidentiality: "advanced",
      appFees: [{ recipient: "fees.near", fee: 6 }],
    });

    expect((await status(s, q.id)).status).toBe("waiting");
    await runFor(s.h, 15_000);
    expect((await status(s, q.id)).status).toBe("waiting");
    s.h.world.ocStatus = "KNOWN_DEPOSIT_TX";
    await runFor(s.h, 15_000);
    expect((await status(s, q.id)).status).toBe("seen");
    s.h.world.ocStatus = "PROCESSING";
    await runFor(s.h, 15_000);
    expect((await status(s, q.id)).status).toBe("seen");
    s.h.world.ocStatus = "SUCCESS";
    await runFor(s.h, 15_000);
    expect((await status(s, q.id)).status).toBe("done");
    const statusCalls = s.h.world.ofHost("oneclick.test").filter((c) => c.path.startsWith("/v0/status"));
    expect(statusCalls[0].path).toBe("/v0/status?depositAddress=0x4444444444444444444444444444444444444444");
    // polled every 15 s
    expect(statusCalls.length).toBe(4);
  });

  it("the token names the page shows are sent to 1Click as asset ids; an unknown one is refused", async () => {
    const s = setup();
    const cases: [string, string, string][] = [
      ["base", "USDC", "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near"],
      ["arb", "USDT", "nep141:arb-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9.omft.near"],
      ["sol", "SOL", "nep141:sol.omft.near"],
      ["eth", "ETH", "nep141:eth.omft.near"],
    ];
    for (const [chain, token, asset] of cases) {
      const r = await s.app.inject({
        method: "POST",
        url: "/api/deposit/quote",
        headers: { cookie: s.alice.cookie },
        payload: { route: "aurora", chain, token, amount: "50", refundTo: chain === "sol" ? "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin" : "0x" + "12".repeat(20) },
      });
      expect(r.statusCode).toBe(200);
      const sent = s.h.world.ofHost("oneclick.test").filter((c) => c.path === "/v0/quote").at(-1)!;
      expect((sent.body as { originAsset: string }).originAsset).toBe(asset);
    }
    const before = s.h.world.ofHost("oneclick.test").length;
    const bad = await s.app.inject({
      method: "POST",
      url: "/api/deposit/quote",
      headers: { cookie: s.alice.cookie },
      payload: { route: "aurora", chain: "base", token: "DOGE", amount: "50", refundTo: "0x" + "12".repeat(20) },
    });
    expect(bad.statusCode).toBe(400);
    expect(s.h.world.ofHost("oneclick.test").length).toBe(before);
  });

  it("an expired quote ends as expired with quote_expired", async () => {
    const s = setup();
    s.h.world.ocQuote = reply("oc-quote");
    s.h.world.ocQuote.quote.deadline = new Date(s.h.clock.t + 60_000).toISOString();
    const q = (
      await s.app.inject({
        method: "POST",
        url: "/api/deposit/quote",
        headers: { cookie: s.alice.cookie },
        payload: { route: "aurora", chain: "base", token: "nep141:base-usdc.omft.near", amount: "50", refundTo: "0x" + "12".repeat(20) },
      })
    ).json();
    await runFor(s.h, 90_000);
    expect((await status(s, q.id)).status).toBe("expired");
    expect(alerts(s.h)).toContain("That quote expired. Get a new one.");
  });

  it("below the route's minimum is refused with the amount", async () => {
    const s = setup();
    s.h.world.ocQuote = reply("oc-quote-too-low");
    s.h.world.ocQuoteStatus = 400;
    const r = await s.app.inject({
      method: "POST",
      url: "/api/deposit/quote",
      headers: { cookie: s.alice.cookie },
      payload: { route: "aurora", chain: "base", token: "nep141:base-usdc.omft.near", amount: "0.5", refundTo: "0x" + "12".repeat(20) },
    });
    expect(r.json()).toEqual({ error: "deposit_below_min", message: "The smallest deposit for this route is 1 USDC." });
  });

  it("a deposit of another user is not found", async () => {
    const s = setup();
    const bob = addUser(s.h, "bob.near");
    const q = (
      await s.app.inject({
        method: "POST",
        url: "/api/deposit/quote",
        headers: { cookie: s.alice.cookie },
        payload: { route: "near", chain: "base", token: "USDC", amount: "25", refundTo: "alice.near" },
      })
    ).json();
    const r = await s.app.inject({ method: "GET", url: `/api/deposit/${q.id}`, headers: { cookie: bob.cookie } });
    expect(r.json().error).toBe("not_found");
  });
});
