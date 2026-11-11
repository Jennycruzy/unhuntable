import { encodePaymentSignatureHeader } from "@x402/core/http";
import { keyFromSecret } from "unhuntable-client";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/index.js";
import { bothPaywalls, nearPaywall, pingRoute, usdcUnits } from "../src/x402.js";
import { testConfig } from "./helpers.js";
import { addUser, addWallet, harness } from "./world.js";

const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const offer = (network: string, asset: string) => ({
  scheme: "exact",
  network,
  amount: "",
  asset,
  payTo: "",
  maxTimeoutSeconds: 300,
  extra: { assetTransferMethod: "near-intents", paymentFlow: "upfront", destination: { network: "near:mainnet", asset: USDC, amount: "200000", recipient: "unhuntable.near" } },
});
const OFFERS = [offer("near:mainnet", "nep141:wrap.near"), offer("eip155:8453", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913")];
/** Ping's real list is about 200 offers; most are tokens nobody pays an API call with. */
const MANY = [...Array.from({ length: 200 }, (_, i) => offer("eip155:1", "0x" + i.toString(16).padStart(40, "0"))), ...OFFERS];

/** PingPay's Agent Pay facilitator, as its middleware talks to it. No network. */
function fakePing(over: { settle?: object; execute?: boolean; offersDown?: boolean } = {}) {
  const asked: { path: string; key: string | null; body: any }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const key = new Headers(init?.headers).get("x-api-key");
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    asked.push({ path: u.pathname + u.search, key, body });
    const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status });
    if (u.pathname.endsWith("/offers")) return over.offersDown ? json({ error: "down" }, 503) : json({ x402Version: 2, accepts: MANY });
    if (u.pathname.endsWith("/verify"))
      return json({ isValid: true, extra: { depositAddress: "0xdeposit", amountIn: "201234", refundDeadline: "2026-11-12T00:00:00.000Z", operationToken: "op-1" } });
    if (u.pathname.endsWith("/settle")) return json(over.settle ?? { success: true, transaction: "NearTx111", network: "near:mainnet", payer: "0xagent" });
    if (u.pathname.endsWith("/execution")) return json({ execute: over.execute ?? true });
    throw new Error(url);
  }) as typeof fetch;
  return { f, asked };
}

async function setup(ping: ReturnType<typeof fakePing>, withNear = true) {
  const relay = keyFromSecret(new Uint8Array(32).fill(7));
  const near = withNear
    ? await nearPaywall({ payTo: "unhuntable.near", price: "0.002", network: "near:mainnet", relayAccount: "relay.near", relayKey: relay.secretKeyStr, rpcUrl: "https://near.invalid" })
    : undefined;
  const paywall = bothPaywalls(near, pingRoute({ apiKey: "ping-key", price: "0.2", base: "https://ping.test", fetch: ping.f }), { payTo: "unhuntable.near", network: "near:mainnet" })!;
  const h = harness();
  const alice = addUser(h);
  addWallet(h, alice.userId, "balance", "none");
  const app = buildServer({ config: testConfig(), db: h.db, now: h.ctx.now, money: h.ctx, paywall });
  const { key } = (
    await app.inject({ method: "POST", url: "/api/agents", headers: { cookie: alice.cookie }, payload: { name: "bot", maxNotionalUsd: 50, coins: ["ETH"], dailyOpens: 1 } })
  ).json();
  const call = (sig?: string) => app.inject({ method: "GET", url: "/api/agent/positions", headers: { authorization: `Bearer ${key}`, ...(sig ? { "payment-signature": sig } : {}) } });
  const calls = () => h.db.prepare("SELECT op, result, paid_tx, payer, price FROM agent_calls").all();
  return { app, call, calls, cookie: alice.cookie };
}

const decode = (h: unknown) => JSON.parse(Buffer.from(String(h), "base64").toString("utf8"));
const sig = (accepted: object, payload: object) => encodePaymentSignatureHeader({ x402Version: 2, accepted, payload } as any);

describe("PingPay as a second way for agents to pay", () => {
  it("offers both ways in one challenge: USDC on NEAR first, then Ping's origins", async () => {
    const ping = fakePing();
    const s = await setup(ping);
    const r = await s.call();
    expect(r.statusCode).toBe(402);
    expect(r.json()).toMatchObject({ error: "payment_required" });
    const challenge = decode(r.headers["payment-required"]);
    expect(challenge.accepts).toHaveLength(3);
    expect(challenge.accepts[0]).toMatchObject({ network: "near:mainnet", amount: "2000", payTo: "unhuntable.near" });
    // only the listed main assets, in the list's order: Ping's other ~200 would not fit in a header
    expect(challenge.accepts.slice(1).map((a: any) => `${a.network} ${a.asset}`)).toEqual(["near:mainnet nep141:wrap.near", "eip155:8453 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"]);
    expect(String(r.headers["payment-required"]).length).toBeLessThan(8 * 1024);
    expect(challenge.accepts[1].extra.destination).toMatchObject({ amount: "200000", recipient: "unhuntable.near" });
    // offers are asked for 0.2 USDC in USDC units, with our key
    expect(ping.asked[0]).toMatchObject({ path: "/agentpay/x402/offers?amountOut=200000", key: "ping-key" });
    expect(s.calls()).toEqual([]);
  });

  it("a quote payload gets the deposit address and amount back, and nothing runs", async () => {
    const ping = fakePing();
    const s = await setup(ping);
    const r = await s.call(sig(OFFERS[0]!, { type: "quote", refundTo: "agent.near" }));
    expect(r.statusCode).toBe(402);
    expect(r.json().error).toBe("payment_required");
    const quoted = decode(r.headers["payment-required"]).accepts;
    expect(quoted).toHaveLength(1);
    expect(quoted[0]).toMatchObject({ payTo: "0xdeposit", amount: "201234", extra: { operationToken: "op-1", assetTransferMethod: "near-intents", paymentFlow: "upfront" } });
    const verify = ping.asked.find((a) => a.path.endsWith("/verify"))!;
    expect(verify.key).toBe("ping-key");
    expect(verify.body).toMatchObject({ x402Version: 2, paymentPayload: { payload: { type: "quote", refundTo: "agent.near" } }, paymentRequirements: { asset: "nep141:wrap.near" } });
    expect(s.calls()).toEqual([]);
  });

  it("a settled deposit pays for exactly one call, recorded with Ping's NEAR transaction", async () => {
    const ping = fakePing();
    const s = await setup(ping);
    const quoted = { ...OFFERS[0], payTo: "0xdeposit", amount: "201234", extra: { ...OFFERS[0]!.extra, operationToken: "op-1" } };
    const r = await s.call(sig(quoted, { type: "deposit", operationToken: "op-1", depositAddress: "0xdeposit", txHash: "originTx" }));
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().paid).toEqual({ tx: "NearTx111", price: "0.2" });
    expect(decode(r.headers["payment-response"])).toMatchObject({ success: true, transaction: "NearTx111" });
    expect(ping.asked.find((a) => a.path.endsWith("/execution"))!.body).toEqual({ depositAddress: "0xdeposit" });
    expect(s.calls()).toEqual([{ op: "status", result: "ok", paid_tx: "NearTx111", payer: "0xagent", price: "0.2" }]);
  });

  it("while 1Click is still settling, the agent is told to try again and nothing runs", async () => {
    const s = await setup(fakePing({ settle: { success: false, errorReason: "settlement_pending" } }));
    const r = await s.call(sig(OFFERS[0]!, { type: "deposit", operationToken: "op-1", depositAddress: "0xdeposit", txHash: "originTx" }));
    expect(r.statusCode).toBe(402);
    expect(r.json()).toMatchObject({ error: "payment_settling", errorReason: "settlement_pending" });
    expect(s.calls()).toEqual([]);
  });

  it("a deposit that already paid for a call cannot pay for another", async () => {
    const s = await setup(fakePing({ execute: false }));
    const r = await s.call(sig(OFFERS[0]!, { type: "deposit", operationToken: "op-1", depositAddress: "0xdeposit", txHash: "originTx" }));
    expect(r.statusCode).toBe(402);
    expect(r.json().error).toBe("payment_failed");
    expect(s.calls()).toEqual([]);
  });

  it("when Ping is down, the NEAR way still works", async () => {
    const s = await setup(fakePing({ offersDown: true }));
    const r = await s.call();
    expect(r.statusCode).toBe(402);
    expect(decode(r.headers["payment-required"]).accepts).toHaveLength(1);
  });

  it("runs with Ping alone too", async () => {
    const s = await setup(fakePing(), false);
    const r = await s.call();
    expect(decode(r.headers["payment-required"]).accepts).toHaveLength(2);
  });

  it("the agents page lists both ways and their prices", async () => {
    const s = await setup(fakePing());
    const list = (await s.app.inject({ method: "GET", url: "/api/agents", headers: { cookie: s.cookie } })).json();
    expect(list.routes).toEqual([
      { name: "near", price: "0.002" },
      { name: "pingpay", price: "0.2" },
    ]);
  });

  it("refuses a Ping price under its 0.2 USDC minimum, and counts USDC units exactly", () => {
    expect(() => pingRoute({ apiKey: "k", price: "0.1" })).toThrow(/at least 0.2/);
    expect(usdcUnits("0.2")).toBe("200000");
    expect(usdcUnits("1.000001")).toBe("1000001");
    expect(usdcUnits("3")).toBe("3000000");
  });
});
