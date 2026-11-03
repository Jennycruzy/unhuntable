// Typed guard client. addr and box_pub go plain; every other op goes as one sealed box
// with the op name inside, so OutLayer's public call record shows only ciphertext.
import { sealedBox, type RandomSource } from "./box.js";
import { callGuard, type CallOptions } from "./call.js";

export const COINS = ["BTC", "ETH", "SOL"] as const;
export type Coin = (typeof COINS)[number];
export type Side = "long" | "short";
export const MAX_LEVERAGE = 10;

export interface Stop {
  coin: Coin;
  /** Side of the position: a long stop fires when the price falls to trigger. */
  side: Side;
  trigger: number;
  size: number;
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
  const c = typeof coin === "string" ? coin.toUpperCase() : "";
  if (!(COINS as readonly string[]).includes(c)) throw new TypeError(`unsupported coin ${coin}`);
  return c as Coin;
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

export function checkStop(stop: Stop): Stop {
  if (typeof stop !== "object" || stop === null) throw new TypeError("stop is required");
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

  private async sealed(inner: Record<string, unknown>): Promise<Answer> {
    const gpk = this.gpk ?? (await this.boxPub());
    return this.call(sealedBox(gpk, inner, this.opts.random));
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
  async agent(shard: string): Promise<Answer> {
    return this.sealed({ op: "agent", shard: checkShard(shard) });
  }

  async leverage(p: { shard: string; coin: Coin; leverage: number }): Promise<Answer> {
    const inner = { op: "leverage", shard: checkShard(p.shard), coin: checkCoin(p.coin), leverage: checkLeverage(p.leverage) };
    return this.sealed(inner);
  }

  /** Market-open a position at the agreed mid price (IOC). */
  async open(p: { shard: string; coin: Coin; side: Side; size: number; builder?: boolean }): Promise<Answer> {
    const inner: Record<string, unknown> = {
      op: "open",
      shard: checkShard(p.shard),
      coin: checkCoin(p.coin),
      side: checkSide(p.side),
      size: checkPositive("size", p.size),
    };
    if (p.builder) inner.builder = true;
    return this.sealed(inner);
  }

  /** Store a stop; it travels inside the sealed call and is kept sealed by the guard. */
  async seal(p: { shard: string; stop: Stop }): Promise<Answer> {
    return this.sealed({ op: "seal", shard: checkShard(p.shard), stop: checkStop(p.stop) });
  }

  /** Check prices and fire the stop if the sources agree it is hit. dry reports without sending. */
  async tick(p: { shard: string; coin: Coin; dry?: boolean; builder?: boolean }): Promise<Answer> {
    const inner: Record<string, unknown> = { op: "tick", shard: checkShard(p.shard), coin: checkCoin(p.coin) };
    if (p.dry) inner.dry = true;
    if (p.builder) inner.builder = true;
    return this.sealed(inner);
  }

  /** Record which Hyperliquid master account the shard trades for. */
  async register(p: { shard: string; master: string }): Promise<Answer> {
    return this.sealed({ op: "register", shard: checkShard(p.shard), master: checkAddress(p.master) });
  }

  /** Signed track-record totals across all registered shards (EAS off-chain attestation). */
  async proof(): Promise<Answer> {
    return this.sealed({ op: "proof" });
  }
}
