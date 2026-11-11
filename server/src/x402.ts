// x402 per-call payments for the agent API, in USDC on NEAR (x402 v2, scheme "exact").
//
// The agent signs a NEP-366 delegated ft_transfer of the price to our account; the
// facilitator runs in this process and its relayer (RELAY_ACCOUNT) submits it and pays the
// gas. A call is settled on NEAR before it runs, so no work is done for an unpaid call.
// Built on FastNEAR's @fastnear/x402 and the x402 Foundation's @x402/core and @x402/near.
import type { FastifyRequest } from "fastify";
import { createNearFacilitator } from "@fastnear/x402/facilitator";
import { createNearResourceServer } from "@fastnear/x402/server";
import { x402HTTPResourceServer, type HTTPAdapter, type HTTPRequestContext } from "@x402/core/server";

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
