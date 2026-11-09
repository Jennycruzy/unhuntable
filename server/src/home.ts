// Going home: money from pieces back into the private balance. The same steps as the exit
// tool in the client library (client/src/exit.ts), run by the server.
//
// Chain-signature pieces (NEAR controls their Hyperliquid account) take no unlock: at the
// start the browser asks OutLayer for a deposit address of the user's private balance and
// signs perps -> spot and the send to it with the piece key. Moving starts when the browser's
// signatures and (for OutLayer pieces) the unlock are both in; we relay each signed step.
//
// OutLayer pieces:
//   unlock_wait  the user signs an unlock batch (the same pieces, evm_sign on)
//   moving       for each piece: perp -> spot, a fresh deposit address on the private
//                balance (chain hypercore, exact amount), spotSend of spot total - 1 USDC,
//                wait until the private balance grows. Pieces under 3 USDC are skipped.
//   relock_wait  the user signs the relock batch (evm_sign off). Always asked for, even
//                after a failed step.
//   done | failed
import {
  exchangeBody,
  fromUnits,
  sendableUsdc,
  spotSend,
  splitSignature,
  toUnits,
  typedDataJson,
  usdClassTransfer,
  XYZ_DEX,
  type TypedData,
  type HlValue as Value,
} from "unhuntable-client";
import { z } from "zod";
import { addAlert, balanceWallet, userRow, usd, walletById, walletByLabel, type Ctx, type WalletRow } from "./ctx.js";
import { newId } from "./db.js";
import { HyperliquidError } from "./hl.js";
import { OutLayerWalletError } from "./outlayer.js";
import { buildBatch, lockSentence, piecePolicy, readBack, unlockSentence, walletAccount, type BatchItem, type PolicyBatch } from "./policy.js";
import { busyPieceIds, EXIT_FEE_PER_PIECE } from "./positions.js";
import { ApiError, sentence } from "./refusals.js";
import { Label, privateUnits } from "./wallets.js";
import { HomeSigsBody, homePlan, homeRequests, isChainSig, runRequest, takeHomeSignatures, type HomePlanRow } from "./chainsig.js";

export const HOME_POLL_MS = 15_000;
/** Pieces holding less than this are left where they are. */
export const HOME_MIN_USDC = 3;
/** Give up waiting for one piece's money after this long. */
export const ARRIVAL_WAIT_MS = 30 * 60_000;

export const HomeBody = z.object({ labels: z.array(Label).max(64).optional() }).strict();

type HomeState = "unlock_wait" | "moving" | "relock_wait" | "done" | "failed";

interface HomeRow {
  id: string;
  user_id: string;
  state: HomeState;
  labels_json: string;
  fee_usd: number;
  arrived_usdc: string | null;
  had_failure: number;
  unlock_json: string | null;
  relock_json: string | null;
  policies_ok: number;
  sigs_ok: number;
}

interface StepRow {
  id: string;
  piece_id: string | null;
  step: string;
  status: "done" | "skipped" | "failed" | "waiting";
  detail: string | null;
  created_ms: number;
}

class StepFailed extends Error {
  constructor(readonly detail: string) {
    super(detail);
  }
}

function homeRow(ctx: Ctx, userId: string, id: string): HomeRow {
  const h = ctx.db.prepare("SELECT * FROM homes WHERE id = ? AND user_id = ?").get(id, userId) as HomeRow | undefined;
  if (!h) throw new ApiError("not_found");
  return h;
}

function pieces(ctx: Ctx, h: HomeRow): WalletRow[] {
  return (JSON.parse(h.labels_json) as string[]).map((l) => walletByLabel(ctx, h.user_id, l)!);
}

/** Policy items for the OutLayer pieces of a home (chain-signature pieces have no policy to change). */
function items(ctx: Ctx, h: HomeRow, evmSign: boolean): BatchItem[] {
  const u = userRow(ctx, h.user_id);
  return pieces(ctx, h).flatMap((w, i) => {
    if (isChainSig(w)) return [];
    if (!w.hl_address || !w.key_hash) throw new ApiError("wallet_missing");
    const name = `Account ${i + 1}`;
    return {
      wallet: w,
      policy: piecePolicy({ evmAddress: w.hl_address, owner: u.near_account, walletAccount: walletAccount(w.wallet_pubkey), keyHash: w.key_hash, evmSign }),
      sentence: evmSign ? unlockSentence(name) : lockSentence(name, u.near_account),
    };
  });
}

const homeReady = (w: WalletRow) => (w.wallet_id !== null || (isChainSig(w) && w.piece_key !== null)) && w.hl_address !== null;

function addStep(ctx: Ctx, homeId: string, pieceId: string | null, step: string, status: StepRow["status"], detail: string | null): void {
  ctx.db
    .prepare("INSERT INTO home_steps (id, home_id, piece_id, step, status, detail, created_ms, network) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(newId(), homeId, pieceId, step, status, detail, ctx.now(), ctx.network);
}

function schedule(ctx: Ctx, homeId: string, at: number): void {
  ctx.jobs.enqueue("home", { homeId }, `home:${homeId}:${at}`, at);
}

export async function startHome(ctx: Ctx, userId: string, body: z.infer<typeof HomeBody>) {
  const u = userRow(ctx, userId);
  balanceWallet(ctx, userId);
  const busy = busyPieceIds(ctx, userId);
  let chosen: WalletRow[];
  if (body.labels && body.labels.length > 0) {
    chosen = body.labels.map((l) => {
      const w = walletByLabel(ctx, userId, l);
      if (!w || w.kind !== "piece" || !homeReady(w)) throw new ApiError("not_found");
      if (busy.has(w.id)) throw new ApiError("piece_in_use");
      return w;
    });
  } else {
    chosen = (ctx.db.prepare("SELECT * FROM pieces WHERE user_id = ? AND kind = 'piece' ORDER BY created_ms, label").all(userId) as WalletRow[]).filter(
      (w) => homeReady(w) && !busy.has(w.id),
    );
  }
  if (chosen.length === 0) throw new ApiError("not_found");
  const id = newId();
  const feeUsd = EXIT_FEE_PER_PIECE * chosen.length;
  const h: HomeRow = {
    id,
    user_id: userId,
    state: "unlock_wait",
    labels_json: JSON.stringify(chosen.map((w) => w.label)),
    fee_usd: feeUsd,
    arrived_usdc: null,
    had_failure: 0,
    unlock_json: null,
    relock_json: null,
    policies_ok: 0,
    sigs_ok: 1,
  };
  const unlockItems = items(ctx, h, true);
  const unlockBatch = unlockItems.length > 0 ? await buildBatch(ctx, u.near_account, unlockItems) : null;
  const chainSig: HomePlanRow[] = [];
  for (const w of chosen) if (isChainSig(w)) chainSig.push(await homePlan(ctx, w, HOME_MIN_USDC));
  const sigsOk = chainSig.some((p) => p.send !== null) ? 0 : 1;
  ctx.db
    .prepare(
      "INSERT INTO homes (id, user_id, state, labels_json, fee_usd, unlock_json, policies_ok, sigs_ok, updated_ms, created_ms, network) VALUES (?, ?, 'unlock_wait', ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(id, userId, h.labels_json, feeUsd, unlockBatch ? JSON.stringify(unlockBatch) : null, unlockBatch ? 0 : 1, sigsOk, ctx.now(), ctx.now(), ctx.network);
  addAlert(ctx, userId, sentence("exit_fee"));
  if (!unlockBatch && sigsOk) startMoving(ctx, id);
  return { homeId: id, feeUsd: usd(feeUsd), unlockBatch, chainSig };
}

function startMoving(ctx: Ctx, id: string): void {
  const moved = ctx.db.prepare("UPDATE homes SET state = 'moving', updated_ms = ? WHERE id = ? AND state = 'unlock_wait' AND policies_ok = 1 AND sigs_ok = 1").run(ctx.now(), id);
  if (moved.changes === 1) schedule(ctx, id, ctx.now());
}

/** The browser's piece-key signatures for the chain-signature pieces of a home. */
export async function takeHomeChainSig(ctx: Ctx, userId: string, id: string, body: z.infer<typeof HomeSigsBody>) {
  const h = homeRow(ctx, userId, id);
  if (h.state !== "unlock_wait" || h.sigs_ok) throw new ApiError("wrong_state");
  await takeHomeSignatures(ctx, id, pieces(ctx, h), body);
  ctx.db.prepare("UPDATE homes SET sigs_ok = 1, updated_ms = ? WHERE id = ?").run(ctx.now(), id);
  startMoving(ctx, id);
  return { ok: true as const, state: homeRow(ctx, userId, id).state };
}

export function homeStatus(ctx: Ctx, userId: string, id: string) {
  const h = homeRow(ctx, userId, id);
  const steps = ctx.db.prepare("SELECT * FROM home_steps WHERE home_id = ? ORDER BY created_ms, rowid").all(id) as StepRow[];
  const out: {
    homeId: string;
    state: HomeState;
    steps: { label: string | null; step: string; status: string; ms: number; detail?: string }[];
    relockBatch: PolicyBatch | null;
    needChainSig: boolean;
    arrivedUsdc?: string;
  } = {
    homeId: h.id,
    state: h.state,
    needChainSig: h.state === "unlock_wait" && !h.sigs_ok,
    steps: steps.map((s) => ({
      label: s.piece_id ? walletById(ctx, s.piece_id).label : null,
      step: s.step,
      status: s.status,
      ms: s.created_ms,
      ...(s.detail ? { detail: s.detail } : {}),
    })),
    relockBatch: h.state === "relock_wait" && h.relock_json ? (JSON.parse(h.relock_json) as PolicyBatch) : null,
  };
  if (h.arrived_usdc !== null) out.arrivedUsdc = h.arrived_usdc;
  return out;
}

/** After an unlock or relock batch: read the policies back and move on. */
export async function confirmHomePolicies(ctx: Ctx, userId: string, id: string) {
  const h = homeRow(ctx, userId, id);
  const u = userRow(ctx, userId);
  if (h.state !== "unlock_wait" && h.state !== "relock_wait") throw new ApiError("wrong_state");
  const unlocking = h.state === "unlock_wait";
  const its = items(ctx, h, unlocking);
  if (its.length === 0) throw new ApiError("wrong_state");
  for (const it of its) await readBack(ctx, u.near_account, it.wallet, unlocking);
  const labels = its.map((it) => it.wallet.label!);
  ctx.db.transaction(() => {
    for (const it of its) {
      ctx.db.prepare("UPDATE pieces SET policy_state = ?, policy_json = ? WHERE id = ?").run(unlocking ? "unlocked" : "locked", JSON.stringify(it.policy), it.wallet.id);
    }
    if (unlocking) ctx.db.prepare("UPDATE homes SET policies_ok = 1, updated_ms = ? WHERE id = ?").run(ctx.now(), id);
    else ctx.db.prepare("UPDATE homes SET state = ?, updated_ms = ? WHERE id = ?").run(h.had_failure ? "failed" : "done", ctx.now(), id);
  })();
  if (unlocking) startMoving(ctx, id);
  else addAlert(ctx, userId, h.had_failure ? "Your pieces are locked again. Some money did not move; see the steps." : "Your money is home and your pieces are locked again.");
  return { ok: true as const, locked: unlocking ? [] : labels, unlocked: unlocking ? labels : [] };
}

/** Sign typed data with a piece's own key. A locked piece's policy refuses: exit_needs_unlock. */
async function signWith(ctx: Ctx, w: WalletRow, td: TypedData) {
  try {
    return splitSignature((await ctx.wallet.signTypedData(w.wallet_id!, "arbitrum", typedDataJson(td))).signature);
  } catch (e) {
    if (e instanceof OutLayerWalletError && e.refusal === "policy_denied") throw new StepFailed("exit_needs_unlock");
    if (e instanceof OutLayerWalletError) throw new StepFailed(`OutLayer would not sign: ${e.message}`);
    throw e;
  }
}

async function post(ctx: Ctx, body: unknown): Promise<void> {
  try {
    await ctx.hl.exchange(body);
  } catch (e) {
    if (e instanceof HyperliquidError) throw new StepFailed(`Hyperliquid refused it: ${e.message}`);
    throw e;
  }
}

/** Move one piece as far as it can go. Returns true when the piece is finished. */
async function movePiece(ctx: Ctx, h: HomeRow, w: WalletRow, done: StepRow[]): Promise<boolean> {
  const last = done[done.length - 1];
  if (last && (last.status === "skipped" || last.status === "failed" || (last.step === "arrive" && last.status === "done"))) return true;
  const bal = balanceWallet(ctx, h.user_id);
  const addr = w.hl_address!;

  if (last?.step === "arrive" && last.status === "waiting") {
    const info = JSON.parse(last.detail ?? "{}") as { before: string; sent: string };
    const nowUnits = await privateUnits(ctx, bal.wallet_id);
    if (nowUnits > BigInt(info.before)) {
      const grew = nowUnits - BigInt(info.before);
      ctx.db.prepare("UPDATE home_steps SET status = 'done', detail = ? WHERE id = ?").run(`${fromUnits(grew, 6)} USDC arrived`, last.id);
      const total = toUnits(h.arrived_usdc ?? "0", 6) + grew;
      ctx.db.prepare("UPDATE homes SET arrived_usdc = ? WHERE id = ?").run(fromUnits(total, 6), h.id);
      h.arrived_usdc = fromUnits(total, 6);
      return true;
    }
    if (ctx.now() - last.created_ms > ARRIVAL_WAIT_MS) {
      ctx.db.prepare("UPDATE home_steps SET status = 'failed', detail = ? WHERE id = ?").run("The USDC was sent but did not reach the private balance in time.", last.id);
      throw new StepFailed("arrival");
    }
    return false;
  }

  if (isChainSig(w)) return moveChainSigPiece(ctx, h, w, bal, last);

  if (!last) {
    const perp = await ctx.hl.perp(addr);
    if (perp.positions.length > 0) {
      addStep(ctx, h.id, w.id, "check", "failed", "This piece still holds a position. Close it first.");
      throw new StepFailed("piece_in_use");
    }
    const spot = await ctx.hl.spotUsdc(addr);
    const total = Number(perp.withdrawable) + Number(spot);
    if (total < HOME_MIN_USDC) {
      addStep(ctx, h.id, w.id, "skip", "skipped", `Only ${usd(total)} USDC here. Under ${HOME_MIN_USDC} USDC is not worth moving: Hyperliquid keeps 1 USDC per send.`);
      return true;
    }
    if (toUnits(perp.withdrawable, 8) > 0n) {
      const t = usdClassTransfer(perp.withdrawable, false, ctx.now());
      const sig = await signWith(ctx, w, t.typed);
      await post(ctx, exchangeBody(t.action as unknown as Value, t.nonce, sig, false));
      addStep(ctx, h.id, w.id, "to_spot", "done", `${perp.withdrawable} USDC moved from perps to spot.`);
    } else addStep(ctx, h.id, w.id, "to_spot", "done", "Nothing in perps.");
  }

  // spot -> a fresh deposit address of the private balance
  const spot = await ctx.hl.spotUsdc(addr);
  const send = sendableUsdc(spot);
  if (send < 2n * 10n ** 8n) {
    addStep(ctx, h.id, w.id, "skip", "skipped", `Only ${spot} USDC on spot; less than 2 USDC would arrive, so it stays.`);
    return true;
  }
  let to: string;
  try {
    const d = await ctx.wallet.depositCrossChain(bal.wallet_id, { chain: "hypercore", token: "USDC", amount: send.toString() });
    to = d.depositAddress;
  } catch (e) {
    if (e instanceof OutLayerWalletError) throw new StepFailed(`OutLayer gave no deposit address: ${e.message}`);
    throw e;
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new StepFailed("OutLayer's deposit address is not a Hyperliquid address.");
  addStep(ctx, h.id, w.id, "deposit_address", "done", null);
  const before = await privateUnits(ctx, bal.wallet_id);
  const sendStr = fromUnits(send, 8);
  const s = spotSend(to, sendStr, ctx.now());
  const sig = await signWith(ctx, w, s.typed);
  await post(ctx, exchangeBody(s.action as unknown as Value, s.nonce, sig, false));
  addStep(ctx, h.id, w.id, "send", "done", `${sendStr} USDC sent; Hyperliquid keeps 1 USDC.`);
  addStep(ctx, h.id, w.id, "arrive", "waiting", JSON.stringify({ before: before.toString(), sent: sendStr }));
  return false;
}

/** Relay the piece key's signed steps one at a time: perps -> spot, then the send to the deposit address the browser chose. */
async function moveChainSigPiece(ctx: Ctx, h: HomeRow, w: WalletRow, bal: WalletRow & { wallet_id: string }, last: StepRow | undefined): Promise<boolean> {
  const reqs = homeRequests(ctx, h.id, w.id);
  if (reqs.length === 0) {
    addStep(ctx, h.id, w.id, "skip", "skipped", `Too little USDC on this piece to move: Hyperliquid keeps 1 USDC per send, and under ${HOME_MIN_USDC} USDC stays where it is.`);
    return true;
  }
  if (!last) {
    const perp = await ctx.hl.perp(w.hl_address!);
    const xyz = await ctx.hl.perp(w.hl_address!, XYZ_DEX);
    if (perp.positions.length > 0 || xyz.positions.length > 0) {
      addStep(ctx, h.id, w.id, "check", "failed", "This piece still holds a position. Close it first.");
      throw new StepFailed("piece_in_use");
    }
  }
  for (const r of reqs) {
    if (r.state === "done") continue;
    const a = JSON.parse(r.action_json) as { amount: string };
    const before = r.purpose === "home_send" ? await privateUnits(ctx, bal.wallet_id) : 0n;
    try {
      await runRequest(ctx, w, r);
    } catch (e) {
      // A refusal is final; anything else (NEAR or Hyperliquid not answering) is tried again by the job.
      const final = (e instanceof ApiError && e.code === "chainsig_refused") || e instanceof HyperliquidError || (e instanceof Error && /not the piece's account/.test(e.message));
      if (final) throw new StepFailed(`This step did not go through: ${(e as Error).message}`);
      throw e;
    }
    if (r.purpose === "home_from_xyz") addStep(ctx, h.id, w.id, "from_xyz", "done", `${a.amount} USDC moved back from trade.xyz, signed by NEAR Chain Signatures.`);
    else if (r.purpose === "home_to_spot") addStep(ctx, h.id, w.id, "to_spot", "done", `${a.amount} USDC moved from perps to spot, signed by NEAR Chain Signatures.`);
    else {
      addStep(ctx, h.id, w.id, "send", "done", `${a.amount} USDC sent to your private balance's deposit address, signed by NEAR Chain Signatures; Hyperliquid keeps 1 USDC.`);
      addStep(ctx, h.id, w.id, "arrive", "waiting", JSON.stringify({ before: before.toString(), sent: a.amount }));
      return false;
    }
  }
  return false;
}

async function relock(ctx: Ctx, h: HomeRow, failed: boolean): Promise<void> {
  const u = userRow(ctx, h.user_id);
  const relockItems = items(ctx, h, false);
  if (relockItems.length === 0) {
    const done = failed || h.had_failure;
    ctx.db.prepare("UPDATE homes SET state = ?, had_failure = MAX(had_failure, ?), updated_ms = ? WHERE id = ?").run(done ? "failed" : "done", failed ? 1 : 0, ctx.now(), h.id);
    addAlert(ctx, h.user_id, done ? "Some money did not move; see the steps." : "Your money is home.");
    return;
  }
  const batch = await buildBatch(ctx, u.near_account, relockItems);
  ctx.db
    .prepare("UPDATE homes SET state = 'relock_wait', relock_json = ?, had_failure = MAX(had_failure, ?), updated_ms = ? WHERE id = ?")
    .run(JSON.stringify(batch), failed ? 1 : 0, ctx.now(), h.id);
  addAlert(ctx, h.user_id, "Lock your pieces again: open the approval in your wallet.");
}

/** One run of the home job. */
export async function advanceHome(ctx: Ctx, homeId: string): Promise<void> {
  const h = ctx.db.prepare("SELECT * FROM homes WHERE id = ?").get(homeId) as HomeRow | undefined;
  if (!h || h.state !== "moving") return;
  for (const w of pieces(ctx, h)) {
    const steps = ctx.db.prepare("SELECT * FROM home_steps WHERE home_id = ? AND piece_id = ? ORDER BY created_ms, rowid").all(h.id, w.id) as StepRow[];
    let finished: boolean;
    try {
      finished = await movePiece(ctx, h, w, steps);
    } catch (e) {
      if (!(e instanceof StepFailed)) throw e;
      if (e.detail === "exit_needs_unlock") addStep(ctx, h.id, w.id, "sign", "failed", sentence("exit_needs_unlock"));
      else if (e.detail !== "arrival" && e.detail !== "piece_in_use") addStep(ctx, h.id, w.id, "move", "failed", e.detail);
      // Stop moving, but always ask to lock again.
      return relock(ctx, h, true);
    }
    if (!finished) return schedule(ctx, h.id, ctx.now() + HOME_POLL_MS);
  }
  await relock(ctx, h, false);
}
