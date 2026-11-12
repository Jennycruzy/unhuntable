// Buying a key to a trader: one wallet approval lets the private balance pay that trader (its
// lock lists the trader's private balance), then the key is switched on and pays day by day.
import type { Api } from "./api";
import type { KeyKind, TraderRecord } from "./types";
import type { AppWallet } from "./wallet";

export const MIN_COPY_USD = 15;
export const SPLIT_FROM_USD = 30;

export function checkCopySize(v: string): string | undefined {
  const n = Number(v);
  if (!Number.isFinite(n) || n < MIN_COPY_USD) return `A copy is at least $${MIN_COPY_USD}.`;
  if (n > 5000) return "A copy is at most $5,000.";
  return undefined;
}

/** How a copy of this size is placed: one piece, or split. */
export function copyShape(usd: number): string {
  return usd >= SPLIT_FROM_USD ? "split across several of your pieces" : "in one of your pieces";
}

export async function buyKey(api: Api, wallet: AppWallet, body: { handle: string; kind: KeyKind; copyUsd?: number }) {
  const f = await api.follow(body);
  await wallet.signAndSendTransactions(f.policyBatch.transactions);
  return api.confirmKey(f.keyId);
}

/** A key an agent asked for: the owner approves it the same way. */
export async function approveKey(api: Api, wallet: AppWallet, keyId: string) {
  const { policyBatch } = await api.keyBatch(keyId);
  await wallet.signAndSendTransactions(policyBatch.transactions);
  return api.confirmKey(keyId);
}

/** The signed record as the verify tool reads it: node tools/easverify.cjs <file>. */
export function recordFile(r: TraderRecord): string {
  const { eas, asOfMs: _a, ...totals } = r;
  return JSON.stringify({ output: { eas, totals } }, null, 1);
}
