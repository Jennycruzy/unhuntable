// Sign in: the wallet signs the NEP-413 message the server expects, then POST /api/session.
import type { Api } from "./api";
import { APP_NAME, NETWORK } from "./config";
import { isWrongNetwork, type AppWallet } from "./wallet";

/** The text the server checks (server/src/auth.ts SIGN_IN_TEXT), then the time. */
export const SIGN_IN_TEXT = "Sign in to Unhuntable";

export interface SignInRequest {
  message: string;
  recipient: string;
  nonce: Uint8Array;
}

export function signInRequest(nowMs: number, random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): SignInRequest {
  return { message: `${SIGN_IN_TEXT}\n${new Date(nowMs).toISOString()}`, recipient: APP_NAME, nonce: random(32) };
}

export function base64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export class WrongNetwork extends Error {
  constructor(accountId: string) {
    super(`${accountId} is on the other NEAR network. Switch your wallet to NEAR ${NETWORK} and sign in again.`);
    this.name = "WrongNetwork";
  }
}

export async function signIn(api: Api, wallet: AppWallet, nowMs = Date.now()): Promise<string> {
  const { accountId } = await wallet.signIn();
  if (isWrongNetwork(accountId)) throw new WrongNetwork(accountId);
  const req = signInRequest(nowMs);
  const signed = await wallet.signMessage(req);
  const account = signed.accountId || accountId;
  if (isWrongNetwork(account)) throw new WrongNetwork(account);
  await api.session({
    accountId: account,
    publicKey: signed.publicKey,
    signature: signed.signature,
    message: req.message,
    nonce: base64(req.nonce),
    recipient: req.recipient,
  });
  return account;
}
