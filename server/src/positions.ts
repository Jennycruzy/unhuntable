// Positions: plan, confirm, fund, lock, open, close.
//
//   planned -> funding -> policy_wait -> opening -> open -> closing -> closed
//
// planned:     wallets for new pieces are made in the browser (needWallets).
// funding:     each piece gets its plan's fundingUsd from the user's private balance, at its
//              VRF offset. Never from another piece. When it lands, the piece's master key
//              approves the guard agent for its shard, and the guard registers the master.
// policy_wait: the user signs one batch that locks every new piece (and updates the private
//              balance list). We read every policy back before going on.
// opening:     at each piece's VRF slot the guard sets leverage and opens the piece's size.
//              A piece whose policy is not locked is never opened.
// closing:     the guard closes each piece, at VRF-staggered times inside 0-90 s unless now.

import {
  USDC_NEAR,
  VrfStream,
  exchangeBody,
  hlAsset,
  isPlanError,
  plan,
  sha256,
  splitSignature,
  toUnits,
  typedDataJson,
  type Box,
  type Plan,
  type HlValue as Value,
} from "unhuntable-client";
import { z } from "zod";
import { addAlert, balanceWallet, userRow, usd, walletById, walletByLabel, type Ctx, type WalletRow } from "./ctx.js";
import { newId, newShardId } from "./db.js";
import { GuardRefusal, GuardUnreachable } from "./guard.js";
import { approveAgent } from "./hl.js";
import { approveAgentNow, approveBuilderNow, isChainSig, moveToXyzNow, needsBrowser, xyzMoveDone } from "./chainsig.js";
import { BUILDER_FEE_SHARE, activeBuilder } from "./builder.js";
import { OutLayerWalletError } from "./outlayer.js";
import { balancePolicy, balanceSentence, buildBatch, lockSentence, piecePolicy, readBack, walletAccount, type BatchItem, type PolicyBatch } from "./policy.js";
import { ApiError, sentence, type RefusalCode } from "./refusals.js";

export const EXIT_FEE_PER_PIECE = 1.2;
export const CLOSE_SPREAD_MS = 90_000;
export const FUNDING_POLL_MS = 15_000;
export const RETRY_MS = 30_000;
/** After this many failed tries in a row, the API shows the guard as unreachable. */
export const UNREACHABLE_AFTER = 3;
/** Funding has landed when the account holds at least this much less than was sent (route fee about 0.32). */
const FUNDING_SLACK_USD = 1;

export const PlanBody = z.object({
  /** "BTC", "ETH", "SOL" or a trade.xyz market such as "xyz:NVDA"; kept in Hyperliquid's spelling. */
  coin: z
    .string()
    .max(24)
    .refine((c) => hlAsset(c) !== undefined)
    .transform((c) => hlAsset(c)!.coin),
  side: z.enum(["long", "short"]),
  notionalUsd: z.number().finite().positive(),
  leverage: z.number().int().min(1).max(100),
  hiding: z.enum(["normal", "whale"]),
});
export type PlanBody = z.infer<typeof PlanBody>;

export const StopBody = z.object({
  boxes: z
    .array(
      z.object({
        shard: z.string().regex(/^[0-9a-f]{16}$/),
        box: z.object({ epk: z.string().regex(/^[0-9a-f]{64}$/), nonce: z.string().regex(/^[0-9a-f]{24}$/), ct: z.string().regex(/^[0-9a-f]{32,8192}$/) }).strict(),
      }),
    )
    .min(1)
    .max(12),
});

export const CloseBody = z.object({ now: z.boolean().optional() }).strict();

type State = "planned" | "funding" | "policy_wait" | "opening" | "open" | "closing" | "closed" | "failed";

interface PositionRow {
  id: string;
  user_id: string;
  coin: string;
  side: "long" | "short";
  notional_usd: number;
  leverage: number;
  hiding: "normal" | "whale";
  state: State;
  plan_json: string;
  vrf_hex: string;
  guard: "ok" | "unreachable";
  start_ms: number | null;
  error: string | null;
  created_ms: number;
}

interface PieceRow {
  id: string;
  position_id: string;
  piece_id: string;
  idx: number;
  size: number;
  funding_usd: number;
  entry_offset_ms: number;
  reused: number;
  state: "planned" | "funding" | "funded" | "ready" | "opening" | "open" | "closing" | "closed" | "failed";
  entry_px: number | null;
  liq_distance: number | null;
  band_lo: number | null;
  band_hi: number | null;
  has_stop: number;
  has_tp: number;
  close_at_ms: number | null;
}

// ------------------------------------------------------------ plan

function planError(code: string): ApiError {
  if (code === "shard_min_notional" || code === "max_leverage" || code === "over_cap") return new ApiError(code);
  return new ApiError("bad_request");
}

/** "" for Hyperliquid's own list, "xyz" for trade.xyz. */
function dexOf(coin: string): "" | "xyz" {
  return hlAsset(coin)?.dex ?? "";
}

async function makePlan(ctx: Ctx, body: PlanBody, vrf: Uint8Array): Promise<Plan> {
  const dex = dexOf(body.coin);
  if (dex && !ctx.chainsig) throw new ApiError("stocks_need_near");
  const mids = await ctx.hl.allMids(dex);
  const meta = await ctx.hl.meta(body.coin, dex);
  const markPx = mids[body.coin];
  if (!(markPx > 0)) throw new ApiError("stale_price");
  const r = plan({ ...body, markPx, szDecimals: meta.szDecimals, maxLeverage: meta.maxLeverage }, vrf);
  if (isPlanError(r)) throw planError(r.code);
  return r;
}

function activeHomeLabels(ctx: Ctx, userId: string): Set<string> {
  const rows = ctx.db
    .prepare("SELECT labels_json FROM homes WHERE user_id = ? AND state IN ('unlock_wait', 'moving', 'relock_wait')")
    .all(userId) as { labels_json: string }[];
  return new Set(rows.flatMap((r) => JSON.parse(r.labels_json) as string[]));
}

/** Piece ids of the user that are part of a position still running. */
export function busyPieceIds(ctx: Ctx, userId: string): Set<string> {
  const rows = ctx.db
    .prepare(
      `SELECT pp.piece_id FROM position_pieces pp JOIN positions x ON x.id = pp.position_id
       WHERE x.user_id = ? AND x.state NOT IN ('closed', 'failed') AND pp.state NOT IN ('closed', 'failed')`,
    )
    .all(userId) as { piece_id: string }[];
  return new Set(rows.map((r) => r.piece_id));
}

/**
 * Locked, ready pieces with no open position and not on their way home: used before making
 * new ones. nearOnly: only chain-signature pieces (trade.xyz needs the piece key to move funds).
 */
export function freePieces(ctx: Ctx, userId: string, nearOnly = false): WalletRow[] {
  const busy = busyPieceIds(ctx, userId);
  const home = activeHomeLabels(ctx, userId);
  const rows = ctx.db
    .prepare(
      `SELECT * FROM pieces WHERE user_id = ? AND kind = 'piece' AND policy_state = 'locked'
       AND (wallet_id IS NOT NULL OR control = 'near') AND hl_address IS NOT NULL AND agent IS NOT NULL ORDER BY created_ms, label`,
    )
    .all(userId) as WalletRow[];
  return rows.filter((r) => !busy.has(r.id) && !home.has(r.label ?? "") && (!nearOnly || isChainSig(r)));
}

function nextPieceNumber(ctx: Ctx, userId: string): number {
  const rows = ctx.db.prepare("SELECT label FROM pieces WHERE user_id = ? AND kind = 'piece' AND label IS NOT NULL").all(userId) as { label: string }[];
  return rows.reduce((m, r) => Math.max(m, Number(r.label.slice("piece:".length)) + 1), 0);
}

function world(p: Plan) {
  return p.pieces.map((x, i) => ({ name: `Account ${i + 1}`, sizeUsd: usd(x.notionalUsd), side: p.side }));
}

/** Preview: a fresh random draw; the real draw is made at confirm. */
export async function previewPlan(ctx: Ctx, userId: string, body: PlanBody) {
  userRow(ctx, userId);
  const p = await makePlan(ctx, body, ctx.random(32));
  const free = freePieces(ctx, userId, dexOf(body.coin) !== "").length;
  // The most the builder fee can be: one basis point of the size, once, when the pieces open.
  const builder = dexOf(body.coin) === "" && (await activeBuilder(ctx)) !== null;
  return {
    plan: p,
    feesUsd: usd(p.estFeesUsd),
    builderFee: builder ? { rate: "0.01%", usd: (body.notionalUsd * BUILDER_FEE_SHARE).toFixed(4) } : null,
    exitFeeUsd: usd(EXIT_FEE_PER_PIECE * p.pieces.length),
    world: world(p),
    newPiecesNeeded: Math.max(0, p.pieces.length - free),
  };
}

// ------------------------------------------------------------ rows

function position(ctx: Ctx, id: string): PositionRow {
  const p = ctx.db.prepare("SELECT * FROM positions WHERE id = ?").get(id) as PositionRow | undefined;
  if (!p) throw new ApiError("not_found");
  return p;
}

function ownPosition(ctx: Ctx, userId: string, id: string): PositionRow {
  const p = ctx.db.prepare("SELECT * FROM positions WHERE id = ? AND user_id = ?").get(id, userId) as PositionRow | undefined;
  if (!p) throw new ApiError("not_found");
  return p;
}

function pieceRows(ctx: Ctx, positionId: string): PieceRow[] {
  return ctx.db.prepare("SELECT * FROM position_pieces WHERE position_id = ? ORDER BY idx").all(positionId) as PieceRow[];
}

function setState(ctx: Ctx, id: string, state: State, extra: { startMs?: number } = {}): void {
  if (extra.startMs !== undefined) ctx.db.prepare("UPDATE positions SET state = ?, start_ms = ? WHERE id = ?").run(state, extra.startMs, id);
  else ctx.db.prepare("UPDATE positions SET state = ? WHERE id = ?").run(state, id);
}

function setPieceState(ctx: Ctx, ppId: string, state: PieceRow["state"], from?: PieceRow["state"]): boolean {
  if (from) return ctx.db.prepare("UPDATE position_pieces SET state = ? WHERE id = ? AND state = ?").run(state, ppId, from).changes === 1;
  ctx.db.prepare("UPDATE position_pieces SET state = ? WHERE id = ?").run(state, ppId);
  return true;
}

/** Enqueue the next run of a position's job at a time (never in the past). */
function schedule(ctx: Ctx, positionId: string, atMs: number): void {
  const at = Math.max(ctx.now(), atMs);
  ctx.jobs.enqueue("position", { positionId }, `position:${positionId}:${at}`, at);
}

// ------------------------------------------------------------ policies for a position

function ownerExitAddresses(ctx: Ctx, userId: string, owner: string): string[] {
  const s = ctx.db.prepare("SELECT exit_addresses_json FROM settings WHERE user_id = ?").get(userId) as { exit_addresses_json: string | null } | undefined;
  const extra = s?.exit_addresses_json ? (JSON.parse(s.exit_addresses_json) as string[]) : [];
  return [owner, ...extra.filter((a) => a !== owner)];
}

/** The private balance policy: every piece the user has plus their own exit addresses. */
export function balanceItem(ctx: Ctx, userId: string): BatchItem {
  const u = userRow(ctx, userId);
  const bal = balanceWallet(ctx, userId);
  const addrs = (
    ctx.db.prepare("SELECT hl_address FROM pieces WHERE user_id = ? AND kind = 'piece' AND hl_address IS NOT NULL ORDER BY created_ms, label").all(userId) as {
      hl_address: string;
    }[]
  ).map((r) => r.hl_address);
  const policy = balancePolicy({ pieceAddresses: addrs, exitAddresses: ownerExitAddresses(ctx, userId, u.near_account), walletAccount: walletAccount(bal.wallet_pubkey), keyHash: bal.key_hash ?? "" });
  return { wallet: bal, policy, sentence: balanceSentence(addrs.length, u.near_account) };
}

/** True when the private balance is locked but its stored list misses a piece of this position. */
function balanceMissesPieces(ctx: Ctx, userId: string, positionId: string): boolean {
  const bal = walletByLabel(ctx, userId, "balance");
  if (!bal || bal.policy_state !== "locked") return false;
  const list = new Set<string>(bal.policy_json ? (JSON.parse(bal.policy_json).rules?.addresses?.list ?? []) : []);
  return pieceRows(ctx, positionId).some((pp) => {
    const a = walletById(ctx, pp.piece_id).hl_address;
    return a !== null && !list.has(a);
  });
}

function lockItems(ctx: Ctx, userId: string, positionId: string): BatchItem[] {
  const u = userRow(ctx, userId);
  const items: BatchItem[] = [];
  for (const pp of pieceRows(ctx, positionId)) {
    const w = walletById(ctx, pp.piece_id);
    if (w.policy_state === "locked") continue;
    if (!w.hl_address || !w.key_hash) throw new ApiError("wallet_missing");
    items.push({
      wallet: w,
      policy: piecePolicy({ evmAddress: w.hl_address, owner: u.near_account, walletAccount: walletAccount(w.wallet_pubkey), keyHash: w.key_hash }),
      sentence: lockSentence(`Account ${pp.idx + 1}`, u.near_account),
    });
  }
  const bal = balanceWallet(ctx, userId);
  if (bal.policy_state !== "locked" || balanceMissesPieces(ctx, userId, positionId)) items.push(balanceItem(ctx, userId));
  return items;
}

/** Pieces of a position the browser still has to set up: OutLayer wallets to make, chain-signature keys to register and sign. */
function browserWork(ctx: Ctx, positionId: string) {
  const ws = pieceRows(ctx, positionId).map((pp) => walletById(ctx, pp.piece_id));
  return {
    needWallets: ws.filter((w) => !isChainSig(w) && !w.wallet_id).map((w) => w.label!),
    needChainSig: ws.filter((w) => needsBrowser(ctx, w, positionId)).map((w) => w.label!),
  };
}

async function answer(ctx: Ctx, pos: PositionRow) {
  const u = userRow(ctx, pos.user_id);
  const { needWallets, needChainSig } = browserWork(ctx, pos.id);
  let policyBatch: PolicyBatch | null = null;
  if (pos.state === "planned" && needWallets.length === 0 && needChainSig.length === 0 && balanceMissesPieces(ctx, pos.user_id, pos.id)) {
    policyBatch = await buildBatch(ctx, u.near_account, [balanceItem(ctx, pos.user_id)]);
  } else if (pos.state === "policy_wait") {
    const items = lockItems(ctx, pos.user_id, pos.id);
    policyBatch = items.length ? await buildBatch(ctx, u.near_account, items) : null;
  }
  return { positionId: pos.id, state: pos.state, needWallets, needChainSig, policyBatch };
}

// ------------------------------------------------------------ confirm and continue

export async function createPosition(ctx: Ctx, userId: string, body: PlanBody) {
  userRow(ctx, userId);
  balanceWallet(ctx, userId);
  const id = newId();
  let draw;
  try {
    draw = await ctx.guard.vrf(id);
  } catch (e) {
    if (e instanceof GuardUnreachable) throw new ApiError("guard_unreachable");
    if (e instanceof GuardRefusal) throw new ApiError(e.code, { reason: e.reason });
    throw e;
  }
  const p = await makePlan(ctx, body, Buffer.from(draw.outputHex, "hex"));
  ctx.db.transaction(() => {
    ctx.db
      .prepare(
        `INSERT INTO positions (id, user_id, coin, side, notional_usd, leverage, hiding, state, plan_json, vrf_hex, vrf_proof, vrf_alpha, created_ms, network)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, userId, body.coin, body.side, body.notionalUsd, body.leverage, body.hiding, JSON.stringify(p), draw.outputHex, draw.proof, draw.alpha, ctx.now(), ctx.network);
    const free = freePieces(ctx, userId, dexOf(body.coin) !== "");
    let n = nextPieceNumber(ctx, userId);
    p.pieces.forEach((x, i) => {
      let pieceId: string;
      const reused = free[i];
      if (reused) pieceId = reused.id;
      else {
        pieceId = newId();
        ctx.db
          .prepare("INSERT INTO pieces (id, user_id, label, kind, shard_id, policy_state, control, created_ms, network) VALUES (?, ?, ?, 'piece', ?, 'none', ?, ?, ?)")
          .run(pieceId, userId, `piece:${n++}`, newShardId(), ctx.chainsig ? "near" : "outlayer", ctx.now(), ctx.network);
      }
      ctx.db
        .prepare(
          `INSERT INTO position_pieces (id, position_id, piece_id, idx, size, funding_usd, entry_offset_ms, reused, created_ms, network)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(newId(), id, pieceId, i, x.size, x.fundingUsd, x.entryOffsetMs, reused ? 1 : 0, ctx.now(), ctx.network);
    });
  })();
  return continuePosition(ctx, userId, id);
}

export async function continuePosition(ctx: Ctx, userId: string, id: string) {
  const pos = ownPosition(ctx, userId, id);
  if (pos.state === "planned") {
    const w = browserWork(ctx, id);
    const missing = w.needWallets.length > 0 || w.needChainSig.length > 0;
    if (!missing && !balanceMissesPieces(ctx, userId, id)) {
      setState(ctx, id, "funding", { startMs: ctx.now() });
      schedule(ctx, id, ctx.now());
    }
  }
  return answer(ctx, position(ctx, id));
}

/** After the user signed a position's batch: read every policy back, then move on. */
export async function confirmPositionPolicies(ctx: Ctx, userId: string, id: string) {
  const pos = ownPosition(ctx, userId, id);
  const u = userRow(ctx, userId);
  let items: BatchItem[];
  if (pos.state === "planned") {
    if (!balanceMissesPieces(ctx, userId, id)) throw new ApiError("wrong_state");
    items = [balanceItem(ctx, userId)];
  } else if (pos.state === "policy_wait") {
    items = lockItems(ctx, userId, id);
  } else throw new ApiError("wrong_state");

  for (const it of items) await readBack(ctx, u.near_account, it.wallet, false);
  const locked: string[] = [];
  ctx.db.transaction(() => {
    for (const it of items) {
      ctx.db.prepare("UPDATE pieces SET policy_state = 'locked', policy_json = ? WHERE id = ?").run(JSON.stringify(it.policy), it.wallet.id);
      locked.push(it.wallet.label!);
    }
    if (pos.state === "planned") setState(ctx, id, "funding", { startMs: ctx.now() });
    else setState(ctx, id, "opening", { startMs: ctx.now() });
  })();
  schedule(ctx, id, ctx.now());
  return { ok: true as const, locked, unlocked: [] as string[] };
}

// ------------------------------------------------------------ the job

function noteError(ctx: Ctx, pos: PositionRow, code: RefusalCode, text: string): void {
  const cur = ctx.db.prepare("SELECT error FROM positions WHERE id = ?").get(pos.id) as { error: string | null };
  if (cur.error !== code) addAlert(ctx, pos.user_id, text, pos.id);
  ctx.db.prepare("UPDATE positions SET error = ? WHERE id = ?").run(code, pos.id);
}

function guardOk(ctx: Ctx, id: string): void {
  ctx.db.prepare("UPDATE positions SET guard = 'ok' WHERE id = ?").run(id);
}

async function fundPiece(ctx: Ctx, pos: PositionRow, pp: PieceRow, bal: WalletRow & { wallet_id: string }): Promise<void> {
  const piece = walletById(ctx, pp.piece_id);
  if (!piece.hl_address) throw new ApiError("wallet_missing");
  if (!setPieceState(ctx, pp.id, "funding", "planned")) return;
  // Only ever from the user's private balance to this same piece's own address.
  const body = { chain: "hypercore", to: piece.hl_address, amount: toUnits(String(pp.funding_usd), 6).toString(), token: USDC_NEAR };
  let sub;
  try {
    sub = await ctx.wallet.withdraw(bal.wallet_id, body);
  } catch (e) {
    setPieceState(ctx, pp.id, "planned");
    if (e instanceof OutLayerWalletError && e.refusal === "policy_denied") noteError(ctx, pos, "policy_denied", sentence("policy_denied"));
    throw e;
  }
  ctx.db.prepare("UPDATE position_pieces SET funding_request_id = ? WHERE id = ?").run(sub.requestId, pp.id);
  ctx.db
    .prepare(
      "INSERT INTO fundings (id, piece_id, direction, amount, route, request_id, status, created_ms, network) VALUES (?, ?, 'in', ?, 'hypercore', ?, 'sent', ?, ?)",
    )
    .run(newId(), piece.id, pp.funding_usd, sub.requestId, ctx.now(), ctx.network);
}

/** Funding landed: approve the guard's agent for this shard with the piece's master key, then register it. */
async function approvePiece(ctx: Ctx, pos: PositionRow, pp: PieceRow): Promise<boolean> {
  const piece = walletById(ctx, pp.piece_id);
  // Once the funding has moved onto trade.xyz the main balance is nearly empty: it landed.
  if (!(dexOf(pos.coin) && xyzMoveDone(ctx, piece.id, pos.id))) {
    const perp = await ctx.hl.perp(piece.hl_address!);
    if (perp.accountValue < pp.funding_usd - FUNDING_SLACK_USD) return false;
  }
  if (!piece.agent && isChainSig(piece)) {
    // NEAR's MPC network signs the approval the piece key signed in the browser.
    try {
      await approveAgentNow(ctx, piece);
    } catch (e) {
      if (e instanceof ApiError && (e.code === "chainsig_sign_again" || e.code === "chainsig_refused" || e.code === "wrong_state")) {
        noteError(ctx, pos, e.code === "chainsig_refused" ? "chainsig_refused" : "chainsig_sign_again", `${pos.coin} piece Account ${pp.idx + 1}: ${e.message}`);
        return false;
      }
      throw e;
    }
    guardOk(ctx, pos.id);
  }
  if (isChainSig(piece) && dexOf(pos.coin)) {
    // A stock position: move the funding onto trade.xyz with the move the piece key signed.
    try {
      await moveToXyzNow(ctx, piece, pos.id);
    } catch (e) {
      if (e instanceof ApiError && (e.code === "chainsig_sign_again" || e.code === "chainsig_refused")) {
        noteError(ctx, pos, e.code, `${pos.coin} piece Account ${pp.idx + 1}: ${e.message}`);
        return false;
      }
      throw e;
    }
  }
  // The builder fee approval comes last; a piece it does not reach trades without the fee.
  if (isChainSig(piece)) await approveBuilderNow(ctx, walletById(ctx, piece.id));
  if (!piece.agent && !isChainSig(piece)) {
    const agent = await ctx.guard.agent(piece.shard_id!);
    const a = approveAgent(agent, `unhuntable ${piece.shard_id}`, ctx.now());
    const sig = await ctx.wallet.signTypedData(piece.wallet_id!, "arbitrum", typedDataJson(a.typed));
    await ctx.hl.exchange(exchangeBody(a.action as unknown as Value, a.nonce, splitSignature(sig.signature), false));
    await ctx.guard.register(piece.shard_id!, piece.hl_address!);
    ctx.db.prepare("UPDATE pieces SET agent = ?, hl_master = ? WHERE id = ?").run(agent, piece.hl_address, piece.id);
    guardOk(ctx, pos.id);
  }
  setPieceState(ctx, pp.id, "funded", "funding");
  return true;
}

async function openPiece(ctx: Ctx, pos: PositionRow, pp: PieceRow): Promise<void> {
  const piece = walletById(ctx, pp.piece_id);
  if (piece.policy_state !== "locked") {
    noteError(ctx, pos, "policy_not_set", `${pos.coin} piece Account ${pp.idx + 1}: ${sentence("policy_not_set")}`);
    return;
  }
  const ctxOrder = { positionId: pos.id, pieceId: piece.id };
  if (pp.state === "opening") {
    // A run stopped in the middle: look before opening again.
    const order = ctx.db.prepare("SELECT px FROM piece_orders WHERE position_id = ? AND piece_id = ? AND kind = 'open'").get(pos.id, piece.id) as
      | { px: number | null }
      | undefined;
    const held = (await ctx.hl.perp(piece.hl_address!, dexOf(pos.coin))).positions.find((x) => x.coin === pos.coin);
    if (order || held) {
      ctx.db.prepare("UPDATE position_pieces SET state = 'open', entry_px = ? WHERE id = ?").run(order?.px ?? held?.entryPx ?? null, pp.id);
      return;
    }
  } else if (!setPieceState(ctx, pp.id, "opening", pp.state)) return;

  try {
    // trade.xyz pieces are isolated: the plan's openLeverage keeps liquidation 18% away
    const planned = (JSON.parse(pos.plan_json) as { openLeverage?: number }).openLeverage;
    await ctx.guard.leverage(piece.shard_id!, pos.coin, planned ?? pos.leverage);
    // The builder fee: only on Hyperliquid's own list, only for a piece Hyperliquid took the approval from.
    const fee = isChainSig(piece) && piece.builder_ok === 1 && dexOf(pos.coin) === "" && (await activeBuilder(ctx)) !== null;
    const fill = await ctx.guard.open(piece.shard_id!, pos.coin, pos.side, pp.size, ctxOrder, fee ? { builder: true } : undefined);
    guardOk(ctx, pos.id);
    let liq: number | null = null;
    try {
      const held = (await ctx.hl.perp(piece.hl_address!, dexOf(pos.coin))).positions.find((x) => x.coin === pos.coin);
      if (held?.liquidationPx && fill.px > 0) liq = Math.abs(held.liquidationPx - fill.px) / fill.px;
    } catch {
      // the distance is filled in by the next read
    }
    ctx.db.prepare("UPDATE position_pieces SET state = 'open', entry_px = ?, liq_distance = ? WHERE id = ?").run(fill.px, liq, pp.id);
  } catch (e) {
    if (e instanceof GuardRefusal) {
      setPieceState(ctx, pp.id, "funded");
      guardOk(ctx, pos.id);
      noteError(ctx, pos, e.code, `${pos.coin} piece Account ${pp.idx + 1}: ${sentence(e.code, { reason: e.reason })}`);
      return;
    }
    throw e;
  }
}

/** Move a position as far as it can go now, then schedule the next run. Safe to run twice. */
export async function advancePosition(ctx: Ctx, positionId: string, attempts = 1): Promise<void> {
  const pos = position(ctx, positionId);
  try {
    await step(ctx, pos);
  } catch (e) {
    if (e instanceof GuardUnreachable && attempts >= UNREACHABLE_AFTER) {
      ctx.db.prepare("UPDATE positions SET guard = 'unreachable' WHERE id = ?").run(positionId);
    }
    throw e;
  }
}

async function step(ctx: Ctx, pos: PositionRow): Promise<void> {
  const now = ctx.now();
  if (pos.state === "funding") {
    const bal = balanceWallet(ctx, pos.user_id);
    for (const pp of pieceRows(ctx, pos.id)) {
      if (pp.state === "planned" && now >= (pos.start_ms ?? 0) + pp.entry_offset_ms) await fundPiece(ctx, pos, pp, bal);
    }
    for (const pp of pieceRows(ctx, pos.id)) if (pp.state === "funding") await approvePiece(ctx, pos, pp);
    const pps = pieceRows(ctx, pos.id);
    if (pps.every((pp) => pp.state === "funded")) {
      if (lockItems(ctx, pos.user_id, pos.id).length > 0) {
        setState(ctx, pos.id, "policy_wait");
        addAlert(ctx, pos.user_id, `Your ${pos.coin} pieces are funded. Approve their locks in your wallet to open the position.`, pos.id);
        return;
      }
      setState(ctx, pos.id, "opening", { startMs: now });
      return schedule(ctx, pos.id, now);
    }
    const waiting = pps.filter((pp) => pp.state === "planned").map((pp) => (pos.start_ms ?? 0) + pp.entry_offset_ms);
    const nextAt = pps.some((pp) => pp.state === "funding") ? now + FUNDING_POLL_MS : Math.min(...waiting);
    return schedule(ctx, pos.id, Math.min(nextAt, ...waiting));
  }

  if (pos.state === "opening") {
    for (const pp of pieceRows(ctx, pos.id)) {
      if ((pp.state === "funded" || pp.state === "opening") && now >= (pos.start_ms ?? 0) + pp.entry_offset_ms) await openPiece(ctx, pos, pp);
    }
    const pps = pieceRows(ctx, pos.id);
    if (pps.every((pp) => pp.state === "open")) {
      ctx.db.prepare("UPDATE positions SET state = 'open', error = NULL WHERE id = ?").run(pos.id);
      return;
    }
    const later = pps.filter((pp) => pp.state === "funded").map((pp) => (pos.start_ms ?? 0) + pp.entry_offset_ms);
    const due = later.filter((t) => t > now);
    return schedule(ctx, pos.id, due.length === later.length && due.length > 0 ? Math.min(...due) : now + RETRY_MS);
  }

  if (pos.state === "closing") {
    for (const pp of pieceRows(ctx, pos.id)) {
      if ((pp.state === "open" || pp.state === "closing") && (pp.close_at_ms ?? 0) <= now) {
        const piece = walletById(ctx, pp.piece_id);
        setPieceState(ctx, pp.id, "closing");
        try {
          await ctx.guard.close(piece.shard_id!, pos.coin, { positionId: pos.id, pieceId: piece.id });
          guardOk(ctx, pos.id);
          setPieceState(ctx, pp.id, "closed");
        } catch (e) {
          if (e instanceof GuardRefusal) {
            noteError(ctx, pos, e.code, `${pos.coin} piece Account ${pp.idx + 1}: ${sentence(e.code, { reason: e.reason })}`);
            continue;
          }
          throw e;
        }
      }
    }
    const pps = pieceRows(ctx, pos.id);
    if (pps.every((pp) => pp.state === "closed")) {
      setState(ctx, pos.id, "closed");
      addAlert(ctx, pos.user_id, `Your ${pos.coin} position is closed.`, pos.id);
      return;
    }
    const left = pps.filter((pp) => pp.state !== "closed").map((pp) => pp.close_at_ms ?? now);
    const due = left.filter((t) => t > now);
    return schedule(ctx, pos.id, due.length === left.length ? Math.min(...due) : now + RETRY_MS);
  }
}

// ------------------------------------------------------------ close, list, stops

export function closeOffsets(vrfHex: string, n: number): number[] {
  const s = new VrfStream(sha256(new TextEncoder().encode(`close:${vrfHex}`)));
  return Array.from({ length: n }, () => s.int(0, CLOSE_SPREAD_MS));
}

export function closePosition(ctx: Ctx, userId: string, id: string, now?: boolean) {
  const pos = ownPosition(ctx, userId, id);
  if (pos.state === "closing" || pos.state === "closed") return { ok: true as const, state: pos.state };
  if (pos.state !== "open" && pos.state !== "opening") throw new ApiError("wrong_state");
  const pps = pieceRows(ctx, id);
  const offsets = closeOffsets(pos.vrf_hex, pps.length);
  ctx.db.transaction(() => {
    for (const pp of pps) {
      if (pp.state === "open" || pp.state === "opening") {
        ctx.db.prepare("UPDATE position_pieces SET state = 'open', close_at_ms = ? WHERE id = ?").run(now ? ctx.now() : ctx.now() + offsets[pp.idx], pp.id);
      } else setPieceState(ctx, pp.id, "closed");
    }
    ctx.db.prepare("UPDATE positions SET state = 'closing', close_now = ? WHERE id = ?").run(now ? 1 : 0, id);
  })();
  schedule(ctx, id, ctx.now());
  return { ok: true as const, state: "closing" as const };
}

export function listPositions(ctx: Ctx, userId: string) {
  const rows = ctx.db.prepare("SELECT * FROM positions WHERE user_id = ? ORDER BY created_ms DESC").all(userId) as PositionRow[];
  return {
    positions: rows.map((p) => ({
      id: p.id,
      coin: p.coin,
      side: p.side,
      notionalUsd: p.notional_usd,
      leverage: p.leverage,
      hiding: p.hiding,
      state: p.state,
      createdMs: p.created_ms,
      pieces: pieceRows(ctx, p.id).map((pp) => {
        const w = walletById(ctx, pp.piece_id);
        return {
          label: w.label,
          shard: w.shard_id,
          size: pp.size,
          entryPx: pp.entry_px,
          liqDistance: pp.liq_distance,
          hasStop: pp.has_stop === 1,
          hasTp: pp.has_tp === 1,
          guard: p.guard,
          nearControlled: isChainSig(w),
        };
      }),
      needChainSig: p.state === "closed" || p.state === "failed" ? [] : browserWork(ctx, p.id).needChainSig,
      alerts: (
        ctx.db.prepare("SELECT text, created_ms FROM alerts WHERE position_id = ? ORDER BY created_ms DESC LIMIT 50").all(p.id) as { text: string; created_ms: number }[]
      ).map((a) => ({ text: a.text, ms: a.created_ms })),
    })),
  };
}

/** Pass boxes sealed in the browser on to the guard, one per piece. The server never opens them. */
export async function forwardStops(ctx: Ctx, userId: string, id: string, boxes: { shard: string; box: Box }[]) {
  const pos = ownPosition(ctx, userId, id);
  const shards = new Set(pieceRows(ctx, pos.id).map((pp) => walletById(ctx, pp.piece_id).shard_id));
  for (const b of boxes) if (!shards.has(b.shard)) throw new ApiError("shard_not_yours");
  let sealed = 0;
  for (const b of boxes) {
    try {
      const out = await ctx.guard.forward(b.shard, b.box);
      if (out.sealed === true) sealed += 1;
    } catch (e) {
      if (e instanceof GuardUnreachable) throw new ApiError("guard_unreachable");
      if (e instanceof GuardRefusal) throw new ApiError(e.code, { reason: e.reason });
      throw e;
    }
  }
  return { ok: true as const, sealed };
}

