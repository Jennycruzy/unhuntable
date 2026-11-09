// Going home: OutLayer pieces are unlocked with one wallet approval, the money moves to the
// private balance, then a second approval locks the pieces again. Pieces controlled by NEAR
// Chain Signatures need no unlock: this page signs their moves with their piece keys, to a
// deposit address of the user's own private balance that it asks OutLayer for itself.
import type { Api } from "./api";
import { approveBatch } from "./trade";
import type { HomeStart, HomeState, PolicyConfirmed } from "./types";
import { localRelock, type RelockStore } from "./relock";
import type { AppWallet } from "./wallet";
import { signHomeAll, type ChainSigDeps } from "./chainsig";

export { localRelock, type RelockStore };

export class HomeFlow {
  constructor(
    private readonly api: Api,
    private readonly wallet: AppWallet,
    private readonly relock: RelockStore = localRelock,
  ) {}

  start(labels?: string[]): Promise<HomeStart> {
    return this.api.home(labels);
  }

  /** Sign the NEAR-controlled pieces' moves with their piece keys (no wallet pop-up). */
  signChainSig(s: HomeStart, d: Omit<ChainSigDeps, "api">): Promise<number> {
    return signHomeAll({ ...d, api: this.api }, s);
  }

  /** First approval: unlock. From here until the relock is confirmed, the banner shows. */
  async approveUnlock(s: HomeStart): Promise<PolicyConfirmed> {
    if (!s.unlockBatch) throw new Error("There is nothing to unlock.");
    const txHashes = await this.wallet.signAndSendTransactions(s.unlockBatch.transactions);
    // signed: the pieces are unlocking now, whatever the server answers next
    this.relock.set(s.homeId);
    return this.api.policyConfirm({ homeId: s.homeId, txHashes });
  }

  poll(homeId: string): Promise<HomeState> {
    return this.api.homeState(homeId);
  }

  /** Second approval: lock again. The banner goes only once the server confirms. */
  async approveRelock(s: HomeState): Promise<PolicyConfirmed> {
    if (!s.relockBatch) throw new Error("There is nothing to lock yet.");
    const r = await approveBatch(this.api, this.wallet, s.relockBatch, { homeId: s.homeId });
    this.relock.clear();
    return r;
  }
}

const STEP_WORDS: Record<string, string> = {
  unlock: "Unlocking the piece",
  close: "Closing the position",
  to_spot: "Moving money to spot",
  send: "Sending to your private balance",
  arrive: "Arriving in your private balance",
  relock: "Locking the piece again",
};

/** A step from the server in plain words. */
export function stepWords(s: { label: string; step: string; status: string }): string {
  const what = STEP_WORDS[s.step] ?? s.step.replace(/_/g, " ");
  return `${s.label}: ${what} (${s.status.replace(/_/g, " ")})`;
}
