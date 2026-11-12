// Setting up the pieces key: 12 words, a check of 3 of them, a signed note that tells our
// server the key's public key, and the private balance wallet. The words and the secret key
// stay in this browser, and nothing is added to the user's NEAR account.
import { keyFromMnemonic, newMnemonic, normalizeMnemonic, piecesKeyProof, type PiecesKey } from "unhuntable-client/keys";
import type { Api } from "./api";
import { makeWallet, type WalletDeps } from "./pieces";

export { newMnemonic };

/** Three different word positions (0-11) to ask back, in order. */
export function pickPositions(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): number[] {
  const out: number[] = [];
  while (out.length < 3) {
    const p = random(1)[0] % 16;
    if (p < 12 && !out.includes(p)) out.push(p);
  }
  return out.sort((a, b) => a - b);
}

/** True only when every typed word matches the word at its position. */
export function checkWords(words: string, positions: number[], typed: string[]): boolean {
  const list = normalizeMnemonic(words).split(" ");
  if (positions.length !== 3 || typed.length !== positions.length) return false;
  return positions.every((p, i) => (typed[i] ?? "").trim().toLowerCase() === list[p]);
}

/** The pieces key from 12 words (restore). Throws a plain sentence on bad words. */
export function restoreKey(words: string): PiecesKey {
  try {
    return keyFromMnemonic(words);
  } catch {
    throw new Error("Those words are not a valid 12-word phrase. Check each word and try again.");
  }
}

/**
 * Tell the server the pieces key's public key, with a signature that proves this device holds it.
 * Nothing is added to the NEAR account: the key's own implicit account owns the OutLayer wallets.
 */
export async function linkPiecesKey(d: WalletDeps): Promise<void> {
  await d.api.piecesKey(piecesKeyProof(d.key, d.account, (d.now ?? Date.now)()));
}

/** Step d: the private balance wallet. */
export async function makeBalanceWallet(d: WalletDeps): Promise<string> {
  return makeWallet(d, "balance");
}

/** True when the server already has a ready private balance wallet. */
export function balanceReady(me: Awaited<ReturnType<Api["me"]>>): boolean {
  return me.wallets.some((w) => w.label === "balance" && w.ready);
}
