// Typed guard client. addr and box_pub go plain; every other op goes as one sealed box
// with the op name inside, so OutLayer's public call record shows only ciphertext.
import { sealedBox, type RandomSource } from "./box.js";
import { callGuard, type CallOptions } from "./call.js";
import { ASSETS, asset } from "./hyperliquid.js";

/** Every market the guard trades: Hyperliquid's own crypto list and trade.xyz stocks. */
export const COINS: readonly string[] = ASSETS.map((a) => a.coin);
export type Coin = string;
export type Side = "long" | "short";
export const MAX_LEVERAGE = 10;
export const MAX_JITTER_BPS = 100;
export const MAX_TICK_SHARDS = 32;

export interface Stop {
  coin: Coin;
  /** Side of the position: a long stop fires when the price falls to trigger. */
  side: Side;
  trigger: number;
  size: number;
}

/** A take-profit has the same fields as a stop: a long one fires when the price rises to trigger. */
export type TakeProfit = Stop;

/** Shard routing: outerShard sends the shard in plain next to the box ({"box":..., "shard": shard}). */
export interface Routing {
  outerShard?: boolean;
}

export interface GuardClientOptions extends CallOptions {
  owner: string;
  project: string;
  /** Passed in by the caller; never read from files or the environment. */
  paymentKey: string;
  /** Guard box public key (hex). Fetched once with box_pub when left out. */
  boxPub?: string;
  /** Replaces crypto random bytes (tests). */
  random?: RandomSource;
}

export type Answer = Record<string, unknown>;

// Checks below match the guard's own, so a bad request fails here before it costs a call.

export function checkShard(shard: string): string {
  if (typeof shard !== "string" || !/^[a-z0-9]{1,16}$/.test(shard)) {
    throw new TypeError("shard must be 1-16 lowercase letters/digits");
  }
  return shard;
}

export function checkCoin(coin: string): Coin {
  const a = asset(coin);
  if (!a) throw new TypeError(`unsupported coin ${coin}`);
  return a.coin;
}

export function checkSide(side: string): Side {
  if (side !== "long" && side !== "short") throw new TypeError("side must be long or short");
  return side;
}

export function checkPositive(name: string, x: number): number {
  if (typeof x !== "number" || !Number.isFinite(x) || !(x > 0)) throw new TypeError(`${name} must be a positive number`);
  return x;
}

export function checkLeverage(lev: number): number {
  if (!Number.isInteger(lev) || lev < 1 || lev > MAX_LEVERAGE) throw new TypeError(`leverage must be 1-${MAX_LEVERAGE}`);
  return lev;
}

export function checkAddress(a: string): string {
  if (typeof a !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(a)) throw new TypeError("master must be a 0x address");
  return a.toLowerCase();
}

export function checkJitterBps(bps: number): number {
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_JITTER_BPS) throw new TypeError(`jitter must be a whole number 0-${MAX_JITTER_BPS}`);
  return bps;
}

export function checkShards(shards: string[]): string[] {
  if (!Array.isArray(shards) || shards.length < 1 || shards.length > MAX_TICK_SHARDS) {
    throw new TypeError(`shards must hold 1-${MAX_TICK_SHARDS} shard ids`);
  }
  const out = shards.map(checkShard);
  if (new Set(out).size !== out.length) throw new TypeError("duplicate shard");
  return out;
}

export function checkVrfLabel(label: string): string {
  if (typeof label !== "string" || !/^[a-z0-9-]{1,64}$/.test(label)) throw new TypeError("label must be 1-64 of a-z, 0-9 and -");
  return label;
}

export function checkStop(stop: Stop, what = "stop"): Stop {
  if (typeof stop !== "object" || stop === null) throw new TypeError(`${what} is required`);
  return {
    coin: checkCoin(stop.coin),
    side: checkSide(stop.side),
    trigger: checkPositive("trigger", stop.trigger),
    size: checkPositive("size", stop.size),
  };
}

export class GuardClient {
  private readonly opts: GuardClientOptions;
  private gpk?: string;

  constructor(opts: GuardClientOptions) {
    if (!opts.owner || !opts.project) throw new TypeError("owner and project are required");
    if (!opts.paymentKey) throw new TypeError("payment key is required");
    this.opts = opts;
    if (opts.boxPub !== undefined) this.gpk = GuardClient.checkBoxPub(opts.boxPub);
  }

  private static checkBoxPub(h: unknown): string {
    if (typeof h !== "string" || !/^[0-9a-fA-F]{64}$/.test(h)) throw new TypeError("box public key must be 32 bytes of hex");
    return h.toLowerCase();
  }

  private call(input: unknown): Promise<Answer> {
    const { owner, project, paymentKey, fetch, baseUrl } = this.opts;
    return callGuard(owner, project, paymentKey, input, { fetch, baseUrl });
  }

  /** One sealed box. With outerShard the inner shard also goes in plain next to it; the guard refuses a mismatch. */
  private async sealed(inner: Record<string, unknown>, route?: Routing): Promise<Answer> {
    const gpk = this.gpk ?? (await this.boxPub());
    const input: Record<string, unknown> = sealedBox(gpk, inner, this.opts.random);
    if (route?.outerShard) input.shard = inner.shard;
    return this.call(input);
  }

  /** The guard's public Hyperliquid address and VRF key. */
  addr(): Promise<Answer> {
    return this.call({ op: "addr" });
  }

  /** The guard's box public key (hex). Kept for later sealed calls. */
  async boxPub(): Promise<string> {
    const out = await this.call({ op: "box_pub" });
    this.gpk = GuardClient.checkBoxPub(out.box_pub);
    return this.gpk;
  }

  /** The shard's agent address, to approve once on Hyperliquid. */
  async agent(shard: string, route?: Routing): Promise<Answer> {
    return this.sealed({ op: "agent", shard: checkShard(shard) }, route);
  }

  async leverage(p: { shard: string; coin: Coin; leverage: number } & Routing): Promise<Answer> {
    const inner = { op: "leverage", shard: checkShard(p.shard), coin: checkCoin(p.coin), leverage: checkLeverage(p.leverage) };
    return this.sealed(inner, p);
  }

  /** Market-open a position at the agreed mid price (IOC). */
  async open(p: { shard: string; coin: Coin; side: Side; size: number; builder?: boolean } & Routing): Promise<Answer> {
    const inner: Record<string, unknown> = {
      op: "open",
      shard: checkShard(p.shard),
      coin: checkCoin(p.coin),
      side: checkSide(p.side),
      size: checkPositive("size", p.size),
    };
    if (p.builder) inner.builder = true;
    return this.sealed(inner, p);
  }

  /**
   * Store a stop; it travels inside the sealed call and is kept sealed by the guard.
   * jitterBps (0-100) has the guard move the stored trigger by a random amount within that many basis points.
   */
  async seal(p: { shard: string; stop: Stop; jitterBps?: number } & Routing): Promise<Answer> {
    const inner: Record<string, unknown> = { op: "seal", shard: checkShard(p.shard), stop: checkStop(p.stop) };
    if (p.jitterBps !== undefined) inner.jitter_bps = checkJitterBps(p.jitterBps);
    return this.sealed(inner, p);
  }

  /** Store a take-profit, sealed like a stop. It fires once, when the agreeing prices all reach it. */
  async sealTp(p: { shard: string; tp: TakeProfit } & Routing): Promise<Answer> {
    return this.sealed({ op: "seal_tp", shard: checkShard(p.shard), tp: checkStop(p.tp, "take-profit") }, p);
  }

  /**
   * Check prices and fire the stop or take-profit if the sources agree it is hit.
   * defend also runs the defence ladder. dry reports without sending.
   */
  async tick(p: { shard: string; coin: Coin; dry?: boolean; defend?: boolean; builder?: boolean } & Routing): Promise<Answer> {
    const inner: Record<string, unknown> = { op: "tick", shard: checkShard(p.shard), coin: checkCoin(p.coin) };
    if (p.dry) inner.dry = true;
    if (p.defend) inner.defend = true;
    if (p.builder) inner.builder = true;
    return this.sealed(inner, p);
  }

  /** One price fetch for a coin, then a tick for each of 1-32 shards. */
  async tickCoin(p: { coin: Coin; shards: string[]; dry?: boolean; defend?: boolean; builder?: boolean }): Promise<Answer> {
    const inner: Record<string, unknown> = { op: "tick_coin", coin: checkCoin(p.coin), shards: checkShards(p.shards) };
    if (p.dry) inner.dry = true;
    if (p.defend) inner.defend = true;
    if (p.builder) inner.builder = true;
    return this.sealed(inner);
  }

  /** One defence ladder step: cut or close when the position nears liquidation. */
  async defend(p: { shard: string; coin: Coin; dry?: boolean } & Routing): Promise<Answer> {
    const inner: Record<string, unknown> = { op: "defend", shard: checkShard(p.shard), coin: checkCoin(p.coin) };
    if (p.dry) inner.dry = true;
    return this.sealed(inner, p);
  }

  /** Close the shard's whole position in a coin (reduce-only). */
  async close(p: { shard: string; coin: Coin } & Routing): Promise<Answer> {
    return this.sealed({ op: "close", shard: checkShard(p.shard), coin: checkCoin(p.coin) }, p);
  }

  /** A VRF draw for a plan, checkable later against the guard's VRF public key. */
  async vrf(label: string): Promise<Answer> {
    return this.sealed({ op: "vrf", label: checkVrfLabel(label) });
  }

  /** Record which Hyperliquid master account the shard trades for. */
  async register(p: { shard: string; master: string } & Routing): Promise<Answer> {
    return this.sealed({ op: "register", shard: checkShard(p.shard), master: checkAddress(p.master) }, p);
  }

  /** Signed track-record totals across all registered shards (EAS off-chain attestation). */
  async proof(): Promise<Answer> {
    return this.sealed({ op: "proof" });
  }
}
