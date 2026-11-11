// Every guard call the server makes goes through here. All ops except box_pub travel as ONE
// sealed box. GuardClient is used where it has the op; the rest are sealed with sealedBox()
// and sent with callGuard(). forward() passes a box sealed in the browser on unchanged,
// with the shard outside so the guard can check it matches the one inside.
// Each call writes a guard_calls row; ticks and orders also write their own rows.
// A box's contents are never logged or stored.
import {
  GuardClient,
  GuardError,
  TAKER_FEE,
  callGuard,
  sealedBox,
  type Answer,
  type Box,
  type Coin,
  type RandomSource,
  type Side,
} from "unhuntable-client";
import type { Db } from "./db.js";
import { newId } from "./db.js";
import type { RefusalCode } from "./refusals.js";

export interface Fill {
  size: number;
  px: number;
  oid: string | null;
  fee: number | null;
}

/** One defence ladder step: action "none", "cut" or "close"; size in coin units; distance to liquidation as a fraction. */
export interface Defence {
  action: string;
  rung: number | null;
  distance: number | null;
  size: number | null;
}

export interface TickShard {
  /** watch, fired, took_profit, no_agreement, already_fired_elsewhere, or null on an error for this shard. */
  done: string | null;
  band: [number, number] | null;
  hasStop: boolean;
  hasTp: boolean;
  defence: Defence | null;
  error: string | null;
}

/** The guard takes at most this many shards in one tick_coin. */
export const MAX_TICK_SHARDS = 32;

export interface VrfDraw {
  outputHex: string;
  proof: string;
  alpha: string;
}

/** Where an order belongs, so the fill is recorded against the right piece. */
export interface OrderContext {
  positionId: string;
  pieceId: string;
}

export interface GuardOps {
  boxPub(): Promise<string>;
  agent(shard: string): Promise<string>;
  register(shard: string, master: string): Promise<void>;
  leverage(shard: string, coin: Coin, leverage: number): Promise<void>;
  open(shard: string, coin: Coin, side: Side, size: number, ctx: OrderContext, opts?: { builder?: boolean }): Promise<Fill>;
  /** The builder address the guard was built with, or null. */
  builder(): Promise<string | null>;
  close(shard: string, coin: Coin, ctx: OrderContext): Promise<Fill | null>;
  vrf(label: string): Promise<VrfDraw>;
  tickCoin(coin: Coin, shards: string[]): Promise<Record<string, TickShard>>;
  defend(shard: string, coin: Coin): Promise<Answer>;
  forward(shard: string, box: Box): Promise<Answer>;
}

/** The guard answered and said no. code is our refusal for it, when there is one. */
export class GuardRefusal extends Error {
  constructor(
    readonly code: RefusalCode,
    readonly reason: string,
  ) {
    super(reason);
    this.name = "GuardRefusal";
  }
}

/** The guard did not answer (network, OutLayer error, or not a guard answer). */
export class GuardUnreachable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardUnreachable";
  }
}

/** Our refusal code for a guard error text. */
export function refusalFor(reason: string): RefusalCode {
  const r = reason.toLowerCase();
  if (/sources? agree|disagree/.test(r)) return "prices_disagree";
  if (/stale|out of date|too old/.test(r)) return "stale_price";
  if (/too few|not enough|no price|sources? answered/.test(r)) return "too_few_sources";
  if (/\bcap\b/.test(r)) return "over_cap";
  return "venue_rejected";
}

/** The order result inside a guard answer: {"hl": {"http", "body"}} with Hyperliquid's order reply. */
export function fillOf(out: Answer): Fill | null {
  const hl = out.hl as { http?: number; body?: any } | undefined;
  const body = hl?.body;
  if (!hl || (hl.http !== undefined && hl.http !== 200) || body?.status !== "ok") {
    const reason = typeof body?.response === "string" ? body.response : typeof body === "string" ? body : "the order was not accepted";
    throw new GuardRefusal("venue_rejected", reason);
  }
  const st = body?.response?.data?.statuses?.[0];
  if (st && typeof st.error === "string") throw new GuardRefusal("venue_rejected", st.error);
  const f = st?.filled;
  if (!f) return null;
  const size = Number(f.totalSz);
  const px = Number(f.avgPx);
  return { size, px, oid: f.oid === undefined ? null : String(f.oid), fee: size > 0 && px > 0 ? TAKER_FEE * size * px : null };
}

export interface GuardAdapterOptions {
  db: Db;
  network: string;
  owner: string;
  project: string;
  paymentKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  boxPub?: string;
  random?: RandomSource;
  now?: () => number;
}

export class GuardAdapter implements GuardOps {
  private readonly client: GuardClient;
  private readonly now: () => number;
  private gpk?: string;

  constructor(private readonly o: GuardAdapterOptions) {
    this.now = o.now ?? Date.now;
    this.gpk = o.boxPub;
    this.client = new GuardClient({
      owner: o.owner,
      project: o.project,
      paymentKey: o.paymentKey,
      baseUrl: o.baseUrl,
      fetch: o.fetch,
      boxPub: o.boxPub,
      random: o.random,
    });
  }

  private record(op: string, shard: string | null, error: string | null): void {
    this.o.db
      .prepare("INSERT INTO guard_calls (id, op, shard_id, ok, error, created_ms, network) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(newId(), op, shard, error === null ? 1 : 0, error, this.now(), this.o.network);
  }

  /** Run one call, record it, and sort its failure into refusal or unreachable. */
  private async run<T>(op: string, shard: string | null, fn: () => Promise<T>): Promise<T> {
    try {
      const out = await fn();
      this.record(op, shard, null);
      return out;
    } catch (e) {
      if (e instanceof GuardRefusal) {
        this.record(op, shard, e.reason.slice(0, 300));
        throw e;
      }
      if (e instanceof GuardError) {
        this.record(op, shard, e.message.slice(0, 300));
        throw new GuardRefusal(refusalFor(e.message), e.message);
      }
      this.record(op, shard, "unreachable");
      throw new GuardUnreachable(e instanceof Error ? e.message : String(e));
    }
  }

  async boxPub(): Promise<string> {
    if (this.gpk) return this.gpk;
    this.gpk = await this.run("box_pub", null, () => this.client.boxPub());
    return this.gpk;
  }

  /** One sealed call for an op the client library has no method for. */
  private async sealed(inner: Record<string, unknown>): Promise<Answer> {
    const gpk = await this.boxPub();
    return callGuard(this.o.owner, this.o.project, this.o.paymentKey, sealedBox(gpk, inner, this.o.random), {
      fetch: this.o.fetch,
      baseUrl: this.o.baseUrl,
    });
  }

  private order(kind: "open" | "close", ctx: OrderContext, f: Fill | null): void {
    this.o.db
      .prepare(
        `INSERT INTO piece_orders (id, position_id, piece_id, kind, size, px, hl_oid, fee, created_ms, network)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(newId(), ctx.positionId, ctx.pieceId, kind, f?.size ?? null, f?.px ?? null, f?.oid ?? null, f?.fee ?? null, this.now(), this.o.network);
  }

  async builder(): Promise<string | null> {
    const out = await this.run("addr", null, () => this.client.addr());
    const b = out.builder;
    if (b === null || b === undefined) return null;
    if (typeof b !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(b)) throw new GuardUnreachable("guard addr answer has a builder that is not an address");
    return b.toLowerCase();
  }

  async agent(shard: string): Promise<string> {
    await this.boxPub();
    const out = await this.run("agent", shard, () => this.client.agent(shard));
    if (typeof out.agent !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(out.agent)) throw new GuardUnreachable("guard agent answer has no address");
    return out.agent.toLowerCase();
  }

  async register(shard: string, master: string): Promise<void> {
    await this.boxPub();
    await this.run("register", shard, () => this.client.register({ shard, master }));
  }

  async leverage(shard: string, coin: Coin, leverage: number): Promise<void> {
    await this.boxPub();
    await this.run("leverage", shard, async () => {
      const out = await this.client.leverage({ shard, coin, leverage });
      const body = (out.hl as { body?: any } | undefined)?.body;
      if (body && body.status !== undefined && body.status !== "ok") {
        throw new GuardRefusal("venue_rejected", typeof body.response === "string" ? body.response : "leverage was not accepted");
      }
      return out;
    });
  }

  async open(shard: string, coin: Coin, side: Side, size: number, ctx: OrderContext, opts: { builder?: boolean } = {}): Promise<Fill> {
    await this.boxPub();
    const fill = await this.run("open", shard, async () => {
      const f = fillOf(await this.client.open({ shard, coin, side, size, ...(opts.builder ? { builder: true } : {}) }));
      if (!f || !(f.size > 0)) throw new GuardRefusal("venue_rejected", "the order did not fill");
      return f;
    });
    this.order("open", ctx, fill);
    return fill;
  }

  /** Close the shard's whole position in a coin. Null when nothing was open. */
  async close(shard: string, coin: Coin, ctx: OrderContext): Promise<Fill | null> {
    const fill = await this.run("close", shard, async () => {
      const out = await this.sealed({ op: "close", shard, coin });
      if (out.done === "nothing_open") return null;
      if (out.done === "no_agreement") throw new GuardRefusal("prices_disagree", "price sources do not agree");
      return fillOf(out);
    });
    this.order("close", ctx, fill);
    return fill;
  }

  async vrf(label: string): Promise<VrfDraw> {
    return this.run("vrf", null, async () => {
      const out = await this.sealed({ op: "vrf", label });
      if (typeof out.output_hex !== "string" || !/^[0-9a-fA-F]+$/.test(out.output_hex) || typeof out.proof !== "string") {
        throw new GuardUnreachable("guard vrf answer is not in the expected shape");
      }
      return { outputHex: out.output_hex.toLowerCase(), proof: out.proof, alpha: String(out.alpha ?? label) };
    });
  }

  /** Stop, take-profit and one defence step for up to MAX_TICK_SHARDS shards of a coin, at one price fetch. */
  async tickCoin(coin: Coin, shards: string[]): Promise<Record<string, TickShard>> {
    if (shards.length === 0 || shards.length > MAX_TICK_SHARDS) throw new Error(`tick_coin takes 1-${MAX_TICK_SHARDS} shards`);
    const out = await this.run("tick_coin", null, () => this.sealed({ op: "tick_coin", coin, shards, defend: true }));
    const raw = (out.shards ?? {}) as Record<string, any>;
    const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
    const res: Record<string, TickShard> = {};
    for (const [shard, s] of Object.entries(raw)) {
      if (typeof s?.error === "string") {
        res[shard] = { done: null, band: null, hasStop: false, hasTp: false, defence: null, error: s.error };
        continue;
      }
      const band = Array.isArray(s?.band) && s.band.length === 2 && s.band.every((x: unknown) => typeof x === "number") ? (s.band as [number, number]) : null;
      const d = s?.defence;
      res[shard] = {
        done: typeof s?.done === "string" ? s.done : null,
        band,
        hasStop: s?.has_stop === true,
        hasTp: s?.has_tp === true,
        defence: d && typeof d === "object" && typeof d.action === "string" ? { action: d.action, rung: num(d.rung), distance: num(d.distance), size: num(d.size) } : null,
        error: null,
      };
    }
    this.o.db
      .prepare("INSERT INTO ticks (id, coin, shards_json, done_json, band_json, call_id, cost, created_ms, network) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        newId(),
        coin,
        JSON.stringify(shards),
        JSON.stringify(Object.fromEntries(Object.entries(res).map(([k, v]) => [k, v.done]))),
        JSON.stringify(Object.fromEntries(Object.entries(res).map(([k, v]) => [k, v.band]))),
        null,
        null,
        this.now(),
        this.o.network,
      );
    return res;
  }

  async defend(shard: string, coin: Coin): Promise<Answer> {
    return this.run("defend", shard, () => this.sealed({ op: "defend", shard, coin }));
  }

  async forward(shard: string, box: Box): Promise<Answer> {
    return this.run("forward", shard, () =>
      callGuard(this.o.owner, this.o.project, this.o.paymentKey, { box, shard }, { fetch: this.o.fetch, baseUrl: this.o.baseUrl }),
    );
  }
}
