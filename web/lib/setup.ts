// Setting up the pieces key: 12 words, a check of 3 of them, the key on the user's NEAR
// account, and the private balance wallet. The words and the secret key stay in this browser.
import { addKeyAction, keyFromMnemonic, newMnemonic, normalizeMnemonic, type PiecesKey } from "unhuntable-client/keys";
import type { Api } from "./api";
import { makeWallet, type WalletDeps } from "./pieces";
import type { PlainTransaction } from "./types";
import type { AppWallet } from "./wallet";

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

/** The one transaction the wallet signs: add the pieces key to the account, limited to outlayer.near. */
export function addKeyTransaction(account: string, key: PiecesKey): PlainTransaction {
  return { receiverId: account, actions: [addKeyAction(key.publicKeyStr) as unknown as PlainTransaction["actions"][number]] };
}

/** What the wallet will sign, in plain words, shown before it opens. */
export function addKeyWords(account: string, key: PiecesKey): string[] {
  return [
    `Add a new key to ${account}: ${key.publicKeyStr}.`,
    "It is a limited key: it can only call outlayer.near, and it cannot spend your NEAR.",
    "It is not a full-access key. You can remove it from your account at any time.",
  ];
}

/** The pieces key from 12 words (restore). Throws a plain sentence on bad words. */
export function restoreKey(words: string): PiecesKey {
  try {
    return keyFromMnemonic(words);
  } catch {
    throw new Error("Those words are not a valid 12-word phrase. Check each word and try again.");
  }
}

export interface SetupDeps extends WalletDeps {
  wallet: AppWallet;
}

/** Steps b and c: the key on the account, then tell the server its public key. */
export async function putKeyOnAccount(d: SetupDeps): Promise<string> {
  const hash = await d.wallet.signAndSendTransaction(addKeyTransaction(d.account, d.key));
  await d.api.piecesKey(d.key.publicKeyStr);
  return hash;
}

/** Step d: the private balance wallet. */
export async function makeBalanceWallet(d: WalletDeps): Promise<string> {
  return makeWallet(d, "balance");
}

/** True when the server already has a ready private balance wallet. */
export function balanceReady(me: Awaited<ReturnType<Api["me"]>>): boolean {
  return me.wallets.some((w) => w.label === "balance" && w.ready);
}
