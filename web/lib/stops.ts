// Invisible stops: a stop that doesn't exist until it fires. Each level is sealed in this
// browser inside a box only the guard can open, one box per piece. The server forwards the
// boxes and never sees a level; the exchange never sees an order until the guard fires it.
import { sealCall, type RandomSource } from "unhuntable-client/box-browser";
import type { Api } from "./api";
import { DEFAULT_JITTER_BPS } from "./config";
import type { Coin, SealedBox, Side } from "./types";
import { loadRecord, updateRecord } from "./vault";

export interface Levels {
  stop?: number;
  tp?: number;
  /** The guard moves the stored stop by a random amount within this many basis points (1 bp = 0.01%), 0-100. */
  jitterBps?: number;
}

export interface SealTarget {
  coin: Coin;
  side: Side;
  pieces: { shard: string; size: number | string }[];
}

export function checkLevel(name: string, v: number | undefined): void {
  if (v === undefined) return;
  if (!Number.isFinite(v) || v <= 0) throw new Error(`The ${name} price must be a positive number.`);
}

/** One sealed box per piece for each level given. */
export function buildBoxes(boxPub: string, t: SealTarget, levels: Levels, random?: RandomSource): { shard: string; box: SealedBox }[] {
  checkLevel("stop", levels.stop);
  checkLevel("take-profit", levels.tp);
  const jitter = levels.jitterBps ?? DEFAULT_JITTER_BPS;
  if (!Number.isInteger(jitter) || jitter < 0 || jitter > 100) throw new Error("The tolerance must be a whole number of basis points from 0 to 100.");
  const out: { shard: string; box: SealedBox }[] = [];
  for (const p of t.pieces) {
    const size = Number(p.size);
    if (!(size > 0)) throw new Error("A piece has no size yet. Try again when the position is open.");
    if (levels.stop !== undefined) {
      const inner = { op: "seal", shard: p.shard, stop: { coin: t.coin, side: t.side, trigger: levels.stop, size }, jitter_bps: jitter };
      out.push({ shard: p.shard, box: sealCall(boxPub, inner, random).box });
    }
    if (levels.tp !== undefined) {
      const inner = { op: "seal_tp", shard: p.shard, tp: { coin: t.coin, side: t.side, trigger: levels.tp, size } };
      out.push({ shard: p.shard, box: sealCall(boxPub, inner, random).box });
    }
  }
  return out;
}

let boxPubCache: Promise<string> | undefined;

/** The guard's box public key, fetched once per page load. */
export function guardBoxPub(api: Api): Promise<string> {
  if (!boxPubCache) {
    boxPubCache = api.boxPub().then((r) => r.boxPub);
    boxPubCache.catch(() => (boxPubCache = undefined));
  }
  return boxPubCache;
}

export function forgetBoxPub(): void {
  boxPubCache = undefined;
}

/** Seal the levels for every piece of a position and keep them in this browser's record. */
export async function sealLevels(api: Api, account: string, positionId: string, t: SealTarget, levels: Levels, random?: RandomSource): Promise<number> {
  if (levels.stop === undefined && levels.tp === undefined) return 0;
  const boxes = buildBoxes(await guardBoxPub(api), t, levels, random);
  const r = await api.sealStops(positionId, boxes);
  await updateRecord(account, (rec) => {
    const pos = (rec.levels[positionId] ??= {});
    for (const p of t.pieces) {
      const was = pos[p.shard] ?? {};
      pos[p.shard] = {
        ...was,
        ...(levels.stop !== undefined ? { stop: levels.stop, jitterBps: levels.jitterBps ?? DEFAULT_JITTER_BPS } : {}),
        ...(levels.tp !== undefined ? { tp: levels.tp } : {}),
      };
    }
  });
  return r.sealed;
}

export const STOP_COPY = "Your stop is not on the exchange. It lives sealed inside the guard and fires when at least 3 of 7 price sources agree.";
export const STOCK_STOP_COPY =
  "Your stop is not on the exchange. It lives sealed inside the guard and fires when at least 3 prices agree, 2 of them from outside trade.xyz's order book (its oracle, Yahoo, Nasdaq).";

/** What the sealed stop waits for, by market. */
export function stopCopy(coin: string): string {
  return coin.startsWith("xyz:") ? STOCK_STOP_COPY : STOP_COPY;
}

export { hyperliquidPage } from "./links";

/** Keep levels chosen at confirm until the position is open. */
export async function keepUntilOpen(account: string, positionId: string, levels: Levels): Promise<void> {
  if (levels.stop === undefined && levels.tp === undefined) return;
  await updateRecord(account, (r) => {
    r.waitingLevels[positionId] = levels;
  });
}

/** Seal levels kept for positions that are now open. Returns the ids sealed. */
export async function sealOpened(
  api: Api,
  account: string,
  positions: { id: string; state: string; coin: Coin; side: Side; pieces: { shard: string; size: number | string }[] }[],
  random?: RandomSource,
): Promise<string[]> {
  const rec = await loadRecord(account);
  const done: string[] = [];
  for (const p of positions) {
    const levels = rec.waitingLevels[p.id];
    if (!levels) continue;
    if (p.state === "closed" || p.state === "failed") {
      await updateRecord(account, (r) => void delete r.waitingLevels[p.id]);
      continue;
    }
    if (p.state !== "open" || p.pieces.length === 0 || p.pieces.some((x) => !(Number(x.size) > 0))) continue;
    await sealLevels(api, account, p.id, p, levels, random);
    await updateRecord(account, (r) => void delete r.waitingLevels[p.id]);
    done.push(p.id);
  }
  return done;
}

/** Shown when a piece's guard is unreachable and the server sent no sentence of its own (server/src/refusals.ts guard_unreachable). */
export const GUARD_UNREACHABLE =
  "The guard isn't answering. Your positions are open on Hyperliquid; stops can't fire until it's back. You can close now.";
