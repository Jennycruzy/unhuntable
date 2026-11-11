// The Unhuntable agent API, from the agent's side. Every call but box-pub is paid with x402:
// `paidFetch` answers the 402 challenge by signing a USDC payment on NEAR and sends the call
// again. Stops are sealed here, on the agent's machine, into one box per piece that only
// the guard can open; this client never sends a stop level in the clear and has no call
// that reads one back.
import { sealedBox, type Box, type RandomSource } from "unhuntable-client";

export interface AgentPiece {
  shard: string;
  size: number | string;
  liqDistance: number | string | null;
  hasStop: boolean;
  hasTp: boolean;
  guard: "ok" | "unreachable";
}

export interface AgentPosition {
  id: string;
  coin: string;
  side: "long" | "short";
  notionalUsd: number;
  leverage: number;
  state: string;
  pieces: AgentPiece[];
}

export interface OpenRequest {
  coin: string;
  side: "long" | "short";
  notionalUsd: number;
  leverage: number;
  hiding?: "normal" | "whale";
}

export class AgentApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AgentApiError";
  }
}

/** One sealed stop box per piece. The level is inside the box and nowhere else. */
export function stopBoxes(boxPub: string, p: AgentPosition, trigger: number, jitterBps = 20, random?: RandomSource): { shard: string; box: Box }[] {
  if (!Number.isFinite(trigger) || trigger <= 0) throw new Error("The stop price must be a positive number.");
  if (!Number.isInteger(jitterBps) || jitterBps < 0 || jitterBps > 100) throw new Error("The tolerance must be a whole number of basis points from 0 to 100.");
  if (p.state !== "open") throw new Error(`The position is ${p.state}; a stop can be sealed once it is open.`);
  return p.pieces.map((x) => {
    const size = Number(x.size);
    if (!(size > 0)) throw new Error("A piece has no size yet. Try again when the position is open.");
    const inner = { op: "seal", shard: x.shard, stop: { coin: p.coin, side: p.side, trigger, size }, jitter_bps: jitterBps };
    return { shard: x.shard, box: sealedBox(boxPub, inner, random).box };
  });
}

export class AgentApi {
  constructor(
    private readonly base: string,
    private readonly key: string,
    /** fetch that pays x402 challenges (createNearPaymentFetch); tests pass a fake. */
    private readonly paidFetch: typeof fetch,
    /** plain fetch, for the one free call. */
    private readonly plainFetch: typeof fetch = (...a) => fetch(...a),
  ) {
    if (!/^uak_[0-9a-f]{64}$/.test(key)) throw new Error("UNHUNTABLE_AGENT_KEY must be the uak_ key the owner made in the app.");
    this.base = base.replace(/\/+$/, "");
  }

  private async call<T>(f: typeof fetch, method: "GET" | "POST", path: string, body?: unknown): Promise<T & { paid?: { tx: string; price: string } }> {
    const res = await f(this.base + path, {
      method,
      headers: { Authorization: `Bearer ${this.key}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let j: any;
    try {
      j = await res.json();
    } catch {
      throw new AgentApiError("bad_reply", `Unhuntable answered HTTP ${res.status} with a body that is not JSON.`, res.status);
    }
    if (!res.ok || typeof j?.error === "string") throw new AgentApiError(String(j?.error ?? "error"), String(j?.message ?? `HTTP ${res.status}`), res.status);
    return j;
  }

  boxPub(): Promise<{ boxPub: string }> {
    return this.call(this.plainFetch, "GET", "/api/agent/box-pub");
  }

  status() {
    return this.call<{ positions: AgentPosition[] }>(this.paidFetch, "GET", "/api/agent/positions");
  }

  open(r: OpenRequest) {
    return this.call<{ positionId: string; state: string }>(this.paidFetch, "POST", "/api/agent/positions", { hiding: "normal", ...r });
  }

  /** Seal a stop for every piece of one of this agent's positions. Two paid calls: status, then the boxes. */
  async setStop(positionId: string, trigger: number, jitterBps = 20, random?: RandomSource) {
    const { positions } = await this.status();
    const p = positions.find((x) => x.id === positionId);
    if (!p) throw new AgentApiError("not_found", "This agent has no position with that id.", 404);
    const { boxPub } = await this.boxPub();
    const boxes = stopBoxes(boxPub, p, trigger, jitterBps, random);
    return this.call<{ ok: true; sealed: number }>(this.paidFetch, "POST", `/api/agent/positions/${encodeURIComponent(positionId)}/stop`, { boxes });
  }

  close(positionId: string, now = false) {
    return this.call<{ ok: true; state: string }>(this.paidFetch, "POST", `/api/agent/positions/${encodeURIComponent(positionId)}/close`, now ? { now: true } : {});
  }
}
