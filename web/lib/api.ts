// Our HTTP API. Every call sends the session cookie (credentials "include") and only JSON.
// Every error answer is {"error": code, "message": plain sentence}; ApiError carries both.
import { API_URL } from "./config";
import type {
  Whale,
  HuntMap,
  HunterView,
  AgentKeys,
  Settings,
  HuntUsChallenge,
  HuntUsReveal,
  NewAgentKey,
  Balance,
  DepositState,
  HomeStart,
  HomeState,
  Me,
  PlanAnswer,
  PolicyConfirmed,
  Position,
  PositionAnswer,
  Quote,
  QuoteRequest,
  SealedBox,
  TradeRequest,
  WalletConfirmed,
  WalletKey,
  Alert,
} from "./types";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const UNREACHABLE = "We couldn't reach our server. Check your connection and try again.";
const BAD_REPLY = "Our server sent an answer we could not read. Try again.";

export type Fetch = typeof fetch;

export class Api {
  constructor(
    private readonly f: Fetch = (...a) => fetch(...a),
    private readonly base: string = API_URL,
  ) {}

  async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method, credentials: "include", headers: { Accept: "application/json" } };
    if (body !== undefined) {
      init.headers = { Accept: "application/json", "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await this.f(this.base + path, init);
    } catch {
      throw new ApiError("unreachable", UNREACHABLE, 0);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new ApiError("bad_reply", BAD_REPLY, res.status);
    }
    const j = json as { error?: unknown; message?: unknown };
    if (j && typeof j === "object" && typeof j.error === "string") {
      throw new ApiError(j.error, typeof j.message === "string" ? j.message : BAD_REPLY, res.status);
    }
    if (!res.ok) throw new ApiError("bad_reply", BAD_REPLY, res.status);
    return json as T;
  }

  session(body: { accountId: string; publicKey: string; signature: string; message: string; nonce: string; recipient: string }) {
    return this.call<{ ok: true; accountId: string; expiresMs: number }>("POST", "/api/session", body);
  }
  logout() {
    return this.call<{ ok: true }>("POST", "/api/logout", {});
  }
  me() {
    return this.call<Me>("GET", "/api/me");
  }
  piecesKey(publicKey: string) {
    return this.call<{ ok: true }>("POST", "/api/pieces-key", { publicKey });
  }
  walletKey(label: string) {
    return this.call<WalletKey>("POST", "/api/wallets/key", { label });
  }
  walletConfirm(requestId: string, label: string, seed: string) {
    return this.call<WalletConfirmed>("POST", "/api/wallets/confirm", { requestId, label, seed });
  }
  balance() {
    return this.call<Balance>("GET", "/api/balance");
  }
  /** The largest public position on Hyperliquid the server last read; null until it has one. */
  whale() {
    return this.call<{ whale: Whale | null }>("GET", "/api/whale");
  }
  /** The Hunt Map; null until the server has read Hyperliquid once. */
  huntMap() {
    return this.call<{ map: HuntMap | null }>("GET", "/api/hunt-map");
  }
  quote(q: QuoteRequest) {
    return this.call<Quote>("POST", "/api/deposit/quote", q);
  }
  deposit(id: string) {
    return this.call<DepositState>("GET", `/api/deposit/${encodeURIComponent(id)}`);
  }
  plan(t: TradeRequest) {
    return this.call<PlanAnswer>("POST", "/api/plan", t);
  }
  openPosition(t: TradeRequest) {
    return this.call<PositionAnswer>("POST", "/api/positions", t);
  }
  continuePosition(id: string) {
    return this.call<PositionAnswer>("POST", `/api/positions/${encodeURIComponent(id)}/continue`, {});
  }
  policyConfirm(body: { positionId?: string; homeId?: string; txHashes: string[] }) {
    return this.call<PolicyConfirmed>("POST", "/api/policy/confirm", body);
  }
  positions() {
    return this.call<{ positions: Position[] }>("GET", "/api/positions");
  }
  /** What Hyperliquid's public API shows for each piece of this position. */
  hunter(id: string) {
    return this.call<HunterView>("GET", `/api/positions/${encodeURIComponent(id)}/hunter`);
  }
  boxPub() {
    return this.call<{ boxPub: string }>("GET", "/api/guard/box-pub");
  }
  sealStops(id: string, boxes: { shard: string; box: SealedBox }[]) {
    return this.call<{ ok: true; sealed: number }>("POST", `/api/positions/${encodeURIComponent(id)}/stop`, { boxes });
  }
  close(id: string, now = false) {
    return this.call<{ ok: true; state: string }>("POST", `/api/positions/${encodeURIComponent(id)}/close`, now ? { now: true } : {});
  }
  home(labels?: string[]) {
    return this.call<HomeStart>("POST", "/api/home", labels ? { labels } : {});
  }
  chainSigRegister(label: string, publicKey: string) {
    type Step = { counter: number; action: import("unhuntable-client/chainsig").ChainSigAction };
    return this.call<{ label: string; account: string; contract: string; approve: Step | null; move?: Step | null; builder?: Step | null }>(
      "POST",
      "/api/chainsig/register",
      { label, publicKey },
    );
  }
  /** signature: the agent approval; moveSignature: the move onto trade.xyz; builderSignature: the builder fee approval. Whichever the server asked for. */
  chainSigApprove(label: string, signature: string | null, moveSignature: string | null = null, builderSignature: string | null = null) {
    const body: Record<string, string> = { label };
    if (signature) body.signature = signature;
    if (moveSignature) body.moveSignature = moveSignature;
    if (builderSignature) body.builderSignature = builderSignature;
    return this.call<{ ok: true; label: string }>("POST", "/api/chainsig/approve", body);
  }
  homeChainSig(id: string, pieces: { label: string; signed: { counter: number; action: import("unhuntable-client/chainsig").ChainSigAction; signature: string }[] }[]) {
    return this.call<{ ok: true; state: string }>("POST", `/api/home/${encodeURIComponent(id)}/chainsig`, { pieces });
  }
  homeState(id: string) {
    return this.call<HomeState>("GET", `/api/home/${encodeURIComponent(id)}`);
  }
  huntUs() {
    return this.call<{ challenge: HuntUsChallenge | null }>("GET", "/api/hunt-us");
  }
  huntUsStart() {
    return this.call<{ token: string; revealAtMs: number }>("POST", "/api/hunt-us/start", {});
  }
  huntUsReveal(token: string) {
    return this.call<HuntUsReveal>("GET", `/api/hunt-us/reveal?token=${encodeURIComponent(token)}`);
  }
  settings() {
    return this.call<Settings>("GET", "/api/settings");
  }
  saveSettings(body: { autoRefill: boolean; refillCapUsdPerDay: number }) {
    return this.call<Settings>("POST", "/api/settings", body);
  }
  agents() {
    return this.call<AgentKeys>("GET", "/api/agents");
  }
  newAgent(body: { name: string; maxNotionalUsd: number; coins: string[]; dailyOpens: number }) {
    return this.call<NewAgentKey>("POST", "/api/agents", body);
  }
  revokeAgent(id: string) {
    return this.call<{ ok: true }>("POST", `/api/agents/${encodeURIComponent(id)}/revoke`, {});
  }
  alerts() {
    return this.call<{ alerts: Alert[] }>("GET", "/api/alerts");
  }
}

/** The plain sentence to show for any error. */
export function sentence(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error && e.message) return e.message;
  return "Something went wrong. Try again.";
}
