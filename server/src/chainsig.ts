// Pieces controlled by NEAR Chain Signatures (signer contract, unhuntable.near).
//
// The browser makes each piece key from the user's 12 words and signs every action with
// it. This server only:
//   - registers the piece key on the contract and reads the piece's Hyperliquid account
//     from NEAR's MPC network (v1.signer derived_public_key),
//   - keeps the signed requests, checks every signature itself,
//   - relays `sign` (paying gas), checks the MPC signature recovers to the piece's
//     account, and posts the action to Hyperliquid.
// It cannot make or change a request: the contract refuses anything the piece key did not
// sign. The destinations of money moves are chosen in the browser (see web/lib/home.ts).
import {
  ADD_PIECE_DEPOSIT,
  BUILDER_FEE_RATE,
  MPC_SIGNER,
  SIGN_GAS,
  USDC_SPOT_TOKEN,
  XYZ_DEX,
  addressFromDerivedKey,
  chainSigExchangeBody,
  checkAction,
  fromUnits,
  sendableUsdc,
  toUnits,
  mpcPath,
  pieceKeyArgs,
  pieceKeyBytes,
  publicKeyHex,
  readCounter,
  readString,
  signArgs,
  verifyPieceAction,
  type ChainSigAction,
  type MpcAnswer,
} from "unhuntable-client";
import { hexToBytes } from "@noble/hashes/utils";
import { z } from "zod";
import { activeBuilder } from "./builder.js";
import { userRow, walletByLabel, type Ctx, type WalletRow } from "./ctx.js";
import { newId } from "./db.js";
import { HyperliquidError } from "./hl.js";
import { NearRpcError } from "./near.js";
import { RelayError } from "./relay.js";
import { ApiError } from "./refusals.js";
import { Label } from "./wallets.js";

/** Hyperliquid takes a user-signed action only while its nonce is recent; past this, the user signs again. */
export const APPROVAL_TTL_MS = 24 * 60 * 60_000;
const ADD_PIECE_GAS = 30_000_000_000_000n;

export const RegisterBody = z.object({ label: Label, publicKey: z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/) }).strict();
const Sig = z.string().regex(/^[0-9a-f]{128}$/);
/** signature: the approve-agent action; moveSignature: the move onto trade.xyz; builderSignature: the builder fee approval. At least one. */
export const ApproveBody = z
  .object({ label: Label, signature: Sig.optional(), moveSignature: Sig.optional(), builderSignature: Sig.optional() })
  .strict()
  .refine((b) => b.signature !== undefined || b.moveSignature !== undefined || b.builderSignature !== undefined);

const ActionSchema: z.ZodType<ChainSigAction> = z.union([
  z.object({ kind: z.literal("approveAgent"), agentAddress: z.string(), agentName: z.string(), nonce: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal("usdClassTransfer"), amount: z.string(), toPerp: z.boolean(), nonce: z.number().int().nonnegative() }).strict(),
  z
    .object({
      kind: z.literal("sendAsset"),
      destination: z.string(),
      sourceDex: z.string(),
      destinationDex: z.string(),
      token: z.string(),
      amount: z.string(),
      nonce: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ kind: z.literal("spotSend"), destination: z.string(), token: z.string(), amount: z.string(), time: z.number().int().nonnegative() }).strict(),
]) as z.ZodType<ChainSigAction>;

export const HomeSigsBody = z
  .object({
    pieces: z
      .array(
        z
          .object({
            label: Label,
            signed: z.array(z.object({ counter: z.number().int().nonnegative(), action: ActionSchema, signature: Sig }).strict()).min(1).max(3),
          })
          .strict(),
      )
      .min(1)
      .max(64),
  })
  .strict();

export interface RequestRow {
  id: string;
  piece_id: string;
  purpose: "approve_agent" | "home_to_spot" | "home_send" | "xyz_in" | "home_from_xyz" | "approve_builder";
  home_id: string | null;
  position_id: string | null;
  counter: number;
  action_json: string;
  signature: string | null;
  state: "unsigned" | "signed" | "sent" | "done" | "failed";
  near_tx: string | null;
  mpc_json: string | null;
  error: string | null;
  created_ms: number;
}

export function chainSig(ctx: Ctx) {
  if (!ctx.chainsig) throw new ApiError("bad_request");
  return ctx.chainsig;
}

export function isChainSig(w: WalletRow): boolean {
  return w.control === "near";
}

/** The piece number in a label "piece:<n>": the index of its key under the 12 words. */
export function pieceNumber(label: string): number {
  const m = /^piece:(\d+)$/.exec(label);
  if (!m) throw new ApiError("bad_request");
  return Number(m[1]);
}

async function view(ctx: Ctx, method: string, args: Uint8Array): Promise<Uint8Array> {
  const c = chainSig(ctx);
  let r: Uint8Array | null;
  try {
    r = await ctx.near.viewRaw(c.contract, method, args);
  } catch (e) {
    if (e instanceof NearRpcError) throw new ApiError("near_unreachable");
    throw e;
  }
  if (!r) throw new ApiError("near_unreachable");
  return r;
}

/** The piece's counter on the contract, or null when the key is not registered there. */
export async function counterOf(ctx: Ctx, key: Uint8Array): Promise<number | null> {
  return readCounter(await view(ctx, "counter", pieceKeyArgs(key)));
}

/** The piece's Hyperliquid account, as NEAR's MPC network derives it for this contract. */
export async function accountOf(ctx: Ctx, key: Uint8Array): Promise<string> {
  const c = chainSig(ctx);
  const path = readString(await view(ctx, "path", pieceKeyArgs(key)));
  if (path !== mpcPath(key)) throw new ApiError("near_unreachable");
  let derived: unknown;
  try {
    derived = await ctx.near.view(MPC_SIGNER, "derived_public_key", { path, predecessor: c.contract, domain_id: 0 });
  } catch (e) {
    if (e instanceof NearRpcError) throw new ApiError("near_unreachable");
    throw e;
  }
  if (typeof derived !== "string") throw new ApiError("near_unreachable");
  return addressFromDerivedKey(derived);
}

async function relay(ctx: Ctx, method: string, args: Uint8Array, gas: bigint, deposit: bigint) {
  try {
    return await chainSig(ctx).relay.call(chainSig(ctx).contract, method, args, gas, deposit);
  } catch (e) {
    if (e instanceof RelayError && e.refused) throw new ApiError("chainsig_refused", { reason: e.message });
    if (e instanceof RelayError) throw new ApiError("near_unreachable");
    throw e;
  }
}

function ownChainSigPiece(ctx: Ctx, userId: string, label: string): WalletRow {
  const w = walletByLabel(ctx, userId, label);
  if (!w || w.kind !== "piece" || !isChainSig(w)) throw new ApiError("not_found");
  return w;
}

function latest(ctx: Ctx, pieceId: string, purpose: RequestRow["purpose"]): RequestRow | undefined {
  return ctx.db.prepare("SELECT * FROM chainsig_requests WHERE piece_id = ? AND purpose = ? ORDER BY created_ms DESC, rowid DESC LIMIT 1").get(pieceId, purpose) as
    | RequestRow
    | undefined;
}

/** A piece still needs the browser: no key on file yet, no live signed approval of the guard's agent, or no live signed move onto trade.xyz for a stock position. */
export function needsBrowser(ctx: Ctx, w: WalletRow, positionId?: string): boolean {
  if (!isChainSig(w)) return false;
  if (positionId && xyzMoveFor(ctx, w, positionId) && needsMove(ctx, w.id, positionId)) return true;
  if (w.agent) return false;
  if (!w.piece_key || !w.hl_address) return true;
  const r = latest(ctx, w.id, "approve_agent");
  if (!r || r.state === "unsigned" || r.state === "failed") return true;
  return r.state === "signed" && ctx.now() - r.created_ms > APPROVAL_TTL_MS;
}

function latestMove(ctx: Ctx, pieceId: string, positionId: string): RequestRow | undefined {
  return ctx.db
    .prepare("SELECT * FROM chainsig_requests WHERE piece_id = ? AND position_id = ? AND purpose = 'xyz_in' ORDER BY created_ms DESC, rowid DESC LIMIT 1")
    .get(pieceId, positionId) as RequestRow | undefined;
}

export function xyzMoveDone(ctx: Ctx, pieceId: string, positionId: string): boolean {
  return latestMove(ctx, pieceId, positionId)?.state === "done";
}

function needsMove(ctx: Ctx, pieceId: string, positionId: string): boolean {
  const r = latestMove(ctx, pieceId, positionId);
  if (!r || r.state === "unsigned" || r.state === "failed") return true;
  return r.state === "signed" && ctx.now() - r.created_ms > APPROVAL_TTL_MS;
}

/**
 * The trade.xyz position this piece is being funded for, and the USDC its plan moves onto
 * trade.xyz; null when the position is not on trade.xyz or is past funding.
 */
export function xyzMoveFor(ctx: Ctx, w: WalletRow, positionId?: string): { positionId: string; amount: string } | null {
  const row = ctx.db
    .prepare(
      `SELECT x.id, x.plan_json, pp.idx FROM position_pieces pp JOIN positions x ON x.id = pp.position_id
       WHERE pp.piece_id = ? AND x.coin LIKE 'xyz:%' AND x.state IN ('planned', 'funding') AND pp.state IN ('planned', 'funding')
       ${positionId ? "AND x.id = ?" : ""} ORDER BY x.created_ms DESC LIMIT 1`,
    )
    .get(...(positionId ? [w.id, positionId] : [w.id])) as { id: string; plan_json: string; idx: number } | undefined;
  if (!row) return null;
  const usd = (JSON.parse(row.plan_json) as { xyzMoveUsd?: number[] | null }).xyzMoveUsd?.[row.idx];
  if (!(typeof usd === "number" && usd > 0)) return null;
  return { positionId: row.id, amount: String(usd) };
}

/**
 * Register the piece key the browser made for this label, read the piece's Hyperliquid
 * account, and hand back the approve-agent action for the piece key to sign.
 */
export async function registerPiece(ctx: Ctx, userId: string, body: z.infer<typeof RegisterBody>) {
  userRow(ctx, userId);
  const c = chainSig(ctx);
  const w = ownChainSigPiece(ctx, userId, body.label);
  const key = pieceKeyBytes(body.publicKey);
  const hex = publicKeyHex(key);
  if (w.piece_key && w.piece_key !== hex) throw new ApiError("bad_request");
  const taken = ctx.db.prepare("SELECT id FROM pieces WHERE piece_key = ? AND id != ?").get(hex, w.id);
  if (taken) throw new ApiError("bad_request");

  let counter = await counterOf(ctx, key);
  if (counter === null) {
    await relay(ctx, "add_piece", pieceKeyArgs(key), ADD_PIECE_GAS, BigInt(ADD_PIECE_DEPOSIT));
    counter = await counterOf(ctx, key);
    if (counter === null) throw new ApiError("near_unreachable");
  }
  const account = await accountOf(ctx, key);
  if (w.hl_address && w.hl_address !== account) throw new ApiError("bad_request");
  ctx.db
    .prepare("UPDATE pieces SET piece_key = ?, hl_address = ?, hl_master = ?, policy_state = 'locked', policy_json = ? WHERE id = ?")
    .run(hex, account, account, JSON.stringify({ chainSignatures: c.contract }), w.id);

  let approve: { counter: number; action: ChainSigAction } | null = null;
  if (!w.agent) {
    const agent = (await ctx.guard.agent(w.shard_id!)).toLowerCase();
    const action: ChainSigAction = { kind: "approveAgent", agentAddress: agent, agentName: "", nonce: ctx.now() };
    checkAction(action);
    ctx.db
      .prepare("INSERT INTO chainsig_requests (id, piece_id, purpose, counter, action_json, state, created_ms, network) VALUES (?, ?, 'approve_agent', ?, ?, 'unsigned', ?, ?)")
      .run(newId(), w.id, counter, JSON.stringify(action), ctx.now(), ctx.network);
    approve = { counter, action };
  }

  // A stock position: the piece also signs moving its funding onto trade.xyz, right after the approval.
  let move: { counter: number; action: ChainSigAction } | null = null;
  const x = xyzMoveFor(ctx, w);
  if (x && (approve || needsMove(ctx, w.id, x.positionId))) {
    const action: ChainSigAction = { kind: "sendAsset", destination: account, sourceDex: "", destinationDex: XYZ_DEX, token: USDC_SPOT_TOKEN, amount: x.amount, nonce: ctx.now() + 1 };
    checkAction(action);
    const at = approve ? counter + 1 : counter;
    ctx.db.transaction(() => {
      ctx.db
        .prepare("UPDATE chainsig_requests SET state = 'failed', error = 'replaced' WHERE piece_id = ? AND position_id = ? AND purpose = 'xyz_in' AND state IN ('unsigned', 'signed')")
        .run(w.id, x.positionId);
      ctx.db
        .prepare("INSERT INTO chainsig_requests (id, piece_id, purpose, position_id, counter, action_json, state, created_ms, network) VALUES (?, ?, 'xyz_in', ?, ?, ?, 'unsigned', ?, ?)")
        .run(newId(), w.id, x.positionId, at, JSON.stringify(action), ctx.now(), ctx.network);
    })();
    move = { counter: at, action };
  }

  // A new piece also approves the builder fee, last, when the fee is on. It is the last
  // counter of the setup, so if it is never used nothing after it waits on it.
  let builder: { counter: number; action: ChainSigAction } | null = null;
  const b = approve ? await activeBuilder(ctx) : null;
  if (approve && b) {
    const action: ChainSigAction = { kind: "approveBuilderFee", maxFeeRate: BUILDER_FEE_RATE, builder: b, nonce: ctx.now() + 2 };
    checkAction(action);
    const at = (move ? move.counter : approve.counter) + 1;
    ctx.db
      .prepare("INSERT INTO chainsig_requests (id, piece_id, purpose, counter, action_json, state, created_ms, network) VALUES (?, ?, 'approve_builder', ?, ?, 'unsigned', ?, ?)")
      .run(newId(), w.id, at, JSON.stringify(action), ctx.now(), ctx.network);
    builder = { counter: at, action };
  }
  return { label: body.label, account, contract: c.contract, approve, move, builder };
}

/** The piece key's signatures over the waiting approve-agent action and move onto trade.xyz; checked here before they are kept. */
export function approvePiece(ctx: Ctx, userId: string, body: z.infer<typeof ApproveBody>) {
  const c = chainSig(ctx);
  const w = ownChainSigPiece(ctx, userId, body.label);
  if (!w.piece_key) throw new ApiError("wrong_state");
  const key = hexToBytes(w.piece_key);
  const r = latest(ctx, w.id, "approve_agent");
  const x = xyzMoveFor(ctx, w);
  const m = x ? latestMove(ctx, w.id, x.positionId) : undefined;
  const bf = latest(ctx, w.id, "approve_builder");
  const wantApprove = !w.agent && r?.state === "unsigned";
  const wantMove = m?.state === "unsigned";
  const wantBuilder = bf?.state === "unsigned";
  if (!wantApprove && !wantMove && !wantBuilder) throw new ApiError("wrong_state");
  if (wantApprove !== (body.signature !== undefined) || wantMove !== (body.moveSignature !== undefined)) throw new ApiError("bad_request");
  if (wantBuilder !== (body.builderSignature !== undefined)) throw new ApiError("bad_request");
  const check = (row: RequestRow, sig: string) => {
    if (!verifyPieceAction(key, c.contract, row.counter, JSON.parse(row.action_json) as ChainSigAction, hexToBytes(sig), c.chain)) throw new ApiError("bad_signature");
  };
  if (wantApprove) check(r!, body.signature!);
  if (wantMove) check(m!, body.moveSignature!);
  if (wantBuilder) check(bf!, body.builderSignature!);
  ctx.db.transaction(() => {
    if (wantApprove) ctx.db.prepare("UPDATE chainsig_requests SET signature = ?, state = 'signed' WHERE id = ?").run(body.signature, r!.id);
    if (wantMove) ctx.db.prepare("UPDATE chainsig_requests SET signature = ?, state = 'signed' WHERE id = ?").run(body.moveSignature, m!.id);
    if (wantBuilder) ctx.db.prepare("UPDATE chainsig_requests SET signature = ?, state = 'signed' WHERE id = ?").run(body.builderSignature, bf!.id);
  })();
  return { ok: true as const, label: body.label };
}

/** Relay one signed request (NEAR signs it), then post it to Hyperliquid. Safe to run again. */
export async function runRequest(ctx: Ctx, w: WalletRow, r: RequestRow): Promise<void> {
  const c = chainSig(ctx);
  if (r.state === "done") return;
  if (!w.piece_key || !w.hl_address || !r.signature) throw new ApiError("wrong_state");
  const action = JSON.parse(r.action_json) as ChainSigAction;
  let mpc: MpcAnswer;
  if (r.state === "signed") {
    let out;
    try {
      out = await relay(ctx, "sign", signArgs(hexToBytes(w.piece_key), action, hexToBytes(r.signature)), BigInt(SIGN_GAS), 1n);
    } catch (e) {
      if (e instanceof ApiError && e.code === "chainsig_refused") ctx.db.prepare("UPDATE chainsig_requests SET state = 'failed', error = ? WHERE id = ?").run(e.message, r.id);
      throw e;
    }
    mpc = JSON.parse(new TextDecoder().decode(out.value)) as MpcAnswer;
    ctx.db.prepare("UPDATE chainsig_requests SET state = 'sent', near_tx = ?, mpc_json = ? WHERE id = ?").run(out.txHash, JSON.stringify(mpc), r.id);
  } else if (r.state === "sent") {
    mpc = JSON.parse(r.mpc_json!) as MpcAnswer;
  } else throw new ApiError("wrong_state");

  let body;
  try {
    body = chainSigExchangeBody(action, mpc, w.hl_address, c.chain);
  } catch (e) {
    ctx.db.prepare("UPDATE chainsig_requests SET state = 'failed', error = ? WHERE id = ?").run((e as Error).message, r.id);
    throw e;
  }
  try {
    await ctx.hl.exchange(body);
  } catch (e) {
    if (e instanceof HyperliquidError) ctx.db.prepare("UPDATE chainsig_requests SET error = ? WHERE id = ?").run(e.message, r.id);
    throw e;
  }
  ctx.db.prepare("UPDATE chainsig_requests SET state = 'done', error = NULL WHERE id = ?").run(r.id);
}

/** Funding landed: approve the guard's agent through Chain Signatures, then register the piece with the guard. */
export async function approveAgentNow(ctx: Ctx, w: WalletRow): Promise<void> {
  const r = latest(ctx, w.id, "approve_agent");
  if (!r || r.state === "unsigned" || r.state === "failed") throw new ApiError("wrong_state");
  if (r.state === "signed" && ctx.now() - r.created_ms > APPROVAL_TTL_MS) {
    ctx.db.prepare("UPDATE chainsig_requests SET state = 'failed', error = 'too old' WHERE id = ?").run(r.id);
    throw new ApiError("chainsig_sign_again");
  }
  await runRequest(ctx, w, r);
  const agent = (JSON.parse(r.action_json) as { agentAddress: string }).agentAddress;
  await ctx.guard.register(w.shard_id!, w.hl_address!);
  ctx.db.prepare("UPDATE pieces SET agent = ? WHERE id = ?").run(agent, w.id);
}

/**
 * After the agent approval (and any move onto trade.xyz): send the builder fee approval the
 * piece key signed. Never throws and never holds a position up: if NEAR or Hyperliquid does
 * not take it, the piece simply trades without the fee.
 */
export async function approveBuilderNow(ctx: Ctx, w: WalletRow): Promise<boolean> {
  if (w.builder_ok === 1) return true;
  const r = latest(ctx, w.id, "approve_builder");
  if (!r || r.state === "unsigned" || r.state === "failed") return false;
  const fail = (why: string) => ctx.db.prepare("UPDATE chainsig_requests SET state = 'failed', error = ? WHERE id = ?").run(why.slice(0, 300), r.id);
  if (r.state === "signed" && ctx.now() - r.created_ms > APPROVAL_TTL_MS) {
    fail("too old");
    return false;
  }
  try {
    await runRequest(ctx, w, r);
  } catch (e) {
    if (e instanceof ApiError || e instanceof HyperliquidError) {
      fail(e.message);
      return false;
    }
    throw e;
  }
  ctx.db.prepare("UPDATE pieces SET builder_ok = 1 WHERE id = ?").run(w.id);
  return true;
}

/** Funded for a stock position: move the funding onto trade.xyz with the move the piece key signed. */
export async function moveToXyzNow(ctx: Ctx, w: WalletRow, positionId: string): Promise<void> {
  const r = latestMove(ctx, w.id, positionId);
  if (r?.state === "done") return;
  if (!r || r.state === "unsigned" || r.state === "failed") throw new ApiError("chainsig_sign_again");
  if (r.state === "signed" && ctx.now() - r.created_ms > APPROVAL_TTL_MS) {
    ctx.db.prepare("UPDATE chainsig_requests SET state = 'failed', error = 'too old' WHERE id = ?").run(r.id);
    throw new ApiError("chainsig_sign_again");
  }
  await runRequest(ctx, w, r);
}

// ------------------------------------------------------------ going home

export interface HomePlanRow {
  label: string;
  account: string;
  counter: number;
  /** USDC to move back from trade.xyz to the main perps balance first ("0" when nothing). */
  fromXyz: string;
  /** USDC to move from perps to spot ("0" when nothing); includes fromXyz. */
  toSpot: string;
  /** USDC to send from spot to a fresh deposit address of the private balance; null when too little to move. */
  send: string | null;
}

/** Saved requests of one home, by piece. */
export function homeRequests(ctx: Ctx, homeId: string, pieceId: string): RequestRow[] {
  return ctx.db.prepare("SELECT * FROM chainsig_requests WHERE home_id = ? AND piece_id = ? ORDER BY counter").all(homeId, pieceId) as RequestRow[];
}

/**
 * The piece key's signatures for going home, made in the browser. Only trade.xyz → main
 * perps (to the piece itself), perps → spot and a spot USDC send are taken, at the piece's
 * next counters. The destination is the browser's
 * choice: a deposit address it asked OutLayer for, for the user's own private balance.
 */
export async function takeHomeSignatures(ctx: Ctx, homeId: string, pieces: WalletRow[], body: z.infer<typeof HomeSigsBody>): Promise<void> {
  const c = chainSig(ctx);
  const byLabel = new Map(pieces.map((w) => [w.label!, w]));
  const rows: { w: WalletRow; purpose: RequestRow["purpose"]; counter: number; action: ChainSigAction; signature: string }[] = [];
  for (const p of body.pieces) {
    const w = byLabel.get(p.label);
    if (!w || !isChainSig(w) || !w.piece_key) throw new ApiError("not_found");
    if (homeRequests(ctx, homeId, w.id).length > 0) throw new ApiError("wrong_state");
    const start = await counterOf(ctx, hexToBytes(w.piece_key));
    if (start === null) throw new ApiError("wrong_state");
    // In order: trade.xyz -> main perps (to the piece itself), perps -> spot, then the USDC send last.
    let prev = 0;
    p.signed.forEach((s, i) => {
      const a = s.action;
      const last = i === p.signed.length - 1;
      let at: number;
      if (a.kind === "sendAsset" && a.sourceDex === XYZ_DEX && a.destinationDex === "" && a.destination.toLowerCase() === w.hl_address && a.token === USDC_SPOT_TOKEN) at = 1;
      else if (a.kind === "usdClassTransfer" && !a.toPerp) at = 2;
      else if (a.kind === "spotSend" && a.token === USDC_SPOT_TOKEN) at = 3;
      else throw new ApiError("bad_request");
      if (s.counter !== start + i || at <= prev || (at === 3) !== last) throw new ApiError("bad_request");
      prev = at;
      checkAction(a);
      if (!verifyPieceAction(hexToBytes(w.piece_key!), c.contract, s.counter, a, hexToBytes(s.signature), c.chain)) throw new ApiError("bad_signature");
      rows.push({ w, purpose: at === 1 ? "home_from_xyz" : at === 2 ? "home_to_spot" : "home_send", counter: s.counter, action: a, signature: s.signature });
    });
  }
  ctx.db.transaction(() => {
    for (const r of rows) {
      ctx.db
        .prepare(
          "INSERT INTO chainsig_requests (id, piece_id, purpose, home_id, counter, action_json, signature, state, created_ms, network) VALUES (?, ?, ?, ?, ?, ?, ?, 'signed', ?, ?)",
        )
        .run(newId(), r.w.id, r.purpose, homeId, r.counter, JSON.stringify(r.action), r.signature, ctx.now(), ctx.network);
    }
  })();
}

/** For the browser: what each chain-signature piece holds and its next counter. */
export async function homePlan(ctx: Ctx, w: WalletRow, minUsdc: number): Promise<HomePlanRow> {
  if (!w.piece_key || !w.hl_address) throw new ApiError("wallet_missing");
  const counter = await counterOf(ctx, hexToBytes(w.piece_key));
  if (counter === null) throw new ApiError("wallet_missing");
  const perp = await ctx.hl.perp(w.hl_address);
  const xyz = await ctx.hl.perp(w.hl_address, XYZ_DEX);
  const spot = await ctx.hl.spotUsdc(w.hl_address);
  const fromXyz = toUnits(xyz.withdrawable, 8) > 0n ? xyz.withdrawable : "0";
  const perpUnits = toUnits(perp.withdrawable, 8) + toUnits(fromXyz, 8);
  const toSpot = perpUnits > 0n ? fromUnits(perpUnits, 8) : "0";
  const total = perpUnits + toUnits(spot, 8);
  let send: string | null = null;
  if (perp.positions.length === 0 && xyz.positions.length === 0 && total >= BigInt(minUsdc) * 10n ** 8n) {
    const u = sendableUsdc(fromUnits(total, 8));
    if (u >= 2n * 10n ** 8n) send = fromUnits(u, 8);
  }
  return { label: w.label!, account: w.hl_address, counter, fromXyz, toSpot, send };
}
