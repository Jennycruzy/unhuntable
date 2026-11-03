// Hyperliquid: public info reads and posting actions signed elsewhere (by a piece's master
// key through OutLayer). Also the approveAgent typed data, built like the official SDK
// (hyperliquid-python-sdk signing.py, sign_agent), which the client library does not have.
import { SIGNATURE_CHAIN_ID, type TypedData } from "unhuntable-client";

export const SIGNATURE_CHAIN_HEX = "0x66eee";
const ZERO = "0x0000000000000000000000000000000000000000";

export class HyperliquidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HyperliquidError";
  }
}

export interface PerpPosition {
  coin: string;
  szi: number;
  entryPx: number | null;
  liquidationPx: number | null;
}

export interface PerpState {
  withdrawable: string;
  accountValue: number;
  positions: PerpPosition[];
}

export interface CoinMeta {
  name: string;
  szDecimals: number;
  maxLeverage: number;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

export class Hyperliquid {
  private readonly f: typeof fetch;
  private readonly base: string;
  constructor(baseUrl: string, f?: typeof fetch) {
    this.base = baseUrl.replace(/\/+$/, "");
    this.f = f ?? ((...a) => fetch(...a));
  }

  private async post(path: string, body: unknown): Promise<any> {
    let res: Response;
    try {
      res = await this.f(`${this.base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    } catch {
      throw new HyperliquidError("Hyperliquid did not answer.");
    }
    const text = await res.text();
    let j: unknown;
    try {
      j = JSON.parse(text);
    } catch {
      throw new HyperliquidError(`Hyperliquid answered HTTP ${res.status} with a body that is not JSON.`);
    }
    if (!res.ok) throw new HyperliquidError(`Hyperliquid answered HTTP ${res.status}.`);
    return j;
  }

  info(body: Record<string, unknown>): Promise<any> {
    return this.post("/info", body);
  }

  async allMids(): Promise<Record<string, number>> {
    const j = await this.info({ type: "allMids" });
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(j ?? {})) {
      const n = num(v);
      if (n !== null) out[k] = n;
    }
    return out;
  }

  async meta(coin: string): Promise<CoinMeta> {
    const j = await this.info({ type: "meta" });
    const m = (j?.universe ?? []).find((u: any) => u?.name === coin);
    if (!m || !Number.isInteger(m.szDecimals) || !(m.maxLeverage > 0)) throw new HyperliquidError(`Hyperliquid meta has no ${coin}.`);
    return { name: m.name, szDecimals: m.szDecimals, maxLeverage: m.maxLeverage };
  }

  async perp(user: string): Promise<PerpState> {
    const j = await this.info({ type: "clearinghouseState", user });
    return {
      withdrawable: String(j?.withdrawable ?? "0"),
      accountValue: num(j?.marginSummary?.accountValue) ?? 0,
      positions: (j?.assetPositions ?? [])
        .map((x: any) => x?.position)
        .filter((p: any) => p && num(p.szi))
        .map((p: any) => ({ coin: String(p.coin), szi: num(p.szi)!, entryPx: num(p.entryPx), liquidationPx: num(p.liquidationPx) })),
    };
  }

  /** Spot USDC total, as a decimal string. */
  async spotUsdc(user: string): Promise<string> {
    const j = await this.info({ type: "spotClearinghouseState", user });
    return String((j?.balances ?? []).find((b: any) => b?.coin === "USDC")?.total ?? "0");
  }

  /** Post a signed action. Throws with Hyperliquid's reason when it is refused. */
  async exchange(body: unknown): Promise<any> {
    const j = await this.post("/exchange", body);
    if (j?.status !== "ok") throw new HyperliquidError(typeof j?.response === "string" ? j.response : "Hyperliquid refused the action.");
    return j;
  }
}

/** approveAgent: lets an agent address trade for the master account. */
export function approveAgent(agentAddress: string, agentName: string, nonce: number) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(agentAddress)) throw new Error("agent must be a 0x address");
  const agent = agentAddress.toLowerCase();
  const action = {
    type: "approveAgent",
    hyperliquidChain: "Mainnet",
    signatureChainId: SIGNATURE_CHAIN_HEX,
    agentAddress: agent,
    agentName,
    nonce,
  };
  const typed: TypedData = {
    domain: { name: "HyperliquidSignTransaction", version: "1", chainId: SIGNATURE_CHAIN_ID, verifyingContract: ZERO },
    types: {
      "HyperliquidTransaction:ApproveAgent": [
        { name: "hyperliquidChain", type: "string" },
        { name: "agentAddress", type: "address" },
        { name: "agentName", type: "string" },
        { name: "nonce", type: "uint64" },
      ],
    },
    primaryType: "HyperliquidTransaction:ApproveAgent",
    message: { hyperliquidChain: "Mainnet", agentAddress: agent, agentName, nonce },
  };
  return { action, typed, nonce };
}
