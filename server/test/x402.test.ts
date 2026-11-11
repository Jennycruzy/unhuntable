import { keyFromSecret } from "unhuntable-client";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/index.js";
import { nearPaywall } from "../src/x402.js";
import { testConfig } from "./helpers.js";
import { addUser, addWallet, harness } from "./world.js";

// Circle's USDC on NEAR mainnet, the asset x402's NEAR scheme uses for dollar prices.
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

describe("the real x402 paywall, offline", () => {
  it("answers an unpaid agent call with an x402 v2 challenge for USDC on NEAR to our account", async () => {
    const relay = keyFromSecret(new Uint8Array(32).fill(7));
    const paywall = await nearPaywall({
      payTo: "unhuntable.near",
      price: "0.002",
      network: "near:mainnet",
      relayAccount: "relay.near",
      relayKey: relay.secretKeyStr,
      rpcUrl: "https://near.invalid",
    });
    const h = harness();
    const alice = addUser(h);
    addWallet(h, alice.userId, "balance", "none");
    const app = buildServer({ config: testConfig(), db: h.db, now: h.ctx.now, money: h.ctx, paywall });
    const { key } = (
      await app.inject({ method: "POST", url: "/api/agents", headers: { cookie: alice.cookie }, payload: { name: "bot", maxNotionalUsd: 50, coins: ["ETH"], dailyOpens: 1 } })
    ).json();

    const r = await app.inject({ method: "GET", url: "/api/agent/positions", headers: { authorization: `Bearer ${key}` } });
    expect(r.statusCode).toBe(402);
    expect(r.json()).toMatchObject({ error: "payment_required" });
    const challenge = JSON.parse(Buffer.from(String(r.headers["payment-required"]), "base64").toString("utf8"));
    expect(challenge.x402Version).toBe(2);
    expect(challenge.accepts).toHaveLength(1);
    // 0.002 USDC is 2000 in USDC's 6 decimals
    expect(challenge.accepts[0]).toMatchObject({ scheme: "exact", network: "near:mainnet", amount: "2000", asset: USDC, payTo: "unhuntable.near" });

    // a payment header that is not a payment is refused, and nothing runs
    const bad = await app.inject({ method: "GET", url: "/api/agent/positions", headers: { authorization: `Bearer ${key}`, "payment-signature": "bm90IGEgcGF5bWVudA==" } });
    expect(bad.statusCode).toBe(402);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM agent_calls").get()).toEqual({ n: 0 });
  });

  it("refuses a price that is not a USDC amount", async () => {
    const relay = keyFromSecret(new Uint8Array(32).fill(7));
    for (const price of ["0", "-1", "1e-3", "0.0000001", "abc"]) {
      await expect(
        nearPaywall({ payTo: "unhuntable.near", price, network: "near:mainnet", relayAccount: "relay.near", relayKey: relay.secretKeyStr, rpcUrl: "https://near.invalid" }),
      ).rejects.toThrow(/USDC amount/);
    }
  });
});
