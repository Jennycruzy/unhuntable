// x402 per-call payments for the agent API, in USDC on NEAR (x402 v2, scheme "exact").
//
// The agent signs a NEP-366 delegated ft_transfer of the price to our account; the
// facilitator runs in this process and its relayer (RELAY_ACCOUNT) submits it and pays the
// gas. A call is settled on NEAR before it runs, so no work is done for an unpaid call.
// Built on FastNEAR's @fastnear/x402 and the x402 Foundation's @x402/core and @x402/near.
//
// A second way to pay, PingPay Agent Pay: the agent pays from any of 30+ chains, Ping
// quotes it through NEAR Intents (1Click), the agent deposits, and Ping settles USDC to our
// account on NEAR before the call runs. Both ways are offered in the same 402 challenge.
import type { FastifyRequest } from "fastify";
import { createNearFacilitator } from "@fastnear/x402/facilitator";
import { createNearResourceServer } from "@fastnear/x402/server";
import { x402HTTPResourceServer, type HTTPAdapter, type HTTPRequestContext } from "@x402/core/server";
import { decodePaymentRequiredHeader, decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";

export type NearNetwork = "near:mainnet" | "near:testnet";

export interface Paid {
  /** The NEAR transaction that moved the payment. */
  tx: string;
  payer: string | null;
  price: string;
}

export type Charge =
  | { paid: Paid; headers: Record<string, string> }
  /** Not paid (yet): send this answer, which carries the PAYMENT-REQUIRED challenge or the reason. */
  | { reply: { status: number; headers: Record<string, string>; body?: unknown } };

export interface Paywall {
  /** Price of one call in USDC, as a decimal string. */
  price: string;
  payTo: string;
  network: NearNetwork;
  /** Every way to pay, for the agents page. */
  routes: { name: "near" | "pingpay"; price: string }[];
  charge(req: FastifyRequest): Promise<Charge>;
}

function adapter(req: FastifyRequest): HTTPAdapter {
  const url = new URL(req.url, `https://${req.headers.host ?? "localhost"}`);
  const header = (name: string) => {
    const v = req.headers[name.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  };
  return {
    getHeader: header,
    getMethod: () => req.method,
    getPath: () => url.pathname,
    getUrl: () => url.toString(),
    getAcceptHeader: () => header("accept") ?? "",
    getUserAgent: () => header("user-agent") ?? "",
    getBody: () => req.body,
  };
}

/** A paywall that takes USDC on NEAR, settled by our own relayer. */
export async function nearPaywall(o: {
  payTo: string;
  price: string;
  network: NearNetwork;
  relayAccount: string;
  relayKey: string;
  rpcUrl: string;
}): Promise<Paywall> {
  if (!/^\d+(\.\d{1,6})?$/.test(o.price) || !(Number(o.price) > 0)) throw new Error("x402 price must be a USDC amount like 0.002");
  const facilitator = createNearFacilitator({
    registrations: [
      {
        network: o.network,
        signer: { relayers: [{ accountId: o.relayAccount, secretKey: o.relayKey as `ed25519:${string}` }], rpcUrls: { [o.network]: o.rpcUrl } },
      },
    ],
  });
  const server = new x402HTTPResourceServer(createNearResourceServer({ facilitators: facilitator }), {
    accepts: { scheme: "exact", network: o.network, price: `$${o.price}`, payTo: o.payTo },
    description: "One Unhuntable agent call",
    mimeType: "application/json",
    serviceName: "Unhuntable",
  });
  await server.initialize();
  return {
    price: o.price,
    payTo: o.payTo,
    network: o.network,
    routes: [{ name: "near", price: o.price }],
    async charge(req) {
      const a = adapter(req);
      const context: HTTPRequestContext = {
        adapter: a,
        path: a.getPath(),
        method: req.method,
        paymentHeader: a.getHeader("payment-signature") ?? a.getHeader("x-payment"),
      };
      const r = await server.processHTTPRequest(context);
      if (r.type === "payment-error") return { reply: r.response };
      if (r.type !== "payment-verified") throw new Error("x402 says no payment is needed for an agent call");
      const s = await server.processSettlement(r.paymentPayload, r.paymentRequirements, r.declaredExtensions, { request: context });
      if (!s.success) return { reply: s.response };
      return { paid: { tx: s.transaction, payer: s.payer ?? null, price: o.price }, headers: s.headers };
    },
  };
}

/** PingPay Agent Pay's smallest payment, 0.2 USDC. */
export const PING_MIN_PRICE = "0.2";
const OFFERS_KEEP_MS = 60_000;

const paymentHeader = (req: FastifyRequest): string | undefined => {
  const v = req.headers["payment-signature"] ?? req.headers["x-payment"];
  return Array.isArray(v) ? v[0] : v;
};

const resourceOf = (req: FastifyRequest) => ({
  url: new URL(req.url, `https://${req.headers.host ?? "localhost"}`).toString(),
  description: "One Unhuntable agent call",
  mimeType: "application/json",
});

/** USDC units (6 decimals) of a decimal price. */
export function usdcUnits(price: string): string {
  const [w, f = ""] = price.split(".");
  return (BigInt(w!) * 1_000_000n + BigInt((f + "000000").slice(0, 6))).toString();
}

export interface PingRoute {
  price: string;
  /** The unquoted offers: one per origin chain and token Ping can take. */
  offers(): Promise<unknown[]>;
  /** Handle a quote or deposit payload the agent sent. */
  pay(req: FastifyRequest, decoded: any): Promise<Charge>;
}

/**
 * PingPay Agent Pay (x402 v2, "exact" over NEAR Intents). The flow its middleware uses:
 * an unquoted 402; the agent sends a "quote" payload with its refund address and gets a
 * second 402 with a deposit address and amount; it deposits on its own chain and sends a
 * "deposit" payload; Ping settles USDC to our account, and the call is claimed once.
 */
export function pingRoute(o: { apiKey: string; price: string; base?: string; fetch?: typeof fetch; now?: () => number }): PingRoute {
  if (!/^\d+(\.\d{1,6})?$/.test(o.price) || Number(o.price) < Number(PING_MIN_PRICE)) throw new Error(`PingPay price must be at least ${PING_MIN_PRICE} USDC`);
  const f = o.fetch ?? ((...a) => fetch(...a));
  const now = o.now ?? Date.now;
  const fac = `${(o.base ?? "https://pay.pingpay.io").replace(/\/+$/, "")}/agentpay/x402`;
  const amountOut = usdcUnits(o.price);
  let kept: { at: number; accepts: unknown[] } | undefined;
  const post = async (path: string, body: unknown): Promise<{ status: number; j: any }> => {
    let res: Response;
    try {
      res = await f(`${fac}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Api-Key": o.apiKey }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    } catch {
      return { status: 503, j: { error: "PingPay did not answer" } };
    }
    let j: any = {};
    try {
      j = await res.json();
    } catch {
      j = { error: `PingPay answered HTTP ${res.status}` };
    }
    return { status: res.status, j };
  };
  const challenge = (req: FastifyRequest, accepts: unknown[]): Charge => {
    const body = { x402Version: 2, resource: resourceOf(req), accepts };
    return { reply: { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(body as any) }, body } };
  };
  return {
    price: o.price,
    async offers() {
      if (kept && now() - kept.at < OFFERS_KEEP_MS) return kept.accepts;
      const res = await f(`${fac}/offers?amountOut=${amountOut}`, { headers: { "X-Api-Key": o.apiKey }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`PingPay offers answered HTTP ${res.status}`);
      const accepts = ((await res.json())?.accepts ?? []).map((a: object) => ({ ...a, description: "One Unhuntable agent call" }));
      kept = { at: now(), accepts };
      return accepts;
    },
    async pay(req, decoded) {
      const payload = decoded?.payload ?? {};
      const accepted = decoded?.accepted ?? {};
      if (payload.type === "quote") {
        const paymentRequirements = { ...accepted, extra: { ...(accepted.extra ?? {}), assetTransferMethod: "near-intents", paymentFlow: "upfront" } };
        const v = await post("/verify", { x402Version: 2, paymentPayload: decoded, paymentRequirements });
        if (!v.j?.isValid) return { reply: { status: 402, headers: {}, body: { error: v.j?.invalidReason ?? v.j?.error ?? "PingPay refused the quote", ...v.j } } };
        const x = v.j.extra ?? {};
        const quoted = {
          ...paymentRequirements,
          amount: String(x.amountIn ?? ""),
          payTo: String(x.depositAddress ?? ""),
          extra: { ...paymentRequirements.extra, refundDeadline: x.refundDeadline, operationToken: x.operationToken, ...(x.depositMemo ? { depositMemo: x.depositMemo } : {}) },
        };
        return challenge(req, [quoted]);
      }
      if (payload.type === "deposit") {
        const s = await post("/settle", { x402Version: 2, paymentPayload: decoded, paymentRequirements: accepted });
        const headers = { "PAYMENT-RESPONSE": encodePaymentResponseHeader(s.j) };
        if (!s.j?.success) {
          const status = s.j?.errorReason === "settlement_pending" ? 402 : s.status >= 400 ? s.status : 402;
          return { reply: { status, headers, body: { error: s.j?.errorReason ?? s.j?.error ?? "PingPay did not settle", ...s.j } } };
        }
        // a settled deposit pays for one call only
        const c = await post("/execution", { depositAddress: String(payload.depositAddress ?? "") });
        if (c.status >= 400 || c.j?.execute !== true) return { reply: { status: 402, headers, body: { error: c.j?.errorReason ?? "this payment already paid for a call" } } };
        return { paid: { tx: String(s.j.transaction ?? ""), payer: typeof s.j.payer === "string" ? s.j.payer : null, price: o.price }, headers };
      }
      return { reply: { status: 402, headers: {}, body: { error: "unsupported_payload" } } };
    },
  };
}

/** Both ways to pay in one paywall: FastNEAR's USDC-on-NEAR transfer, and PingPay from any chain. */
export function bothPaywalls(near: Paywall | undefined, ping: PingRoute | undefined, base: { payTo: string; network: NearNetwork }): Paywall | undefined {
  if (!ping) return near;
  return {
    price: near?.price ?? ping.price,
    payTo: near?.payTo ?? base.payTo,
    network: near?.network ?? base.network,
    routes: [...(near?.routes ?? []), { name: "pingpay", price: ping.price }],
    async charge(req) {
      const header = paymentHeader(req);
      if (header) {
        let decoded: any = null;
        try {
          decoded = decodePaymentSignatureHeader(header);
        } catch {
          decoded = null;
        }
        const type = decoded?.payload?.type;
        if (type === "quote" || type === "deposit") return ping.pay(req, decoded);
        if (near) return near.charge(req);
        return { reply: { status: 402, headers: {}, body: { error: "unsupported_payload" } } };
      }
      let offers: unknown[] = [];
      try {
        offers = await ping.offers();
      } catch {
        offers = [];
      }
      if (!near) {
        const body = { x402Version: 2, resource: resourceOf(req), accepts: offers };
        return { reply: { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(body as any) }, body } };
      }
      const r = await near.charge(req);
      if (!("reply" in r) || r.reply.status !== 402 || !r.reply.headers["PAYMENT-REQUIRED"]) return r;
      // NEAR's own USDC transfer stays first; Ping's offers follow
      const required = decodePaymentRequiredHeader(r.reply.headers["PAYMENT-REQUIRED"]) as any;
      const merged = { ...required, accepts: [...(required.accepts ?? []), ...offers] };
      const body = r.reply.body && typeof r.reply.body === "object" && Array.isArray((r.reply.body as any).accepts) ? merged : r.reply.body;
      return { reply: { ...r.reply, headers: { ...r.reply.headers, "PAYMENT-REQUIRED": encodePaymentRequiredHeader(merged) }, body } };
    },
  };
}
