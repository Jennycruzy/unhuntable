// What the money flows share: the store, the clock and the outside services, plus small
// helpers to read users and wallets. Every outside service takes an injected fetch.
import type { Logger } from "pino";
import type { Db } from "./db.js";
import { newId } from "./db.js";
import type { GuardOps } from "./guard.js";
import type { Hyperliquid } from "./hl.js";
import type { JobRunner } from "./jobs.js";
import type { KeyStore } from "./keystore.js";
import type { NearRpc } from "./near.js";
import type { OneClick } from "./oneclick.js";
import type { OutLayerWallet } from "./outlayer.js";
import type { NearRelay } from "./relay.js";
import { ApiError } from "./refusals.js";

export interface Ctx {
  db: Db;
  network: string;
  now: () => number;
  wallet: OutLayerWallet;
  keystore?: KeyStore;
  near: NearRpc;
  hl: Hyperliquid;
  oneClick: OneClick;
  guard: GuardOps;
  jobs: JobRunner;
  policyContract: string;
  appFeeAccount: string;
  /** Pieces controlled by NEAR Chain Signatures. When set, new pieces are made this way. */
  chainsig?: { contract: string; relay: Pick<NearRelay, "call">; chain: "Mainnet" | "Testnet" };
  random: (n: number) => Uint8Array;
  log?: Logger;
}

export interface UserRow {
  id: string;
  near_account: string;
  pieces_public_key: string | null;
}

export interface WalletRow {
  id: string;
  user_id: string;
  label: string | null;
  seed: string | null;
  kind: "balance" | "piece";
  /** "outlayer": an OutLayer wallet is the Hyperliquid account. "near": NEAR Chain Signatures control it. */
  control: "outlayer" | "near";
  /** Chain-signature pieces: the piece key, 64 hex characters. */
  piece_key: string | null;
  shard_id: string | null;
  wallet_id: string | null;
  wallet_pubkey: string | null;
  key_hash: string | null;
  hl_address: string | null;
  agent: string | null;
  policy_state: "none" | "locked" | "unlocked";
  policy_json: string | null;
  created_ms: number;
}

export function userRow(ctx: Ctx, userId: string): UserRow {
  const u = ctx.db.prepare("SELECT id, near_account, pieces_public_key FROM users WHERE id = ?").get(userId) as UserRow | undefined;
  if (!u) throw new ApiError("not_signed_in");
  return u;
}

export function walletByLabel(ctx: Ctx, userId: string, label: string): WalletRow | undefined {
  return ctx.db.prepare("SELECT * FROM pieces WHERE user_id = ? AND label = ?").get(userId, label) as WalletRow | undefined;
}

export function walletById(ctx: Ctx, id: string): WalletRow {
  const w = ctx.db.prepare("SELECT * FROM pieces WHERE id = ?").get(id) as WalletRow | undefined;
  if (!w) throw new Error("wallet row is missing");
  return w;
}

/** The user's private balance wallet, ready to use, or a refusal. */
export function balanceWallet(ctx: Ctx, userId: string): WalletRow & { wallet_id: string } {
  const w = walletByLabel(ctx, userId, "balance");
  if (!w || !w.wallet_id) throw new ApiError("balance_missing");
  return w as WalletRow & { wallet_id: string };
}

export function addAlert(ctx: Ctx, userId: string, text: string, positionId: string | null = null): void {
  ctx.db
    .prepare("INSERT INTO alerts (id, user_id, text, position_id, created_ms, network) VALUES (?, ?, ?, ?, ?, ?)")
    .run(newId(), userId, text, positionId, ctx.now(), ctx.network);
}

/** Two decimals, as a decimal string. */
export function usd(x: number): string {
  return (Math.round(x * 100) / 100).toFixed(2);
}
