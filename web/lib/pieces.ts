// Making one OutLayer wallet ("balance" or a piece) from the pieces key, in this browser.
// The browser registers the wallet (if new) and lets the server's key act for it; the
// server only ever learns the key's hash and the wallet's seed.
import { OutLayerDeterministic, ownerAccount, seedFor, type PiecesKey } from "unhuntable-client/keys";
import type { Api, Fetch } from "./api";

export interface WalletDeps {
  api: Api;
  key: PiecesKey;
  account: string;
  /** fetch for OutLayer calls (tests inject one). */
  outlayerFetch?: Fetch;
  now?: () => number;
}

/** Make the wallet for a label and return its address (EVM for pieces, NEAR for "balance"). */
export async function makeWallet(d: WalletDeps, label: string): Promise<string> {
  const seed = seedFor(d.key, label);
  const w = new OutLayerDeterministic({ key: d.key, account: ownerAccount(d.key), seed, fetch: d.outlayerFetch, now: d.now });
  if (!(await w.exists())) await w.register();
  const { requestId, keyHash } = await d.api.walletKey(label);
  await w.addDelegateKey(keyHash);
  const c = await d.api.walletConfirm(requestId, label, seed);
  return c.address;
}

/** A piece's Hyperliquid account, read from OutLayer with the pieces key. */
export async function pieceAddress(d: WalletDeps, label: string): Promise<string> {
  const w = new OutLayerDeterministic({ key: d.key, account: ownerAccount(d.key), seed: seedFor(d.key, label), fetch: d.outlayerFetch, now: d.now });
  return w.evmAddress();
}
