// Going home: the pieces are unlocked with one wallet approval, the money moves to the
// private balance, then a second approval locks the pieces again.
import type { Api } from "./api";
import { approveBatch } from "./trade";
import type { HomeStart, HomeState, PolicyConfirmed } from "./types";
import type { AppWallet } from "./wallet";

const RELOCK = "unhuntable.relock";

/** Where the "Lock your pieces again" banner is remembered until the relock is confirmed. */
export interface RelockStore {
  get(): string | undefined;
  set(homeId: string): void;
  clear(): void;
}

export const localRelock: RelockStore = {
  get() {
    try {
      return localStorage.getItem(RELOCK) ?? undefined;
    } catch {
      return undefined;
    }
  },
  set(id) {
    try {
      localStorage.setItem(RELOCK, id);
      window.dispatchEvent(new Event("unhuntable-relock"));
    } catch {
      // the banner then lasts only for this page
    }
  },
  clear() {
    try {
      localStorage.removeItem(RELOCK);
      window.dispatchEvent(new Event("unhuntable-relock"));
    } catch {
      // nothing to clear
    }
  },
};

export class HomeFlow {
  constructor(
    private readonly api: Api,
    private readonly wallet: AppWallet,
    private readonly relock: RelockStore = localRelock,
  ) {}

  start(labels?: string[]): Promise<HomeStart> {
    return this.api.home(labels);
  }

  /** First approval: unlock. From here until the relock is confirmed, the banner shows. */
  async approveUnlock(s: HomeStart): Promise<PolicyConfirmed> {
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
