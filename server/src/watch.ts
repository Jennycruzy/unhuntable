// Watching open pieces and refilling them.
// Heartbeat: every open piece is ticked through the guard's tick_coin every 120 s per coin,
// and at once when the public mid leaves any open piece's band (the server polls allMids
// every 5 s). The server never knows a stop, only the band the guard gave back.
// Defence: when the guard cut or closed a piece, the user gets an alert, and with
// auto_refill on (and under the day's cap) a refill goes from the private balance to that
// same piece's own address: the smallest ladder amount that restores its reserve.
import { LADDER, USDC_NEAR, ladderAmount, toUnits, type Coin } from "unhuntable-client";
import { addAlert, balanceWallet, walletById, type Ctx } from "./ctx.js";
import { newId } from "./db.js";
import { GuardUnreachable, MAX_TICK_SHARDS, type Defence } from "./guard.js";
import { sentence } from "./refusals.js";

export const HEARTBEAT_MS = 120_000;
export const MIDS_POLL_MS = 5_000;
/** A refill counts as in flight this long after it was sent. */
export const REFILL_IN_FLIGHT_MS = 3 * 60_000;

interface OpenPiece {
  pp_id: string;
  position_id: string;
  user_id: string;
  coin: Coin;
  idx: number;
  piece_id: string;
  shard_id: string;
  funding_usd: number;
  size: number;
  band_lo: number | null;
  band_hi: number | null;
  last_tick_ms: number | null;
}

function openPieces(ctx: Ctx, coin?: Coin): OpenPiece[] {
  return ctx.db
    .prepare(
      `SELECT pp.id AS pp_id, pp.position_id, x.user_id, x.coin, pp.idx, pp.piece_id, p.shard_id, pp.funding_usd, pp.size,
              pp.band_lo, pp.band_hi, pp.last_tick_ms
       FROM position_pieces pp JOIN positions x ON x.id = pp.position_id JOIN pieces p ON p.id = pp.piece_id
       WHERE x.state = 'open' AND pp.state = 'open' AND x.network = ? ${coin ? "AND x.coin = ?" : ""}
       ORDER BY pp.position_id, pp.idx`,
    )
    .all(...(coin ? [ctx.network, coin] : [ctx.network])) as OpenPiece[];
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Tick every open piece of a coin through the guard and act on what comes back. */
export async function tickCoin(ctx: Ctx, coin: Coin): Promise<void> {
  const all = openPieces(ctx, coin);
  for (let i = 0; i < all.length; i += MAX_TICK_SHARDS) await tickGroup(ctx, coin, all.slice(i, i + MAX_TICK_SHARDS));
}

async function tickGroup(ctx: Ctx, coin: Coin, open: OpenPiece[]): Promise<void> {
  if (open.length === 0) return;
  let res;
  try {
    res = await ctx.guard.tickCoin(coin, open.map((o) => o.shard_id));
  } catch (e) {
    if (e instanceof GuardUnreachable) {
      ctx.db.prepare(`UPDATE positions SET guard = 'unreachable' WHERE id IN (${open.map(() => "?").join(",")})`).run(...open.map((o) => o.position_id));
    }
    throw e;
  }
  const now = ctx.now();
  for (const o of open) {
    const r = res[o.shard_id];
    ctx.db.prepare("UPDATE position_pieces SET last_tick_ms = ? WHERE id = ?").run(now, o.pp_id);
    if (!r || r.error !== null) continue;
    ctx.db.prepare("UPDATE positions SET guard = 'ok' WHERE id = ?").run(o.position_id);
    ctx.db
      .prepare("UPDATE position_pieces SET band_lo = ?, band_hi = ?, has_stop = ?, has_tp = ? WHERE id = ?")
      .run(r.band?.[0] ?? null, r.band?.[1] ?? null, r.hasStop ? 1 : 0, r.hasTp ? 1 : 0, o.pp_id);
    if (r.done === "fired" || r.done === "took_profit") {
      ctx.db.prepare("UPDATE position_pieces SET state = 'closed' WHERE id = ?").run(o.pp_id);
      addAlert(ctx, o.user_id, `${coin} piece Account ${o.idx + 1}: ${r.done === "fired" ? "the stop fired" : "the take-profit filled"} and the piece is closed.`, o.position_id);
      continue;
    }
    const d = r.defence;
    if (d && (d.action === "cut" || d.action === "close")) defence(ctx, o, d);
  }
  closeFinished(ctx, open.map((o) => o.position_id));
}

function closeFinished(ctx: Ctx, ids: string[]): void {
  for (const id of new Set(ids)) {
    const left = ctx.db.prepare("SELECT COUNT(*) AS n FROM position_pieces WHERE position_id = ? AND state != 'closed'").get(id) as { n: number };
    if (left.n === 0) ctx.db.prepare("UPDATE positions SET state = 'closed' WHERE id = ? AND state = 'open'").run(id);
  }
}

function pct(x: number | null): string | null {
  return x === null || !Number.isFinite(x) ? null : `${Math.round(x * 100)}%`;
}

function defence(ctx: Ctx, o: OpenPiece, d: Defence): void {
  const name = `${o.coin} piece Account ${o.idx + 1}`;
  const dist = pct(d.distance);
  if (d.action === "cut") {
    // the guard answers the size it cut in coin units; the piece keeps the rest
    const cut = d.size !== null && o.size > 0 ? pct(Math.min(1, d.size / o.size)) : null;
    if (d.size !== null) ctx.db.prepare("UPDATE position_pieces SET size = MAX(0, ROUND(size - ?, 8)) WHERE id = ?").run(d.size, o.pp_id);
    addAlert(ctx, o.user_id, `${name}: cut${cut ? ` ${cut}` : ""}${dist ? ` when liquidation was ${dist} away` : ""}.`, o.position_id);
  } else {
    ctx.db.prepare("UPDATE position_pieces SET state = 'closed' WHERE id = ?").run(o.pp_id);
    addAlert(ctx, o.user_id, `${name}: closed to keep it away from liquidation.`, o.position_id);
    return;
  }
  queueRefill(ctx, o);
}

/** Queue one refill for a piece the guard cut, if the user allows it and the day's cap has room. */
export function queueRefill(ctx: Ctx, o: { user_id: string; piece_id: string; position_id: string; idx: number; coin: string }): string | null {
  const s = ctx.db.prepare("SELECT auto_refill, refill_cap_usd_per_day FROM settings WHERE user_id = ?").get(o.user_id) as
    | { auto_refill: number; refill_cap_usd_per_day: number }
    | undefined;
  if (!s || s.auto_refill !== 1) return null;
  const now = ctx.now();
  const inFlight = ctx.db
    .prepare("SELECT COUNT(*) AS n FROM refills WHERE piece_id = ? AND (status = 'queued' OR (status = 'sent' AND created_ms > ?))")
    .get(o.piece_id, now - REFILL_IN_FLIGHT_MS) as { n: number };
  if (inFlight.n > 0) {
    addAlert(ctx, o.user_id, `${o.coin} piece Account ${o.idx + 1}: ${sentence("refill_pending")}`, o.position_id);
    return null;
  }
  // The reserve the plan gave this piece; refill with the smallest ladder amount that covers it.
  const planJson = ctx.db.prepare("SELECT plan_json FROM positions WHERE id = ?").get(o.position_id) as { plan_json: string | null } | undefined;
  const reserve = planJson?.plan_json ? Number(JSON.parse(planJson.plan_json).pieces?.[o.idx]?.reserveUsd) : NaN;
  const amount = ladderAmount(Number.isFinite(reserve) && reserve > 0 ? reserve : LADDER[0]) ?? LADDER[LADDER.length - 1];
  const spent = ctx.db
    .prepare(
      `SELECT COALESCE(SUM(r.amount), 0) AS t FROM refills r JOIN pieces p ON p.id = r.piece_id
       WHERE p.user_id = ? AND r.day = ? AND r.status != 'failed'`,
    )
    .get(o.user_id, day(now)) as { t: number };
  if (spent.t + amount > s.refill_cap_usd_per_day) {
    addAlert(ctx, o.user_id, `${o.coin} piece Account ${o.idx + 1}: ${sentence("refill_cap")}`, o.position_id);
    return null;
  }
  const id = newId();
  ctx.db
    .prepare("INSERT INTO refills (id, piece_id, amount, day, status, created_ms, network) VALUES (?, ?, ?, ?, 'queued', ?, ?)")
    .run(id, o.piece_id, amount, day(now), now, ctx.network);
  ctx.jobs.enqueue("refill", { refillId: id }, `refill:${id}`);
  addAlert(ctx, o.user_id, `${o.coin} piece Account ${o.idx + 1}: ${sentence("reserve_low")}`, o.position_id);
  return id;
}

/** Send a queued refill: private balance -> the same piece's own address, nowhere else. */
export async function sendRefill(ctx: Ctx, refillId: string): Promise<void> {
  const r = ctx.db.prepare("SELECT * FROM refills WHERE id = ?").get(refillId) as
    | { id: string; piece_id: string; amount: number; status: string }
    | undefined;
  if (!r || r.status !== "queued") return;
  const piece = walletById(ctx, r.piece_id);
  const bal = balanceWallet(ctx, piece.user_id);
  if (!piece.hl_address) throw new Error("piece has no address");
  const sub = await ctx.wallet.withdraw(bal.wallet_id, {
    chain: "hypercore",
    to: piece.hl_address,
    amount: toUnits(String(r.amount), 6).toString(),
    token: USDC_NEAR,
  });
  ctx.db.prepare("UPDATE refills SET status = 'sent', request_id = ? WHERE id = ?").run(sub.requestId, r.id);
  ctx.db
    .prepare("INSERT INTO fundings (id, piece_id, direction, amount, route, request_id, status, created_ms, network) VALUES (?, ?, 'refill', ?, 'hypercore', ?, 'sent', ?, ?)")
    .run(newId(), piece.id, r.amount, sub.requestId, ctx.now(), ctx.network);
}

/** Tick each coin whose last tick is HEARTBEAT_MS old. Returns the coins ticked. */
export async function heartbeat(ctx: Ctx): Promise<Coin[]> {
  const now = ctx.now();
  const due = new Set<Coin>();
  for (const o of openPieces(ctx)) if (o.last_tick_ms === null || now - o.last_tick_ms >= HEARTBEAT_MS) due.add(o.coin);
  for (const c of due) await tickCoin(ctx, c);
  return [...due];
}

/** Read public mids; tick a coin at once when its mid is outside any open piece's band. */
export async function watchMids(ctx: Ctx): Promise<Coin[]> {
  const open = openPieces(ctx);
  if (open.length === 0) return [];
  const mids = await ctx.hl.allMids();
  const out = new Set<Coin>();
  for (const o of open) {
    const m = mids[o.coin];
    if (!(m > 0) || o.band_lo === null || o.band_hi === null) continue;
    if (m < o.band_lo || m > o.band_hi) out.add(o.coin);
  }
  for (const c of out) await tickCoin(ctx, c);
  return [...out];
}
