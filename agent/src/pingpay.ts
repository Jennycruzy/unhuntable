// Paying an Unhuntable call through PingPay Agent Pay instead of a USDC transfer on NEAR.
// The agent picks Ping's offer for its own token on NEAR, asks for a quote (its account is
// the refund address), deposits the quoted amount to the quoted address with an ordinary
// ft_transfer, then sends the deposit proof. Ping settles USDC to Unhuntable through NEAR
// Intents; until that is done the call answers payment_settling. The proof is kept, so the
// next call for the same request sends it again instead of paying a second time.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { NearRelay } from "unhuntable-client";

/** USDC on NEAR mainnet. */
export const NEAR_USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

/** A deposit already made for one request: what Ping needs to settle it. */
export interface DepositProof {
  accepted: unknown;
  payload: { type: "deposit"; operationToken: string; depositAddress: string; txHash: string };
  madeMs: number;
}

/** Where proofs wait between calls, keyed by "METHOD url". */
export interface ProofStore {
  get(key: string): DepositProof | undefined;
  set(key: string, proof: DepositProof | undefined): void;
}

export function memoryProofs(): ProofStore {
  const m = new Map<string, DepositProof>();
  return { get: (k) => m.get(k), set: (k, p) => (p ? m.set(k, p) : m.delete(k)) };
}

/** Proofs in a small JSON file, so a new process picks up a payment the last one made. */
export function fileProofs(path: string): ProofStore {
  const read = (): Record<string, DepositProof> => {
    try {
      return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    } catch {
      return {};
    }
  };
  return {
    get: (k) => read()[k],
    set: (k, p) => {
      const all = read();
      if (p) all[k] = p;
      else delete all[k];
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, JSON.stringify(all, null, 2), { mode: 0o600 });
    },
  };
}

export interface PingPayer {
  /** The NEAR account that pays, and that gets any refund. */
  accountId: string;
  /** The NEP-141 token it pays with. */
  token: string;
  /** Send `amount` of `token` to `to`; returns the NEAR transaction hash. */
  deposit(token: string, to: string, amount: string): Promise<string>;
  proofs?: ProofStore;
  sleep?: (ms: number) => Promise<void>;
  /** How many times an unsettled payment is sent again within one call, and how long between. */
  tries?: number;
  waitMs?: number;
}

const b64 = (x: unknown) => Buffer.from(JSON.stringify(x), "utf8").toString("base64");
const unb64 = (s: string | null): any => {
  if (!s) return null;
  try {
    return JSON.parse(Buffer.from(s, "base64").toString("utf8"));
  } catch {
    return null;
  }
};
const settling = async (r: Response) => {
  if (r.status !== 402) return false;
  const body = await r
    .clone()
    .json()
    .catch(() => ({}));
  return body?.errorReason === "settlement_pending" || body?.error === "payment_settling";
};

/** A fetch that pays 402 answers through PingPay. Anything else passes through untouched. */
export function createPingPaymentFetch(p: PingPayer, f: typeof fetch = (...a) => fetch(...a)): typeof fetch {
  const sleep = p.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  // most MCP clients give a tool about a minute; an unsettled payment is resumed on the next call
  const tries = p.tries ?? 8;
  const waitMs = p.waitMs ?? 5_000;
  const proofs = p.proofs ?? memoryProofs();
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const key = `${(init.method ?? "GET").toUpperCase()} ${String(input instanceof Request ? input.url : input)}`;
    const send = (accepted: unknown, payload: unknown) =>
      f(input, { ...init, headers: { ...(init.headers as Record<string, string>), "PAYMENT-SIGNATURE": b64({ x402Version: 2, accepted, payload }) } });
    const settle = async (proof: DepositProof) => {
      let last = await send(proof.accepted, proof.payload);
      for (let i = 0; i < tries && (await settling(last)); i++) {
        await sleep(waitMs);
        last = await send(proof.accepted, proof.payload);
      }
      // keep the proof only while the payment is still settling
      proofs.set(key, (await settling(last)) ? proof : undefined);
      return last;
    };

    const kept = proofs.get(key);
    if (kept) return settle(kept);

    const first = await f(input, init);
    if (first.status !== 402) return first;
    const offers = unb64(first.headers.get("payment-required"))?.accepts ?? [];
    const offer = offers.find((a: any) => a?.extra?.assetTransferMethod === "near-intents" && a?.network === "near:mainnet" && a?.asset === `nep141:${p.token}`);
    if (!offer) return first;

    const q = await send(offer, { type: "quote", refundTo: p.accountId });
    if (q.status !== 402) return q;
    const quoted = unb64(q.headers.get("payment-required"))?.accepts?.[0];
    const token = quoted?.extra?.operationToken;
    if (!quoted?.payTo || !quoted?.amount || typeof token !== "string") return q;

    const txHash = await p.deposit(p.token, quoted.payTo, quoted.amount);
    const proof: DepositProof = { accepted: quoted, payload: { type: "deposit", operationToken: token, depositAddress: quoted.payTo, txHash }, madeMs: Date.now() };
    // kept before the first try, so a crash or a client timeout cannot lose a paid deposit
    proofs.set(key, proof);
    return settle(proof);
  }) as typeof fetch;
}

/** Deposits made by ft_transfer from the agent's own NEAR account, registering the receiver first if needed. */
export function nearTokenDeposit(rpcUrl: string, accountId: string, secretKey: string, f?: typeof fetch): PingPayer["deposit"] {
  const relay = new NearRelay(rpcUrl, accountId, secretKey, f);
  const view = async (contract: string, method: string, args: object) => {
    const res = await (f ?? fetch)(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "agent",
        method: "query",
        params: { request_type: "call_function", finality: "final", account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") },
      }),
    });
    const j: any = await res.json();
    if (j?.error || !Array.isArray(j?.result?.result)) return null;
    return JSON.parse(Buffer.from(j.result.result).toString("utf8"));
  };
  const json = (x: object) => new TextEncoder().encode(JSON.stringify(x));
  return async (token, to, amount) => {
    if ((await view(token, "storage_balance_of", { account_id: to })) === null) {
      await relay.call(token, "storage_deposit", json({ account_id: to, registration_only: true }), 10_000_000_000_000n, 1_250_000_000_000_000_000_000n);
    }
    const r = await relay.call(token, "ft_transfer", json({ receiver_id: to, amount }), 10_000_000_000_000n, 1n);
    return r.txHash;
  };
}
