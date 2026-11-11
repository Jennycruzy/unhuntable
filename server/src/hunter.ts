// Hunter's View: what anyone can read about a position's pieces on Hyperliquid, with no key
// and no sign-in. Each piece is asked for the way a tracker would ask: its public account
// state and its public list of resting orders. Nothing is worked out or estimated here, so
// the owner sees exactly what a hunter gets.
import { hlAsset } from "unhuntable-client";
import { walletById, type Ctx } from "./ctx.js";
import { ApiError } from "./refusals.js";

/** One read of Hyperliquid serves every poll of the page for this long. */
export const HUNTER_CACHE_MS = 15_000;

export interface PublicAccount {
  address: string;
  /** Null when the account holds nothing in this market. */
  side: "long" | "short" | null;
  size: number | null;
  valueUsd: number | null;
  entryPx: number | null;
  liqPx: number | null;
  leverage: number | null;
  /** Every order of this account resting on the book in this market, stops included. */
  restingOrders: number;
  /** Trigger prices of its resting stop and take-profit orders in this market. */
  triggerPxs: number[];
}

export interface HunterView {
  asOfMs: number;
  coin: string;
  markPx: number | null;
  accounts: PublicAccount[];
}

const num = (v: unknown): number | null => {
  const x = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(x) ? x : null;
};

/** One account as its public page shows it for this market. */
export function publicAccount(address: string, coin: string, state: any, orders: any): PublicAccount {
  const p = (state?.assetPositions ?? []).map((x: any) => x?.position).find((x: any) => x?.coin === coin && num(x?.szi));
  const szi = num(p?.szi);
  const mine = (Array.isArray(orders) ? orders : []).filter((o: any) => o?.coin === coin);
  return {
    address,
    side: szi ? (szi > 0 ? "long" : "short") : null,
    size: szi ? Math.abs(szi) : null,
    valueUsd: szi ? num(p?.positionValue) : null,
    entryPx: szi ? num(p?.entryPx) : null,
    liqPx: szi ? num(p?.liquidationPx) : null,
    leverage: szi ? num(p?.leverage?.value) : null,
    restingOrders: mine.length,
    triggerPxs: mine
      .filter((o: any) => o?.isTrigger)
      .map((o: any) => num(o?.triggerPx))
      .filter((x: number | null): x is number => x !== null && x > 0),
  };
}

const cache = new WeakMap<object, Map<string, { at: number; view: HunterView }>>();

/** The public view of every piece of one of the user's own positions. */
export async function hunterView(ctx: Ctx, userId: string, id: string): Promise<HunterView> {
  const pos = ctx.db.prepare("SELECT id, coin FROM positions WHERE id = ? AND user_id = ?").get(id, userId) as { id: string; coin: string } | undefined;
  if (!pos) throw new ApiError("not_found");
  let mine = cache.get(ctx.db);
  if (!mine) cache.set(ctx.db, (mine = new Map()));
  const kept = mine.get(pos.id);
  if (kept && ctx.now() - kept.at < HUNTER_CACHE_MS) return kept.view;

  const dex = hlAsset(pos.coin)?.dex ?? "";
  const list = dex ? { dex } : {};
  const pieces = ctx.db.prepare("SELECT piece_id FROM position_pieces WHERE position_id = ? ORDER BY idx").all(pos.id) as { piece_id: string }[];
  const addresses = pieces.map((pp) => walletById(ctx, pp.piece_id).hl_address).filter((a): a is string => !!a);
  const accounts = await Promise.all(
    addresses.map(async (user) => {
      const [state, orders] = await Promise.all([
        ctx.hl.info({ type: "clearinghouseState", user, ...list }),
        ctx.hl.info({ type: "frontendOpenOrders", user, ...list }),
      ]);
      return publicAccount(user, pos.coin, state, orders);
    }),
  );
  const mids = await ctx.hl.allMids(dex).catch(() => ({}) as Record<string, number>);
  const view: HunterView = { asOfMs: ctx.now(), coin: pos.coin, markPx: mids[pos.coin] ?? null, accounts };
  mine.set(pos.id, { at: view.asOfMs, view });
  // closed positions are never asked for again; keep the store small
  if (mine.size > 500) for (const k of mine.keys()) if (mine.size > 250) mine.delete(k);
  return view;
}
