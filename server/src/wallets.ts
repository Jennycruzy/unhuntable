// The pieces key and the user's wallets: the private balance ("balance") and one wallet per
// piece ("piece:<n>"). The browser registers each OutLayer deterministic wallet and adds our
// key's hash as a delegate key; we make the key, keep it encrypted, and prove it works.
import { USDC_NEAR, fromUnits } from "unhuntable-client";
import { z } from "zod";
import { balanceWallet, userRow, walletByLabel, type Ctx, type WalletRow } from "./ctx.js";
import { newId, newShardId } from "./db.js";
import { KeyStoreError } from "./keystore.js";
import { NearRpcError } from "./near.js";
import { OutLayerWalletError } from "./outlayer.js";
import { ApiError } from "./refusals.js";

export const Label = z.string().regex(/^(balance|piece:(0|[1-9]\d{0,5}))$/);
export const PiecesKeyBody = z.object({ publicKey: z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/) });
export const KeyBody = z.object({ label: Label });
export const ConfirmBody = z.object({ requestId: z.string().uuid(), label: Label, seed: z.string().min(1).max(200) });

function keystore(ctx: Ctx) {
  if (!ctx.keystore) throw new Error("the wallet key store is not set up (WALLET_KEYS_FILE and keystoreKey)");
  return ctx.keystore;
}

async function keyOnAccount(ctx: Ctx, account: string, publicKey: string): Promise<boolean> {
  try {
    return (await ctx.near.accessKey(account, publicKey)) !== null;
  } catch (e) {
    if (e instanceof NearRpcError) throw new ApiError("near_unreachable");
    throw e;
  }
}

export async function me(ctx: Ctx, userId: string) {
  const u = userRow(ctx, userId);
  const onAccount = u.pieces_public_key ? await keyOnAccount(ctx, u.near_account, u.pieces_public_key) : false;
  const rows = ctx.db
    .prepare("SELECT label, kind, wallet_id FROM pieces WHERE user_id = ? AND label IS NOT NULL ORDER BY kind = 'piece', created_ms, label")
    .all(userId) as { label: string; kind: "balance" | "piece"; wallet_id: string | null }[];
  return {
    accountId: u.near_account,
    piecesKey: onAccount ? ("on_account" as const) : ("missing" as const),
    wallets: rows.map((r) => ({ label: r.label, kind: r.kind, ready: r.wallet_id !== null })),
  };
}

export async function setPiecesKey(ctx: Ctx, userId: string, body: z.infer<typeof PiecesKeyBody>) {
  const u = userRow(ctx, userId);
  if (!(await keyOnAccount(ctx, u.near_account, body.publicKey))) throw new ApiError("pieces_key_missing");
  ctx.db.prepare("UPDATE users SET pieces_public_key = ? WHERE id = ?").run(body.publicKey, userId);
  return { ok: true as const };
}

export function newKey(ctx: Ctx, userId: string, body: z.infer<typeof KeyBody>) {
  userRow(ctx, userId);
  const { requestId, keyHash } = keystore(ctx).newWalletKey(body.label, userId);
  return { requestId, keyHash };
}

/** Prove our key works for the wallet the browser made, then save the wallet. */
export async function confirmWallet(ctx: Ctx, userId: string, body: z.infer<typeof ConfirmBody>) {
  const ks = keystore(ctx);
  let info;
  try {
    info = ks.info(body.requestId);
  } catch (e) {
    if (e instanceof KeyStoreError) throw new ApiError("unknown_request");
    throw e;
  }
  // A request of another user reads exactly like an unknown one.
  if (info.owner !== userId) throw new ApiError("unknown_request");
  if (info.label !== body.label) throw new ApiError("bad_request");

  let near;
  try {
    near = await ks.withRequestKey(body.requestId, (key) => ctx.wallet.addressWithKey(key, "near"));
  } catch (e) {
    if (e instanceof OutLayerWalletError) throw new ApiError("wallet_key_refused");
    throw e;
  }
  try {
    ks.confirm(body.requestId, near.walletId);
  } catch (e) {
    if (e instanceof KeyStoreError) throw new ApiError("wallet_key_refused");
    throw e;
  }
  const kind = body.label === "balance" ? "balance" : "piece";
  let address = near.address;
  let hl: string | null = null;
  if (kind === "piece") {
    try {
      hl = (await ctx.wallet.address(near.walletId, "base")).address.toLowerCase();
    } catch (e) {
      if (e instanceof OutLayerWalletError) throw new ApiError("wallet_key_refused");
      throw e;
    }
    if (!/^0x[0-9a-f]{40}$/.test(hl)) throw new ApiError("wallet_key_refused");
    address = hl;
  }

  const existing = walletByLabel(ctx, userId, body.label);
  if (existing) {
    ctx.db
      .prepare("UPDATE pieces SET seed = ?, wallet_id = ?, wallet_pubkey = ?, key_hash = ?, hl_address = COALESCE(?, hl_address) WHERE id = ?")
      .run(body.seed, near.walletId, near.publicKey, info.keyHash, hl, existing.id);
  } else {
    ctx.db
      .prepare(
        `INSERT INTO pieces (id, user_id, label, seed, kind, shard_id, wallet_id, wallet_pubkey, key_hash, hl_address, policy_state, created_ms, network)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', ?, ?)`,
      )
      .run(newId(), userId, body.label, body.seed, kind, kind === "piece" ? newShardId() : null, near.walletId, near.publicKey, info.keyHash, hl, ctx.now(), ctx.network);
  }
  return { ok: true as const, label: body.label, address };
}

/** USDC in the private balance, as token units (6 decimals). */
export async function privateUnits(ctx: Ctx, walletId: string): Promise<bigint> {
  const b = await ctx.wallet.balance(walletId);
  return BigInt(b.balances.find((x) => x.token === USDC_NEAR)?.balance ?? "0");
}

export async function balances(ctx: Ctx, userId: string) {
  userRow(ctx, userId);
  const bal = walletByLabel(ctx, userId, "balance");
  const privateUsdc = bal?.wallet_id ? fromUnits(await privateUnits(ctx, balanceWallet(ctx, userId).wallet_id), 6) : "0";
  const rows = ctx.db
    .prepare("SELECT * FROM pieces WHERE user_id = ? AND kind = 'piece' AND hl_address IS NOT NULL ORDER BY created_ms, label")
    .all(userId) as WalletRow[];
  const pieces = [];
  for (const r of rows) {
    const perp = await ctx.hl.perp(r.hl_address!);
    const spot = await ctx.hl.spotUsdc(r.hl_address!);
    pieces.push({ label: r.label, shard: r.shard_id, perpUsd: String(perp.accountValue), spotUsd: spot });
  }
  return { privateUsdc, pieces };
}
