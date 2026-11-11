// The Hunt Map collector. It reads what anyone can read on Hyperliquid: the liquidation price
// of every large position held by the biggest accounts, and the resting stops under them.
// Each round is stored with one-minute candles, so the levels can later be compared with
// where the price went. It runs as its own process with its own SQLite file and never
// touches the app's data.
import Database from "better-sqlite3";
import { statfsSync } from "node:fs";
import { dirname } from "node:path";
import type { Hyperliquid } from "./hl.js";
import { LEADERBOARD_URL, topAccounts } from "./whale.js";

export type HuntDb = Database.Database;

/** Accounts read from the leaderboard, largest account value first. */
export const TOP_ACCOUNTS = 2000;
/** A position smaller than this is not stored. */
export const MIN_POSITION_USD = 250_000;
/** Accounts whose stops are read each round. Every account with a stored position gets its turn. */
export const STOP_ACCOUNTS = 40;
/** How many leaderboard accounts are looked at again each round, in turn. */
export const SCAN_PER_ROUND = 100;
/** A round reads at least this many accounts, so the first rounds cover the leaderboard quickly. */
export const ACCOUNTS_PER_ROUND = 400;
/** Coins that always get candles; the rest are picked by how much money sits on their levels. */
export const BASE_COINS = ["BTC", "ETH", "SOL", "HYPE"];
export const CANDLE_COINS = 12;
export const ROUND_EVERY_MS = 5 * 60_000;
export const LEADERS_EVERY_MS = 24 * 60 * 60_000;
/** An account with no stored position for this long stops being read every round. */
export const IDLE_AFTER_MS = 24 * 60 * 60_000;
/** Hyperliquid allows 1200 request weight a minute per address; the collector stays well under. */
export const WEIGHT_PER_MINUTE = 500;
/** Accounts whose fill history is read each round, in turn, for liquidations. */
export const FILLS_PER_ROUND = 6;
/** How far back liquidations are kept: Hyperliquid's 5-minute candles reach about this far. */
export const REPLAY_DAYS = 17;
/** A liquidation this large or larger gets candles around it, for its replay. */
export const REPLAY_MIN_USD = 100_000;
/** The replay window: this long before and after the liquidation. */
export const REPLAY_WINDOW_MS = 60 * 60_000;
/** Replays given candles each round. */
export const REPLAY_CANDLES_PER_ROUND = 6;
/** Rounds are skipped when the disk has less free space than this. */
export const MIN_FREE_BYTES = 400 * 1024 * 1024;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  address TEXT PRIMARY KEY,
  first_ms INTEGER NOT NULL,
  read_ms INTEGER NOT NULL,
  held_ms INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS rounds (
  ms INTEGER PRIMARY KEY,
  accounts INTEGER NOT NULL,
  levels INTEGER NOT NULL,
  stops INTEGER NOT NULL,
  errors INTEGER NOT NULL,
  took_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS levels (
  ms INTEGER NOT NULL,
  account TEXT NOT NULL,
  coin TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('long', 'short')),
  szi REAL NOT NULL,
  value_usd REAL NOT NULL,
  entry_px REAL NOT NULL,
  mark_px REAL NOT NULL,
  liq_px REAL,
  leverage REAL,
  cross_margin INTEGER NOT NULL,
  PRIMARY KEY (ms, account, coin)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS levels_coin ON levels(coin, ms);
CREATE TABLE IF NOT EXISTS stops (
  ms INTEGER NOT NULL,
  account TEXT NOT NULL,
  coin TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('long', 'short')),
  kind TEXT NOT NULL CHECK (kind IN ('stop', 'take_profit')),
  trigger_px REAL NOT NULL,
  size REAL NOT NULL,
  oid INTEGER NOT NULL,
  PRIMARY KEY (ms, oid)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS stops_coin ON stops(coin, ms);
CREATE TABLE IF NOT EXISTS liquidations (
  account TEXT NOT NULL,
  coin TEXT NOT NULL,
  ms INTEGER NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('long', 'short')),
  px REAL NOT NULL,
  size REAL NOT NULL,
  value_usd REAL NOT NULL,
  mark_px REAL,
  method TEXT,
  PRIMARY KEY (account, coin, ms)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS liquidations_ms ON liquidations(ms);
CREATE TABLE IF NOT EXISTS fills_read (
  account TEXT PRIMARY KEY,
  read_ms INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS replay_candles (
  coin TEXT NOT NULL,
  t INTEGER NOT NULL,
  o REAL NOT NULL,
  h REAL NOT NULL,
  l REAL NOT NULL,
  c REAL NOT NULL,
  PRIMARY KEY (coin, t)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS candles (
  coin TEXT NOT NULL,
  t INTEGER NOT NULL,
  o REAL NOT NULL,
  h REAL NOT NULL,
  l REAL NOT NULL,
  c REAL NOT NULL,
  PRIMARY KEY (coin, t)
) WITHOUT ROWID;
`;

export function openHuntDb(path: string): HuntDb {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  return db;
}

/** The collector's store, opened for reading only by the API server. */
export function openHuntDbReadOnly(path: string): HuntDb {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  return db;
}

export interface Level {
  account: string;
  coin: string;
  side: "long" | "short";
  szi: number;
  valueUsd: number;
  entryPx: number;
  markPx: number;
  /** Null when Hyperliquid shows no liquidation price for the position. */
  liqPx: number | null;
  leverage: number | null;
  cross: boolean;
}

export interface Stop {
  account: string;
  coin: string;
  /** Side of the position the order closes. */
  side: "long" | "short";
  kind: "stop" | "take_profit";
  triggerPx: number;
  size: number;
  oid: number;
}

const num = (v: unknown): number | null => {
  const x = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(x) ? x : null;
};

/** The positions of one public account state that are large enough to store. */
export function levelsOf(account: string, state: any, minUsd = MIN_POSITION_USD): Level[] {
  const out: Level[] = [];
  for (const ap of state?.assetPositions ?? []) {
    const p = ap?.position;
    const szi = num(p?.szi);
    const value = num(p?.positionValue);
    const entryPx = num(p?.entryPx);
    if (!szi || !value || !entryPx || Math.abs(value) < minUsd) continue;
    const liq = num(p?.liquidationPx);
    out.push({
      account,
      coin: String(p.coin),
      side: szi > 0 ? "long" : "short",
      szi,
      valueUsd: Math.abs(value),
      entryPx,
      markPx: Math.abs(value) / Math.abs(szi),
      liqPx: liq !== null && liq > 0 ? liq : null,
      leverage: num(p?.leverage?.value),
      cross: p?.leverage?.type !== "isolated",
    });
  }
  return out;
}

/** The resting trigger orders that close one of these positions: stops and take-profits. */
export function stopsOf(account: string, orders: any[], levels: Level[]): Stop[] {
  const sideOf = new Map(levels.filter((l) => l.account === account).map((l) => [l.coin, l.side]));
  const out: Stop[] = [];
  for (const o of orders ?? []) {
    if (!o?.isTrigger) continue;
    const side = sideOf.get(String(o.coin));
    if (!side) continue;
    // an order closes a long by selling ("A") and a short by buying ("B")
    if (o.side !== (side === "long" ? "A" : "B")) continue;
    const type = String(o.orderType ?? "");
    const kind = /stop/i.test(type) ? "stop" : /take profit/i.test(type) ? "take_profit" : null;
    const triggerPx = num(o.triggerPx);
    const oid = num(o.oid);
    const size = num(o.origSz) ?? num(o.sz) ?? 0;
    if (!kind || !triggerPx || oid === null) continue;
    out.push({ account, coin: String(o.coin), side, kind, triggerPx, size, oid });
  }
  return out;
}

/** The coins that get candles: the base coins, then the ones with the most money on their levels. */
export function candleCoins(levels: Level[], n = CANDLE_COINS): string[] {
  const usd = new Map<string, number>();
  for (const l of levels) usd.set(l.coin, (usd.get(l.coin) ?? 0) + l.valueUsd);
  const ranked = [...usd.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  // coins of other market lists ("xyz:NVDA") have their own candle feed and are left out here
  return [...new Set([...BASE_COINS, ...ranked.filter((c) => !c.includes(":"))])].slice(0, Math.max(n, BASE_COINS.length));
}

/** The accounts with the largest stored positions, largest first. */
export function biggestAccounts(levels: Level[], n = Infinity): string[] {
  const top = new Map<string, number>();
  for (const l of levels) top.set(l.account, Math.max(top.get(l.account) ?? 0, l.valueUsd));
  return [...top.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([a]) => a);
}

export interface Liquidation {
  account: string;
  coin: string;
  ms: number;
  /** The side of the position that was liquidated. */
  side: "long" | "short";
  /** Average price of the liquidation fills. */
  px: number;
  size: number;
  valueUsd: number;
  markPx: number | null;
  method: string | null;
}

/**
 * The liquidations of this account in its fill history: fills that Hyperliquid marks with
 * the account as the liquidated user, grouped per coin when they come within a minute.
 */
export function liquidationsOf(account: string, fills: any[]): Liquidation[] {
  const me = account.toLowerCase();
  const mine = (Array.isArray(fills) ? fills : [])
    .filter((f) => String(f?.liquidation?.liquidatedUser ?? "").toLowerCase() === me && num(f?.px) !== null && num(f?.sz) !== null && num(f?.time) !== null)
    .sort((a, b) => num(a.time)! - num(b.time)!);
  const out: Liquidation[] = [];
  for (const f of mine) {
    const px = num(f.px)!;
    const sz = num(f.sz)!;
    const t = num(f.time)!;
    // a sell closes a long, a buy closes a short
    const side = f.side === "A" ? "long" : "short";
    const last = out.find((l) => l.coin === f.coin && l.side === side && t - l.ms <= 60_000);
    if (last) {
      last.valueUsd += px * sz;
      last.size += sz;
      last.px = last.valueUsd / last.size;
    } else {
      out.push({ account: me, coin: String(f.coin), ms: t, side, px, size: sz, valueUsd: px * sz, markPx: num(f.liquidation?.markPx), method: f.liquidation?.method ? String(f.liquidation.method) : null });
    }
  }
  return out;
}

/** Spaces requests out so the request weight per minute stays under a limit. */
export class Pacer {
  private next = 0;
  constructor(
    private readonly perMinute = WEIGHT_PER_MINUTE,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  async take(weight: number): Promise<void> {
    const t = this.now();
    const at = Math.max(t, this.next);
    this.next = at + (weight * 60_000) / this.perMinute;
    if (at > t) await this.sleep(at - t);
  }
}

async function* textChunks(res: Response): AsyncIterable<string> {
  if (!res.body) return;
  const decoder = new TextDecoder();
  for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) yield decoder.decode(part, { stream: true });
}

export interface RoundResult {
  ms: number;
  accounts: number;
  levels: number;
  stops: number;
  errors: number;
  skipped?: "disk_full";
}

export interface CollectorOptions {
  fetch?: typeof fetch;
  leaderboardUrl?: string;
  now?: () => number;
  pacer?: Pacer;
  /** Free bytes on the disk that holds the store. */
  freeBytes?: () => number;
  topAccounts?: number;
  scanPerRound?: number;
  accountsPerRound?: number;
  stopAccounts?: number;
  minUsd?: number;
  fillsPerRound?: number;
  replayCandlesPerRound?: number;
}

export class HuntCollector {
  private leaders: string[] = [];
  private leadersAt = 0;
  private cursor = 0;
  private stopCursor = 0;
  private readonly now: () => number;
  private readonly pacer: Pacer;

  constructor(
    private readonly db: HuntDb,
    private readonly hl: Hyperliquid,
    private readonly opts: CollectorOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.pacer = opts.pacer ?? new Pacer();
  }

  private async readLeaders(): Promise<string[]> {
    if (this.leaders.length > 0 && this.now() - this.leadersAt < LEADERS_EVERY_MS) return this.leaders;
    const f = this.opts.fetch ?? fetch;
    const res = await f(this.opts.leaderboardUrl ?? LEADERBOARD_URL);
    if (!res.ok) throw new Error(`leaderboard answered HTTP ${res.status}`);
    const found = await topAccounts(textChunks(res), this.opts.topAccounts ?? TOP_ACCOUNTS);
    if (found.length === 0) throw new Error("leaderboard had no accounts");
    this.leaders = found;
    this.leadersAt = this.now();
    this.cursor = 0;
    return found;
  }

  /** The accounts read this round: every account that held a large position lately, plus the next slice of the leaderboard. */
  private async roundAccounts(ms: number): Promise<string[]> {
    const held = (this.db.prepare("SELECT address FROM accounts WHERE held_ms >= ?").all(ms - IDLE_AFTER_MS) as { address: string }[]).map((r) => r.address);
    let slice: string[] = [];
    try {
      const leaders = await this.readLeaders();
      const want = Math.max(this.opts.scanPerRound ?? SCAN_PER_ROUND, (this.opts.accountsPerRound ?? ACCOUNTS_PER_ROUND) - held.length);
      const n = Math.min(want, leaders.length);
      for (let i = 0; i < n; i++) slice.push(leaders[(this.cursor + i) % leaders.length]);
      this.cursor = (this.cursor + n) % leaders.length;
    } catch {
      // without the leaderboard the round still reads the accounts it already knows
      slice = [];
    }
    return [...new Set([...held, ...slice])];
  }

  /** One round: read the accounts, store their levels and stops, then the candles since the last round. */
  async round(): Promise<RoundResult> {
    const ms = this.now();
    const free = this.opts.freeBytes?.();
    if (free !== undefined && free < MIN_FREE_BYTES) return { ms, accounts: 0, levels: 0, stops: 0, errors: 0, skipped: "disk_full" };
    const minUsd = this.opts.minUsd ?? MIN_POSITION_USD;
    const accounts = await this.roundAccounts(ms);
    const levels: Level[] = [];
    let errors = 0;
    const seen = this.db.prepare(
      "INSERT INTO accounts (address, first_ms, read_ms, held_ms) VALUES (?, ?, ?, ?) ON CONFLICT(address) DO UPDATE SET read_ms = excluded.read_ms, held_ms = max(held_ms, excluded.held_ms)",
    );
    for (const account of accounts) {
      try {
        await this.pacer.take(2);
        const found = levelsOf(account, await this.hl.info({ type: "clearinghouseState", user: account }), minUsd);
        levels.push(...found);
        seen.run(account, ms, ms, found.length > 0 ? ms : 0);
      } catch {
        errors++;
      }
    }
    const stops: Stop[] = [];
    // most of the largest accounts rest no stops, so the stop reads move through every holder in turn
    const holders = biggestAccounts(levels);
    const turn = Math.min(this.opts.stopAccounts ?? STOP_ACCOUNTS, holders.length);
    const start = holders.length > 0 ? this.stopCursor % holders.length : 0;
    this.stopCursor = start + turn;
    for (const account of Array.from({ length: turn }, (_, i) => holders[(start + i) % holders.length])) {
      try {
        await this.pacer.take(20);
        stops.push(...stopsOf(account, await this.hl.info({ type: "frontendOpenOrders", user: account }), levels));
      } catch {
        errors++;
      }
    }
    const putLevel = this.db.prepare(
      "INSERT OR REPLACE INTO levels (ms, account, coin, side, szi, value_usd, entry_px, mark_px, liq_px, leverage, cross_margin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const putStop = this.db.prepare("INSERT OR REPLACE INTO stops (ms, account, coin, side, kind, trigger_px, size, oid) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    this.db.transaction(() => {
      for (const l of levels) putLevel.run(ms, l.account, l.coin, l.side, l.szi, l.valueUsd, l.entryPx, l.markPx, l.liqPx, l.leverage, l.cross ? 1 : 0);
      for (const s of stops) putStop.run(ms, s.account, s.coin, s.side, s.kind, s.triggerPx, s.size, s.oid);
    })();
    errors += await this.candles(candleCoins(levels), ms);
    errors += await this.liquidationScan(ms);
    this.db
      .prepare("INSERT OR REPLACE INTO rounds (ms, accounts, levels, stops, errors, took_ms) VALUES (?, ?, ?, ?, ?, ?)")
      .run(ms, accounts.length, levels.length, stops.length, errors, this.now() - ms);
    return { ms, accounts: accounts.length, levels: levels.length, stops: stops.length, errors };
  }

  /**
   * Read the fill history of the next few known accounts for liquidations, then give the
   * largest liquidations without candles their five-minute candles. Returns how many reads failed.
   */
  private async liquidationScan(ms: number): Promise<number> {
    let errors = 0;
    const since = ms - REPLAY_DAYS * 24 * 60 * 60_000;
    const next = this.db
      .prepare(
        `SELECT a.address AS account, f.read_ms AS read FROM accounts a LEFT JOIN fills_read f ON f.account = a.address
         ORDER BY COALESCE(f.read_ms, 0), a.first_ms LIMIT ?`,
      )
      .all(this.opts.fillsPerRound ?? FILLS_PER_ROUND) as { account: string; read: number | null }[];
    const put = this.db.prepare(
      "INSERT OR REPLACE INTO liquidations (account, coin, ms, side, px, size, value_usd, mark_px, method) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const read = this.db.prepare("INSERT INTO fills_read (account, read_ms) VALUES (?, ?) ON CONFLICT(account) DO UPDATE SET read_ms = excluded.read_ms");
    for (const { account, read: last } of next) {
      try {
        await this.pacer.take(40);
        // a little overlap, so a liquidation in the last minute before a read is not missed
        const startTime = Math.max(since, (last ?? 0) - 60_000);
        const fills = await this.hl.info({ type: "userFillsByTime", user: account, startTime, endTime: ms });
        const found = liquidationsOf(account, fills);
        this.db.transaction(() => {
          for (const l of found) put.run(l.account, l.coin, l.ms, l.side, l.px, l.size, l.valueUsd, l.markPx, l.method);
          read.run(account, ms);
        })();
      } catch {
        errors++;
      }
    }
    const want = this.db
      .prepare(
        `SELECT l.coin, l.ms FROM liquidations l
         WHERE l.ms >= ? AND l.value_usd >= ? AND l.ms <= ?
           AND NOT EXISTS (SELECT 1 FROM replay_candles k WHERE k.coin = l.coin AND k.t BETWEEN l.ms - ? AND l.ms + ?)
         ORDER BY l.value_usd DESC LIMIT ?`,
      )
      .all(since, REPLAY_MIN_USD, ms - REPLAY_WINDOW_MS, REPLAY_WINDOW_MS, REPLAY_WINDOW_MS, this.opts.replayCandlesPerRound ?? REPLAY_CANDLES_PER_ROUND) as { coin: string; ms: number }[];
    const putCandle = this.db.prepare("INSERT OR REPLACE INTO replay_candles (coin, t, o, h, l, c) VALUES (?, ?, ?, ?, ?, ?)");
    for (const w of want) {
      try {
        await this.pacer.take(20);
        const rows = await this.hl.info({ type: "candleSnapshot", req: { coin: w.coin, interval: "5m", startTime: w.ms - REPLAY_WINDOW_MS, endTime: w.ms + REPLAY_WINDOW_MS } });
        this.db.transaction(() => {
          for (const r of Array.isArray(rows) ? rows : []) {
            const [t, o, h, l, c] = [num(r?.t), num(r?.o), num(r?.h), num(r?.l), num(r?.c)];
            if (t === null || o === null || h === null || l === null || c === null) continue;
            putCandle.run(w.coin, t, o, h, l, c);
          }
        })();
      } catch {
        errors++;
      }
    }
    return errors;
  }

  /** Store the one-minute candles of each coin since the last one stored. Returns how many coins failed. */
  private async candles(coins: string[], ms: number): Promise<number> {
    let errors = 0;
    const last = this.db.prepare("SELECT max(t) AS t FROM candles WHERE coin = ?");
    const put = this.db.prepare("INSERT OR REPLACE INTO candles (coin, t, o, h, l, c) VALUES (?, ?, ?, ?, ?, ?)");
    for (const coin of coins) {
      try {
        const from = (last.get(coin) as { t: number | null }).t;
        // a coin seen for the first time starts with the last hour; the newest stored candle is read again because it may not have been closed
        const startTime = from ?? ms - 60 * 60_000;
        const minutes = Math.ceil((ms - startTime) / 60_000);
        await this.pacer.take(20 + Math.floor(minutes / 60));
        const rows = await this.hl.info({ type: "candleSnapshot", req: { coin, interval: "1m", startTime, endTime: ms } });
        this.db.transaction(() => {
          for (const r of Array.isArray(rows) ? rows : []) {
            const [t, o, h, l, c] = [num(r?.t), num(r?.o), num(r?.h), num(r?.l), num(r?.c)];
            if (t === null || o === null || h === null || l === null || c === null) continue;
            put.run(coin, t, o, h, l, c);
          }
        })();
      } catch {
        errors++;
      }
    }
    return errors;
  }
}

/** Free bytes on the disk that holds this file. */
export function freeBytesAt(path: string): number {
  const s = statfsSync(dirname(path));
  return Number(s.bavail) * Number(s.bsize);
}
