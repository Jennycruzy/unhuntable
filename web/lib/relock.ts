// The "Lock your pieces again" banner's memory. Kept apart from the send-home flow so the
// shell, which shows the banner on every screen, loads none of the wallet code.

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
