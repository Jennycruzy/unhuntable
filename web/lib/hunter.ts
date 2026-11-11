// Words and sums for Hunter's View: one position, as its owner sees it and as Hyperliquid
// shows it to everyone else.
import type { HunterView, Position, PublicAccount } from "./types";

export interface Totals {
  /** Accounts that hold something in this market. */
  holding: number;
  /** Orders resting on the book across the accounts. */
  resting: number;
  /** Stop and take-profit prices anyone can read off the book. */
  triggerPxs: number[];
  largestUsd: number;
}

export function totals(v: HunterView): Totals {
  const holding = v.accounts.filter((a) => a.side !== null);
  return {
    holding: holding.length,
    resting: v.accounts.reduce((n, a) => n + a.restingOrders, 0),
    triggerPxs: v.accounts.flatMap((a) => a.triggerPxs),
    largestUsd: holding.reduce((m, a) => Math.max(m, a.valueUsd ?? 0), 0),
  };
}

/** The one sentence under the public side, said only from what Hyperliquid answered. */
export function verdict(v: HunterView): string {
  const t = totals(v);
  const n = v.accounts.length;
  const accounts = n === 1 ? "one account" : `${n} separate accounts`;
  if (t.resting === 0) return `Hyperliquid shows ${accounts} and no stop or take-profit on the book.`;
  const orders = t.resting === 1 ? "1 order rests" : `${t.resting} orders rest`;
  return `Hyperliquid shows ${accounts}, and ${orders} on the book where anyone can read ${t.resting === 1 ? "it" : "them"}.`;
}

/** The level the owner set in this browser, the word "set" when it was set elsewhere, or "none". */
export function ownLevel(p: Position, levels: Record<string, { stop?: number; tp?: number } | undefined>, which: "stop" | "tp"): number | "set" | "none" {
  const has = p.pieces.some((x) => (which === "stop" ? x.hasStop : x.hasTp));
  if (!has) return "none";
  for (const x of p.pieces) {
    const v = levels[x.shard]?.[which];
    if (v !== undefined) return v;
  }
  return "set";
}

export function sideWord(a: Pick<PublicAccount, "side">): string {
  return a.side === "long" ? "Long" : a.side === "short" ? "Short" : "Nothing held";
}
