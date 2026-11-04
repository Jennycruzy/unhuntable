// The largest public position on Hyperliquid right now, for the start page: its side, size,
// liquidation price and resting stop, all read from Hyperliquid's own public endpoints.
// The leaderboard is ~40 MB, so it is scanned as a stream for the top accounts only.
import type { Hyperliquid } from "./hl.js";

export const LEADERBOARD_URL = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";
export const LEADERS_EVERY_MS = 24 * 60 * 60_000;
export const WHALE_EVERY_MS = 5 * 60_000;
export const TOP_ACCOUNTS = 60;

export interface Whale {
  address: string;
  coin: string;
  side: "long" | "short";
  sizeUsd: number;
  entryPx: number;
  liqPx: number;
  markPx: number;
  /** The nearest resting stop on the book for this position, if any. */
  stopPx: number | null;
  asOfMs: number;
}

const ROW = /"ethAddress":\s*"(0x[0-9a-fA-F]{40})",\s*"accountValue":\s*"(-?[0-9.]+)"/g;

/** The n accounts with the largest account value, from the leaderboard text as it streams in. */
export async function topAccounts(chunks: AsyncIterable<string>, n = TOP_ACCOUNTS): Promise<string[]> {
  let top: { a: string; v: number }[] = [];
  let carry = "";
  for await (const chunk of chunks) {
    const text = carry + chunk;
    let last = 0;
    for (const m of text.matchAll(ROW)) {
      top.push({ a: m[1].toLowerCase(), v: Number(m[2]) });
      last = m.index! + m[0].length;
    }
    // keep the tail, which may hold the start of a row cut by the chunk boundary
    carry = text.slice(Math.max(last, text.length - 200));
    if (top.length > n * 4) top = top.sort((x, y) => y.v - x.v).slice(0, n);
  }
  const seen = new Set<string>();
  return top
    .sort((x, y) => y.v - x.v)
    .filter((r) => !seen.has(r.a) && seen.add(r.a))
    .slice(0, n)
    .map((r) => r.a);
}

const num = (v: unknown): number | null => {
  const x = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(x) ? x : null;
};

/** The largest single position across these accounts that has a liquidation price. */
export function largest(states: { address: string; state: any }[]): Omit<Whale, "markPx" | "stopPx" | "asOfMs"> | undefined {
  let best: Omit<Whale, "markPx" | "stopPx" | "asOfMs"> | undefined;
  for (const { address, state } of states) {
    for (const ap of state?.assetPositions ?? []) {
      const p = ap?.position;
      const szi = num(p?.szi);
      const value = num(p?.positionValue);
      const entryPx = num(p?.entryPx);
      const liqPx = num(p?.liquidationPx);
      if (!szi || !value || !entryPx || !liqPx || liqPx <= 0) continue;
      const side = szi > 0 ? "long" : "short";
      // a liquidation on the wrong side of entry means cross-margin noise, not a level anyone hunts
      if ((side === "long" && liqPx >= entryPx) || (side === "short" && liqPx <= entryPx)) continue;
      if (!best || Math.abs(value) > best.sizeUsd) best = { address, coin: String(p.coin), side, sizeUsd: Math.abs(value), entryPx, liqPx };
    }
  }
  return best;
}

/** The resting stop for this position nearest the price: a trigger order that closes it. */
export function nearestStop(orders: any[], coin: string, side: "long" | "short", markPx: number): number | null {
  const closing = side === "long" ? "A" : "B";
  const stops = (orders ?? [])
    .filter((o) => o?.coin === coin && o?.isTrigger && o?.side === closing && /stop/i.test(String(o?.orderType ?? "")))
    .map((o) => num(o.triggerPx))
    .filter((x): x is number => x !== null && (side === "long" ? x < markPx : x > markPx));
  if (stops.length === 0) return null;
  return stops.reduce((a, b) => (Math.abs(b - markPx) < Math.abs(a - markPx) ? b : a));
}

async function* textChunks(res: Response): AsyncIterable<string> {
  if (!res.body) return;
  const decoder = new TextDecoder();
  for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) yield decoder.decode(part, { stream: true });
}

export class WhaleWatch {
  private accounts: string[] = [];
  private accountsAt = 0;
  private now: () => number;
  latest: Whale | undefined;

  constructor(
    private readonly hl: Hyperliquid,
    private readonly opts: { fetch?: typeof fetch; leaderboardUrl?: string; now?: () => number } = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  private async leaders(): Promise<string[]> {
    if (this.accounts.length > 0 && this.now() - this.accountsAt < LEADERS_EVERY_MS) return this.accounts;
    const f = this.opts.fetch ?? fetch;
    const res = await f(this.opts.leaderboardUrl ?? LEADERBOARD_URL);
    if (!res.ok) throw new Error(`leaderboard answered HTTP ${res.status}`);
    const found = await topAccounts(textChunks(res));
    if (found.length === 0) throw new Error("leaderboard had no accounts");
    this.accounts = found;
    this.accountsAt = this.now();
    return found;
  }

  /** Read the top accounts again and keep the largest hunted-looking position. */
  async refresh(): Promise<Whale | undefined> {
    const accounts = await this.leaders();
    const states: { address: string; state: any }[] = [];
    for (const address of accounts) {
      try {
        states.push({ address, state: await this.hl.info({ type: "clearinghouseState", user: address }) });
      } catch {
        // one account failing to answer does not stop the rest
      }
    }
    const best = largest(states);
    if (!best) return this.latest;
    const mids = await this.hl.allMids();
    const markPx = mids[best.coin];
    if (!markPx) return this.latest;
    const orders = await this.hl.info({ type: "frontendOpenOrders", user: best.address }).catch(() => []);
    this.latest = { ...best, markPx, stopPx: nearestStop(orders, best.coin, best.side, markPx), asOfMs: this.now() };
    return this.latest;
  }
}
