import { keyFromSecret } from "unhuntable-client";
import { describe, expect, it } from "vitest";
import { NEAR_USDC, createPingPaymentFetch, nearTokenDeposit } from "../src/pingpay.js";

const b64 = (x: unknown) => Buffer.from(JSON.stringify(x)).toString("base64");
const unb64 = (s: string) => JSON.parse(Buffer.from(s, "base64").toString("utf8"));
const NEAR_OFFER = { scheme: "exact", network: "near:mainnet", amount: "2000", asset: `nep141:${NEAR_USDC}`, payTo: "unhuntable.near", extra: {} };
const PING_OFFER = { scheme: "exact", network: "near:mainnet", amount: "", asset: `nep141:${NEAR_USDC}`, payTo: "", extra: { assetTransferMethod: "near-intents", paymentFlow: "upfront" } };
const BASE_OFFER = { ...PING_OFFER, network: "eip155:8453", asset: "eip155:8453/erc20:0xusdc" };

/** Unhuntable's agent API as it answers through PingPay: challenge, quote, then settle. */
function fakeServer(over: { unsettled?: number } = {}) {
  let unsettled = over.unsettled ?? 0;
  const seen: { sig: any; auth: string | null }[] = [];
  const f = (async (_url: string, init: RequestInit = {}) => {
    const h = init.headers as Record<string, string>;
    const sig = h["PAYMENT-SIGNATURE"] ? unb64(h["PAYMENT-SIGNATURE"]) : null;
    seen.push({ sig, auth: h.Authorization ?? null });
    const r402 = (accepts: unknown[], body: object = {}) =>
      new Response(JSON.stringify({ error: "payment_required", accepts, ...body }), { status: 402, headers: { "PAYMENT-REQUIRED": b64({ x402Version: 2, accepts }) } });
    if (!sig) return r402([NEAR_OFFER, BASE_OFFER, PING_OFFER]);
    if (sig.payload.type === "quote") return r402([{ ...sig.accepted, payTo: "deposit.near", amount: "201234", extra: { ...sig.accepted.extra, operationToken: "op-1" } }]);
    if (sig.payload.type === "deposit") {
      if (unsettled-- > 0) return new Response(JSON.stringify({ error: "payment_failed", errorReason: "settlement_pending" }), { status: 402 });
      return new Response(JSON.stringify({ positions: [], paid: { tx: "NearTx", price: "0.2" } }), { status: 200 });
    }
    throw new Error("unexpected");
  }) as typeof fetch;
  return { f, seen };
}

describe("paying an agent call through PingPay", () => {
  it("quotes with its own account as the refund address, deposits the quoted amount, and sends the proof", async () => {
    const s = fakeServer();
    const deposits: string[][] = [];
    const pay = createPingPaymentFetch({ accountId: "agent.near", token: NEAR_USDC, deposit: async (...a) => (deposits.push(a), "DepTx") }, s.f);
    const r = await pay("https://u.test/api/agent/positions", { method: "GET", headers: { Authorization: "Bearer k" } });
    expect(r.status).toBe(200);
    expect((await r.json()).paid).toEqual({ tx: "NearTx", price: "0.2" });
    // the Ping offer, not the plain transfer or another chain's
    expect(s.seen[1]!.sig).toMatchObject({ x402Version: 2, accepted: PING_OFFER, payload: { type: "quote", refundTo: "agent.near" } });
    expect(deposits).toEqual([[NEAR_USDC, "deposit.near", "201234"]]);
    expect(s.seen[2]!.sig.payload).toEqual({ type: "deposit", operationToken: "op-1", depositAddress: "deposit.near", txHash: "DepTx" });
    // the agent key goes with every try
    expect(s.seen.every((x) => x.auth === "Bearer k")).toBe(true);
  });

  it("asks again while NEAR Intents is still settling, and deposits only once", async () => {
    const s = fakeServer({ unsettled: 2 });
    let deposits = 0;
    const waits: number[] = [];
    const pay = createPingPaymentFetch({ accountId: "a.near", token: NEAR_USDC, deposit: async () => (deposits++, "DepTx"), sleep: async (ms) => void waits.push(ms), waitMs: 10 }, s.f);
    const r = await pay("https://u.test/x", { headers: {} });
    expect(r.status).toBe(200);
    expect(deposits).toBe(1);
    expect(waits).toEqual([10, 10]);
  });

  it("leaves an answer alone when it is not a 402 or has no Ping offer for its token", async () => {
    const plain = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const ok = await createPingPaymentFetch({ accountId: "a", token: NEAR_USDC, deposit: async () => "x" }, plain)("https://u.test/x");
    expect(ok.status).toBe(200);
    const s = fakeServer();
    let deposits = 0;
    const r = await createPingPaymentFetch({ accountId: "a", token: "wrap.near", deposit: async () => (deposits++, "x") }, s.f)("https://u.test/x", { headers: {} });
    expect(r.status).toBe(402);
    expect(deposits).toBe(0);
  });

  it("registers the deposit address with the token first when it has no storage, then transfers", async () => {
    const sent: { method: string; args: any }[] = [];
    const rpc = (async (_u: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body));
      const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: b.id, result }));
      if (b.method === "query" && b.params.request_type === "call_function") return ok({ result: [...Buffer.from("null")] });
      if (b.method === "query" && b.params.request_type === "view_access_key") return ok({ nonce: 5, block_hash: "11111111111111111111111111111111" });
      if (b.method === "send_tx") {
        // borsh: the method name, then the args as a u32 length and their bytes
        const tx = Buffer.from(b.params.signed_tx_base64, "base64");
        const method = tx.includes("storage_deposit") ? "storage_deposit" : "ft_transfer";
        const at = tx.indexOf(method) + method.length;
        const len = tx.readUInt32LE(at);
        sent.push({ method, args: JSON.parse(tx.subarray(at + 4, at + 4 + len).toString("utf8")) });
        return ok({ status: { SuccessValue: "" } });
      }
      throw new Error(b.method);
    }) as typeof fetch;
    const deposit = nearTokenDeposit("https://rpc.test", "agent.near", keyFromSecret(new Uint8Array(32).fill(7)).secretKeyStr, rpc);
    const hash = await deposit(NEAR_USDC, "deposit.near", "201234");
    expect(hash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    expect(sent).toEqual([
      { method: "storage_deposit", args: { account_id: "deposit.near", registration_only: true } },
      { method: "ft_transfer", args: { receiver_id: "deposit.near", amount: "201234" } },
    ]);
  });
});
