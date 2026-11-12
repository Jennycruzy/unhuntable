// Followers: traders sell keys to their trading, without ever showing an open position.
//
// A COPY KEY copies the trader's crypto trades into the follower's own pieces: same coin, side
// and leverage, the follower's own size, split and timed by the follower's own random draw, after
// the trader's position is open. The follower sees their own copy, never the trader's position.
// A VIEWING KEY shows the trader's CLOSED trades: coin, side, size, entry, exit and result.
// Nothing open is ever shown to anyone: a closed trade cannot be hunted or front-run.
//
// Keys are paid day by day with private transfers (Confidential Intents) from the follower's
// private balance to the trader's, only to traders the follower approved in their own wallet
// (the balance lock lists them), and only while the key is on. Stopping a key stops the payments.
//
// A trader's track record is signed by the guard: every piece ever registered under the
// trader's tag, summed from Hyperliquid inside the enclave. No piece address leaves the guard.
import { hlAsset, USDC_NEAR } from "unhuntable-client";
import { z } from "zod";
import { addAlert, balanceWallet, userRow, usd, walletByLabel, type Ctx } from "./ctx.js";
import { newId } from "./db.js";
import type { PositionEvent } from "./events.js";
import { GuardRefusal, GuardUnreachable } from "./guard.js";
import { HyperliquidError } from "./hl.js";
import { OutLayerWalletError } from "./outlayer.js";
import { buildBatch, readBack, walletAccount } from "./policy.js";
import { PlanBody, balanceItem, closePosition, createPosition } from "./positions.js";
import { ApiError } from "./refusals.js";
import { traderTag } from "./tags.js";

export const DAY_MS = 24 * 60 * 60_000;
/** A record is read from the guard at most this often per trader. */
export const RECORD_EVERY_MS = 10 * 60_000;
/** Copies start a random 30 s to 5 min after the trader's position is open, each on its own. */
export const COPY_DELAY_MIN_MS = 30_000;
export const COPY_DELAY_MAX_MS = 5 * 60_000;
/** A payment's status is read this often, for at most this long. */
export const PAY_POLL_MS = 15_000;
export const PAY_POLL_FOR_MS = 30 * 60_000;
/** The smallest copy is $15, one piece: each piece must stay at least $12 after its size is rounded. From $30 a copy is split into pieces. */
export const MIN_COPY_USD = 15;
export const SPLIT_FROM_USD = 30;

export const HANDLE = /^[a-z0-9_]{3,20}$/;

export const TraderBody = z
  .object({
    handle: z.string().regex(HANDLE),
    copyUsdDay: z.number().finite().min(0.01).max(100),
    viewUsdDay: z.number().finite().min(0.01).max(100),
    open: z.boolean(),
  })
  .strict();

export const FollowBody = z
  .object({
    handle: z.string().regex(HANDLE),
    kind: z.enum(["copy", "view"]),
    copyUsd: z.number().finite().min(MIN_COPY_USD).max(5000).optional(),
  })
  .strict()
  .refine((b) => b.kind === "view" || b.copyUsd !== undefined, { message: "a copy key needs a copy size" });

interface TraderRow {
  user_id: string;
  handle: string;
  copy_usd_day: number;
  view_usd_day: number;
  open: number;
  created_ms: number;
}

export interface KeyRow {
  id: string;
  trader_id: string;
  holder_id: string;
  kind: "copy" | "view";
  state: "pending" | "active" | "paused" | "stopped";
  usd_day: number;
  copy_usd: number | null;
  paid_through_ms: number | null;
  pause_reason: string | null;
  created_ms: number;
  ended_ms: number | null;
}

interface PositionLite {
  id: string;
  user_id: string;
  coin: string;
  side: "long" | "short";
  notional_usd: number;
  leverage: number;
  state: string;
  created_ms: number;
  copy_of: string | null;
  result_json: string | null;
}

export interface TradeResult {
  pnlUsd: number;
  feesUsd: number;
  entryPx: number | null;
  exitPx: number | null;
  closedMs: number | null;
}

// ------------------------------------------------------------ rows

function traderRow(ctx: Ctx, handle: string): TraderRow {
  const t = ctx.db.prepare("SELECT * FROM traders WHERE handle = ?").get(handle) as TraderRow | undefined;
  if (!t) throw new ApiError("trader_not_found");
  return t;
}

function traderOf(ctx: Ctx, userId: string): TraderRow | undefined {
  return ctx.db.prepare("SELECT * FROM traders WHERE user_id = ?").get(userId) as TraderRow | undefined;
}

function keyRow(ctx: Ctx, id: string): KeyRow {
  const k = ctx.db.prepare("SELECT * FROM follow_keys WHERE id = ?").get(id) as KeyRow | undefined;
  if (!k) throw new ApiError("not_found");
  return k;
}

function ownKey(ctx: Ctx, holderId: string, id: string): KeyRow {
  const k = keyRow(ctx, id);
  if (k.holder_id !== holderId) throw new ApiError("not_found");
  return k;
}

function positionLite(ctx: Ctx, id: string): PositionLite | undefined {
  return ctx.db.prepare("SELECT id, user_id, coin, side, notional_usd, leverage, state, created_ms, copy_of, result_json FROM positions WHERE id = ?").get(id) as
    | PositionLite
    | undefined;
}

/** A key is on when it is active and paid through now (or its payment for today is still settling). */
function keyOn(ctx: Ctx, k: KeyRow): boolean {
  if (k.state !== "active") return false;
  if (k.paid_through_ms !== null && k.paid_through_ms >= ctx.now()) return true;
  const sending = ctx.db.prepare("SELECT 1 FROM key_payments WHERE key_id = ? AND state = 'sent'").get(k.id);
  return sending !== undefined;
}

function result(p: PositionLite): TradeResult | null {
  return p.result_json ? (JSON.parse(p.result_json) as TradeResult) : null;
}

// ------------------------------------------------------------ traders

/** Become a trader, or change handle, prices or whether new keys are sold. */
export function setTrader(ctx: Ctx, userId: string, body: z.infer<typeof TraderBody>) {
  userRow(ctx, userId);
  // income lands in the trader's own private balance
  balanceWallet(ctx, userId);
  const taken = ctx.db.prepare("SELECT user_id FROM traders WHERE handle = ?").get(body.handle) as { user_id: string } | undefined;
  if (taken && taken.user_id !== userId) throw new ApiError("handle_taken");
  ctx.db
    .prepare(
      `INSERT INTO traders (user_id, handle, copy_usd_day, view_usd_day, open, created_ms, network) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET handle = excluded.handle, copy_usd_day = excluded.copy_usd_day, view_usd_day = excluded.view_usd_day, open = excluded.open`,
    )
    .run(userId, body.handle, body.copyUsdDay, body.viewUsdDay, body.open ? 1 : 0, ctx.now(), ctx.network);
  return myTrader(ctx, userId);
}

/** The signed-in user's trader profile, with what the keys earned. Followers are counted, never named. */
export function myTrader(ctx: Ctx, userId: string) {
  const t = traderOf(ctx, userId);
  if (!t) return { trader: null };
  const earned = ctx.db
    .prepare(
      `SELECT COALESCE(SUM(p.amount_usd), 0) AS usd, COUNT(*) AS n FROM key_payments p JOIN follow_keys k ON k.id = p.key_id
       WHERE k.trader_id = ? AND p.state = 'done'`,
    )
    .get(userId) as { usd: number; n: number };
  return { trader: { ...card(ctx, t), earnedUsd: usd(earned.usd), payments: earned.n } };
}

/** What anyone may see of a trader. No position, address, stop or level: counts, prices, closed results and the guard's record. */
export function card(ctx: Ctx, t: TraderRow) {
  const count = (kind: string) =>
    (ctx.db.prepare("SELECT COUNT(*) AS n FROM follow_keys WHERE trader_id = ? AND kind = ? AND state = 'active'").get(t.user_id, kind) as { n: number }).n;
  const closed = ownClosed(ctx, t.user_id);
  const results = closed.map(result).filter((r): r is TradeResult => r !== null);
  const rec = ctx.db.prepare("SELECT * FROM trader_records WHERE trader_id = ? ORDER BY created_ms DESC LIMIT 1").get(t.user_id) as
    | { eas_json: string; totals_json: string; created_ms: number }
    | undefined;
  return {
    handle: t.handle,
    tag: traderTag(t.user_id),
    copyUsdDay: t.copy_usd_day,
    viewUsdDay: t.view_usd_day,
    open: t.open === 1,
    sinceMs: t.created_ms,
    copiers: count("copy"),
    viewers: count("view"),
    closedTrades: results.length,
    wins: results.filter((r) => r.pnlUsd > 0).length,
    resultUsd: usd(results.reduce((a, r) => a + r.pnlUsd, 0)),
    record: rec ? { ...(JSON.parse(rec.totals_json) as object), asOfMs: rec.created_ms, eas: JSON.parse(rec.eas_json) as object } : null,
  };
}

/** The trader's own closed trades (not copies of someone else). */
function ownClosed(ctx: Ctx, userId: string): PositionLite[] {
  return ctx.db
    .prepare(
      `SELECT id, user_id, coin, side, notional_usd, leverage, state, created_ms, copy_of, result_json FROM positions
       WHERE user_id = ? AND copy_of IS NULL AND state = 'closed' ORDER BY created_ms DESC`,
    )
    .all(userId) as PositionLite[];
}

export function listTraders(ctx: Ctx) {
  const rows = ctx.db.prepare("SELECT * FROM traders WHERE network = ? ORDER BY created_ms").all(ctx.network) as TraderRow[];
  const cards = rows.map((t) => card(ctx, t));
  cards.sort((a, b) => Number(b.resultUsd) - Number(a.resultUsd));
  return { traders: cards };
}

export function traderCard(ctx: Ctx, handle: string) {
  return { trader: card(ctx, traderRow(ctx, handle)) };
}

/** Ask the guard for the trader's signed record, at most once per RECORD_EVERY_MS. */
export async function refreshRecord(ctx: Ctx, handle: string) {
  const t = traderRow(ctx, handle);
  const last = ctx.db.prepare("SELECT created_ms FROM trader_records WHERE trader_id = ? ORDER BY created_ms DESC LIMIT 1").get(t.user_id) as
    | { created_ms: number }
    | undefined;
  if (!last || ctx.now() - last.created_ms >= RECORD_EVERY_MS) {
    let r;
    try {
      r = await ctx.guard.traderRecord(traderTag(t.user_id));
    } catch (e) {
      if (e instanceof GuardUnreachable) throw new ApiError("guard_unreachable");
      if (e instanceof GuardRefusal) throw new ApiError(e.code, { reason: e.reason });
      throw e;
    }
    ctx.db
      .prepare("INSERT INTO trader_records (id, trader_id, eas_json, totals_json, created_ms, network) VALUES (?, ?, ?, ?, ?, ?)")
      .run(newId(), t.user_id, JSON.stringify(r.eas), JSON.stringify(r.totals), ctx.now(), ctx.network);
  }
  return traderCard(ctx, handle);
}

/** Closed trades, for the trader and for holders of a key that is on. Open positions never appear. */
export function closedTrades(ctx: Ctx, viewerId: string, handle: string) {
  const t = traderRow(ctx, handle);
  if (t.user_id !== viewerId) {
    const keys = ctx.db.prepare("SELECT * FROM follow_keys WHERE trader_id = ? AND holder_id = ? AND state = 'active'").all(t.user_id, viewerId) as KeyRow[];
    if (!keys.some((k) => keyOn(ctx, k))) throw new ApiError("key_needed");
  }
  return {
    handle: t.handle,
    trades: ownClosed(ctx, t.user_id).map((p) => {
      const r = result(p);
      return {
        coin: p.coin,
        side: p.side,
        notionalUsd: p.notional_usd,
        leverage: p.leverage,
        openedMs: p.created_ms,
        closedMs: r?.closedMs ?? null,
        entryPx: r?.entryPx ?? null,
        exitPx: r?.exitPx ?? null,
        pnlUsd: r ? usd(r.pnlUsd) : null,
        feesUsd: r ? usd(r.feesUsd) : null,
      };
    }),
  };
}

// ------------------------------------------------------------ keys (the follower)

/** Start buying a key: the follower's wallet approves paying this trader (the balance lock lists them). */
export async function follow(ctx: Ctx, holderId: string, body: z.infer<typeof FollowBody>) {
  const id = createKey(ctx, holderId, body);
  return { keyId: id, state: "pending" as const, policyBatch: await keyBatch(ctx, holderId, id) };
}

/** The wallet approval a new key waits for: the private balance's lock, now listing the trader. */
export async function keyBatch(ctx: Ctx, holderId: string, keyId: string) {
  const k = ownKey(ctx, holderId, keyId);
  if (k.state !== "pending") throw new ApiError("wrong_state");
  const u = userRow(ctx, holderId);
  return buildBatch(ctx, u.near_account, [balanceItem(ctx, holderId)]);
}

/**
 * An agent asks for a key for its owner. It waits until the owner approves it in the
 * app: only the owner's wallet can let the private balance pay a trader.
 */
export function agentAskKey(ctx: Ctx, ownerId: string, agentName: string, maxUsd: number, body: z.infer<typeof FollowBody>) {
  if (body.kind === "copy" && body.copyUsd! > maxUsd) throw new ApiError("agent_limit", { reason: `its largest size is $${maxUsd}` });
  const id = createKey(ctx, ownerId, body);
  const k = keyRow(ctx, id);
  addAlert(
    ctx,
    ownerId,
    `Your agent ${agentName} asked for a ${body.kind === "copy" ? `copy key ($${usd(body.copyUsd!)} per copy)` : "viewing key"} to @${body.handle} at $${usd(k.usd_day)} a day. Approve it on the Traders screen, or stop it there.`,
  );
  return { keyId: id, state: "pending" as const };
}

function createKey(ctx: Ctx, holderId: string, body: z.infer<typeof FollowBody>): string {
  const t = traderRow(ctx, body.handle);
  if (t.user_id === holderId) throw new ApiError("follow_self");
  if (t.open !== 1) throw new ApiError("trader_closed");
  balanceWallet(ctx, holderId);
  if (!walletByLabel(ctx, t.user_id, "balance")?.wallet_pubkey) throw new ApiError("trader_closed");
  const had = ctx.db
    .prepare("SELECT id FROM follow_keys WHERE trader_id = ? AND holder_id = ? AND kind = ? AND state != 'stopped'")
    .get(t.user_id, holderId, body.kind) as { id: string } | undefined;
  if (had) throw new ApiError("key_exists");
  const id = newId();
  ctx.db
    .prepare(
      `INSERT INTO follow_keys (id, trader_id, holder_id, kind, state, usd_day, copy_usd, created_ms, network)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    )
    .run(id, t.user_id, holderId, body.kind, body.kind === "copy" ? t.copy_usd_day : t.view_usd_day, body.kind === "copy" ? body.copyUsd! : null, ctx.now(), ctx.network);
  return id;
}

/** After the wallet approved the lock: read it back, switch the key on and pay the first day. */
export async function confirmFollow(ctx: Ctx, holderId: string, keyId: string) {
  const k = ownKey(ctx, holderId, keyId);
  if (k.state !== "pending") throw new ApiError("wrong_state");
  const u = userRow(ctx, holderId);
  const item = balanceItem(ctx, holderId);
  await readBack(ctx, u.near_account, item.wallet, false);
  ctx.db.transaction(() => {
    ctx.db.prepare("UPDATE pieces SET policy_state = 'locked', policy_json = ? WHERE id = ?").run(JSON.stringify(item.policy), item.wallet.id);
    ctx.db.prepare("UPDATE follow_keys SET state = 'active' WHERE id = ?").run(k.id);
  })();
  ctx.jobs.enqueue("key_bill", { keyId: k.id }, `key_bill:${k.id}:${ctx.now()}`, ctx.now());
  return { ok: true as const, keyId: k.id, state: "active" as const };
}

/** Stop a key: no more payments, no new copies. Copies already open still close with the trader's. */
export function stopKey(ctx: Ctx, holderId: string, keyId: string) {
  const k = ownKey(ctx, holderId, keyId);
  if (k.state === "stopped") return { ok: true as const, state: "stopped" as const };
  ctx.db.prepare("UPDATE follow_keys SET state = 'stopped', ended_ms = ? WHERE id = ?").run(ctx.now(), k.id);
  return { ok: true as const, state: "stopped" as const };
}

/** Switch a paused key back on (after topping up the private balance): pays today again. */
export function resumeKey(ctx: Ctx, holderId: string, keyId: string) {
  const k = ownKey(ctx, holderId, keyId);
  if (k.state !== "paused") throw new ApiError("wrong_state");
  ctx.db.prepare("UPDATE follow_keys SET state = 'active', pause_reason = NULL WHERE id = ?").run(k.id);
  ctx.jobs.enqueue("key_bill", { keyId: k.id }, `key_bill:${k.id}:${ctx.now()}`, ctx.now());
  return { ok: true as const, state: "active" as const };
}

export function myKeys(ctx: Ctx, holderId: string) {
  const rows = ctx.db.prepare("SELECT * FROM follow_keys WHERE holder_id = ? ORDER BY created_ms DESC").all(holderId) as KeyRow[];
  return {
    keys: rows.map((k) => {
      const t = ctx.db.prepare("SELECT handle FROM traders WHERE user_id = ?").get(k.trader_id) as { handle: string };
      const paid = ctx.db.prepare("SELECT COALESCE(SUM(amount_usd), 0) AS usd FROM key_payments WHERE key_id = ? AND state = 'done'").get(k.id) as { usd: number };
      const copies = ctx.db.prepare("SELECT state, follower_position_id, reason, created_ms FROM copies WHERE key_id = ? ORDER BY created_ms DESC LIMIT 20").all(k.id) as {
        state: string;
        follower_position_id: string | null;
        reason: string | null;
        created_ms: number;
      }[];
      return {
        id: k.id,
        handle: t.handle,
        kind: k.kind,
        state: k.state,
        on: keyOn(ctx, k),
        usdDay: k.usd_day,
        copyUsd: k.copy_usd,
        paidThroughMs: k.paid_through_ms,
        pauseReason: k.pause_reason,
        paidUsd: usd(paid.usd),
        copies: copies.map((c) => ({ state: c.state, positionId: c.follower_position_id, reason: c.reason, ms: c.created_ms })),
      };
    }),
  };
}

// ------------------------------------------------------------ paying for keys

function pause(ctx: Ctx, k: KeyRow, reason: string, text: string): void {
  ctx.db.prepare("UPDATE follow_keys SET state = 'paused', pause_reason = ? WHERE id = ? AND state = 'active'").run(reason, k.id);
  addAlert(ctx, k.holder_id, text);
}

/** Pay the next day of a key that is on, by private transfer to the trader's private balance. */
export async function billKey(ctx: Ctx, keyId: string): Promise<void> {
  const k = keyRow(ctx, keyId);
  if (k.state !== "active") return;
  const now = ctx.now();
  if (k.paid_through_ms !== null && k.paid_through_ms - now > 60_000) {
    ctx.jobs.enqueue("key_bill", { keyId }, `key_bill:${keyId}:${k.paid_through_ms}`, k.paid_through_ms);
    return;
  }
  if (ctx.db.prepare("SELECT 1 FROM key_payments WHERE key_id = ? AND state = 'sent'").get(keyId)) return;
  const t = ctx.db.prepare("SELECT handle FROM traders WHERE user_id = ?").get(k.trader_id) as { handle: string };
  const to = walletByLabel(ctx, k.trader_id, "balance");
  if (!to?.wallet_pubkey) return pause(ctx, k, "trader_closed", `Your key to @${t.handle} is paused: the trader has no private balance to pay.`);
  const bal = balanceWallet(ctx, k.holder_id);
  const amount = Math.round(k.usd_day * 1e6).toString();
  const periodEnd = Math.max(now, k.paid_through_ms ?? now) + DAY_MS;
  let sub;
  try {
    sub = await ctx.wallet.confidentialTransfer(bal.wallet_id, { to: walletAccount(to.wallet_pubkey), amount, token: USDC_NEAR });
  } catch (e) {
    if (e instanceof OutLayerWalletError && e.code !== "unreachable") {
      ctx.db
        .prepare("INSERT INTO key_payments (id, key_id, amount_usd, request_id, state, period_end_ms, error, created_ms, network) VALUES (?, ?, ?, NULL, 'failed', ?, ?, ?, ?)")
        .run(newId(), k.id, k.usd_day, periodEnd, e.message.slice(0, 200), now, ctx.network);
      return pause(ctx, k, "payment_refused", `Your key to @${t.handle} is paused: today's payment of $${usd(k.usd_day)} did not go through (${e.message}).`);
    }
    throw e;
  }
  const pid = newId();
  ctx.db
    .prepare("INSERT INTO key_payments (id, key_id, amount_usd, request_id, state, period_end_ms, created_ms, network) VALUES (?, ?, ?, ?, 'sent', ?, ?, ?)")
    .run(pid, k.id, k.usd_day, sub.requestId, periodEnd, now, ctx.network);
  ctx.jobs.enqueue("key_pay_poll", { paymentId: pid }, `key_pay_poll:${pid}:${now + PAY_POLL_MS}`, now + PAY_POLL_MS);
}

/** Read a payment's private transfer until it settles. */
export async function pollPayment(ctx: Ctx, paymentId: string): Promise<void> {
  const p = ctx.db.prepare("SELECT * FROM key_payments WHERE id = ?").get(paymentId) as
    | { id: string; key_id: string; amount_usd: number; request_id: string; state: string; period_end_ms: number; created_ms: number }
    | undefined;
  if (!p || p.state !== "sent") return;
  const k = keyRow(ctx, p.key_id);
  const bal = balanceWallet(ctx, k.holder_id);
  const r = await ctx.wallet.request(bal.wallet_id, p.request_id);
  const t = ctx.db.prepare("SELECT handle FROM traders WHERE user_id = ?").get(k.trader_id) as { handle: string };
  if (r.status === "success" || r.status === "completed") {
    ctx.db.transaction(() => {
      ctx.db.prepare("UPDATE key_payments SET state = 'done' WHERE id = ?").run(p.id);
      ctx.db.prepare("UPDATE follow_keys SET paid_through_ms = ? WHERE id = ?").run(p.period_end_ms, k.id);
    })();
    addAlert(ctx, k.trader_id, `A ${k.kind === "copy" ? "copy" : "viewing"} key paid you $${usd(p.amount_usd)} for a day, privately.`);
    ctx.jobs.enqueue("key_bill", { keyId: k.id }, `key_bill:${k.id}:${p.period_end_ms}`, p.period_end_ms);
    return;
  }
  if (r.status === "failed" || r.status === "refunded" || ctx.now() - p.created_ms > PAY_POLL_FOR_MS) {
    ctx.db.prepare("UPDATE key_payments SET state = 'failed', error = ? WHERE id = ?").run(`status ${r.status}`, p.id);
    return pause(ctx, k, "payment_failed", `Your key to @${t.handle} is paused: today's payment of $${usd(p.amount_usd)} did not settle. Top up your private balance, then switch it back on.`);
  }
  const at = ctx.now() + PAY_POLL_MS;
  ctx.jobs.enqueue("key_pay_poll", { paymentId }, `key_pay_poll:${paymentId}:${at}`, at);
}

// ------------------------------------------------------------ copies

/** A trader's position event: start copies when it opens, close them when it closes; record results. */
export async function onPositionEvent(ctx: Ctx, positionId: string, event: PositionEvent): Promise<void> {
  const pos = positionLite(ctx, positionId);
  if (!pos) return;
  if (event === "closed") ctx.jobs.enqueue("trade_result", { positionId }, `trade_result:${positionId}`, ctx.now() + 60_000);

  if (pos.copy_of !== null) {
    // A copy that opened after its trader's position already closed closes at once.
    if (event === "open") {
      const leader = positionLite(ctx, pos.copy_of);
      if (leader && (leader.state === "closing" || leader.state === "closed")) closeCopy(ctx, pos);
    }
    return;
  }

  if (event === "open") {
    const a = hlAsset(pos.coin);
    if (!a || a.dex) return; // stocks are not copied: moving money onto trade.xyz needs the follower's pieces key
    const keys = ctx.db.prepare("SELECT * FROM follow_keys WHERE trader_id = ? AND kind = 'copy' AND state = 'active'").all(pos.user_id) as KeyRow[];
    for (const k of keys) {
      if (!keyOn(ctx, k)) continue;
      const id = newId();
      const r = ctx.db
        .prepare("INSERT OR IGNORE INTO copies (id, key_id, leader_position_id, state, created_ms, network) VALUES (?, ?, ?, 'waiting', ?, ?)")
        .run(id, k.id, pos.id, ctx.now(), ctx.network);
      if (r.changes !== 1) continue;
      const delay = COPY_DELAY_MIN_MS + (Buffer.from(ctx.random(4)).readUInt32BE(0) % (COPY_DELAY_MAX_MS - COPY_DELAY_MIN_MS));
      ctx.jobs.enqueue("copy_open", { copyId: id }, `copy_open:${id}`, ctx.now() + delay);
    }
    return;
  }

  // closing or closed: every copy of it closes on its own random spread
  const copies = ctx.db.prepare("SELECT * FROM copies WHERE leader_position_id = ? AND state IN ('waiting', 'opened', 'needs_app')").all(pos.id) as {
    id: string;
    follower_position_id: string | null;
    state: string;
  }[];
  for (const c of copies) {
    if (c.state === "waiting") {
      ctx.db.prepare("UPDATE copies SET state = 'skipped', reason = 'leader_closed' WHERE id = ?").run(c.id);
      continue;
    }
    const f = c.follower_position_id ? positionLite(ctx, c.follower_position_id) : undefined;
    if (!f) continue;
    if (closeCopy(ctx, f)) ctx.db.prepare("UPDATE copies SET state = 'closing' WHERE id = ?").run(c.id);
  }
}

/** Close a copy if it can be closed now; one not funded yet is called off. True when it is on its way out. */
function closeCopy(ctx: Ctx, f: PositionLite): boolean {
  if (f.state === "open" || f.state === "opening") {
    closePosition(ctx, f.user_id, f.id);
    addAlert(ctx, f.user_id, `The trader you copy closed their ${f.coin} trade, so your copy is closing too.`, f.id);
    return true;
  }
  if (f.state === "planned") {
    ctx.db.prepare("UPDATE positions SET state = 'failed', error = 'leader_closed' WHERE id = ? AND state = 'planned'").run(f.id);
    addAlert(ctx, f.user_id, `The trader closed their ${f.coin} trade before your copy started, so nothing was copied.`, f.id);
  }
  // funding or waiting for a lock: it closes when it opens (see onPositionEvent)
  return false;
}

/** Open one copy in the follower's own pieces: their size, split and timing; the trader's coin, side and leverage. */
export async function openCopy(ctx: Ctx, copyId: string): Promise<void> {
  const c = ctx.db.prepare("SELECT * FROM copies WHERE id = ?").get(copyId) as { id: string; key_id: string; leader_position_id: string; state: string } | undefined;
  if (!c || c.state !== "waiting") return;
  const k = keyRow(ctx, c.key_id);
  const leader = positionLite(ctx, c.leader_position_id);
  const skip = (reason: string) => ctx.db.prepare("UPDATE copies SET state = 'skipped', reason = ? WHERE id = ?").run(reason, c.id);
  if (!keyOn(ctx, k)) return void skip("key_off");
  if (!leader || leader.state !== "open") return void skip("leader_closed");
  const t = ctx.db.prepare("SELECT handle FROM traders WHERE user_id = ?").get(k.trader_id) as { handle: string };
  const plan = PlanBody.parse({
    coin: leader.coin,
    side: leader.side,
    notionalUsd: k.copy_usd!,
    leverage: Math.min(leader.leverage, 10),
    hiding: k.copy_usd! >= SPLIT_FROM_USD ? "whale" : "normal",
  });
  const what = `${leader.coin} ${leader.side} of $${usd(k.copy_usd!)}`;
  let r;
  try {
    r = await createPosition(ctx, k.holder_id, plan, { reuseOnly: true, copyOf: leader.id });
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    if (e.code !== "agent_needs_pieces") {
      skip(e.code);
      addAlert(ctx, k.holder_id, `@${t.handle} opened a trade, but your copy (${what}) could not start: ${e.message}`);
      return;
    }
    // no ready pieces: make the copy now, the follower sets its new pieces up in the app
    r = await createPosition(ctx, k.holder_id, plan, { copyOf: leader.id });
  }
  const ready = r.state === "funding";
  ctx.db.prepare("UPDATE copies SET state = ?, follower_position_id = ? WHERE id = ?").run(ready ? "opened" : "needs_app", r.positionId, c.id);
  addAlert(
    ctx,
    k.holder_id,
    ready
      ? `Copying @${t.handle}: your ${what} is starting in your own pieces.`
      : `Copying @${t.handle}: your ${what} needs your approval once. Open Positions and start your copy.`,
    r.positionId,
  );
}

// ------------------------------------------------------------ results

/** A closed position's realized result, read from each piece's fills on Hyperliquid. */
export async function settleResult(ctx: Ctx, positionId: string): Promise<void> {
  const pos = positionLite(ctx, positionId);
  if (!pos || pos.state !== "closed" || pos.result_json) return;
  const pieces = ctx.db
    .prepare("SELECT p.hl_address FROM position_pieces pp JOIN pieces p ON p.id = pp.piece_id WHERE pp.position_id = ? AND p.hl_address IS NOT NULL")
    .all(positionId) as { hl_address: string }[];
  let pnl = 0;
  let fees = 0;
  let inQ = 0;
  let inV = 0;
  let outQ = 0;
  let outV = 0;
  let last: number | null = null;
  for (const p of pieces) {
    let fills;
    try {
      fills = await ctx.hl.fills(p.hl_address, pos.created_ms - 60_000);
    } catch (e) {
      if (e instanceof HyperliquidError) throw e; // the job tries again
      throw e;
    }
    for (const f of fills.filter((x) => x.coin === pos.coin)) {
      pnl += f.closedPnl;
      fees += f.fee;
      if (/^Open/.test(f.dir)) {
        inQ += f.sz;
        inV += f.sz * f.px;
      } else if (/^Close/.test(f.dir)) {
        outQ += f.sz;
        outV += f.sz * f.px;
      }
      last = Math.max(last ?? 0, f.time);
    }
  }
  const r: TradeResult = {
    pnlUsd: pnl - fees,
    feesUsd: fees,
    entryPx: inQ > 0 ? inV / inQ : null,
    exitPx: outQ > 0 ? outV / outQ : null,
    closedMs: last,
  };
  ctx.db.prepare("UPDATE positions SET result_json = ? WHERE id = ?").run(JSON.stringify(r), positionId);
  ctx.db.prepare("UPDATE copies SET state = 'closed' WHERE follower_position_id = ? AND state IN ('opened', 'closing', 'needs_app')").run(positionId);
}
