import { describe, expect, it } from "vitest";
import { ownLevel, sideWord, totals, verdict } from "../lib/hunter";
import type { HunterView, Position, PublicAccount } from "../lib/types";

const account = (over: Partial<PublicAccount> = {}): PublicAccount => ({
  address: "0x" + "a1".repeat(20),
  side: "long",
  size: 0.05,
  valueUsd: 150,
  entryPx: 3000,
  liqPx: 2500,
  leverage: 3,
  restingOrders: 0,
  triggerPxs: [],
  ...over,
});
const view = (accounts: PublicAccount[]): HunterView => ({ asOfMs: 1, coin: "ETH", markPx: 3300, accounts });
const position = (pieces: { shard: string; hasStop: boolean; hasTp: boolean }[]): Position =>
  ({ id: "p", coin: "ETH", side: "long", notionalUsd: 300, leverage: 3, hiding: "whale", state: "open", createdMs: 1, alerts: [], pieces }) as unknown as Position;

describe("Hunter's View words", () => {
  it("says what Hyperliquid shows when nothing rests on the book", () => {
    const v = view([account(), account({ address: "0x" + "b2".repeat(20), valueUsd: 90 })]);
    expect(totals(v)).toEqual({ holding: 2, resting: 0, triggerPxs: [], largestUsd: 150 });
    expect(verdict(v)).toBe("Hyperliquid shows 2 separate accounts and no stop or take-profit on the book.");
    expect(verdict(view([account()]))).toBe("Hyperliquid shows one account and no stop or take-profit on the book.");
  });

  it("never hides an order that is on the book", () => {
    const one = view([account({ restingOrders: 1, triggerPxs: [2700] }), account()]);
    expect(totals(one).triggerPxs).toEqual([2700]);
    expect(verdict(one)).toBe("Hyperliquid shows 2 separate accounts, and 1 order rests on the book where anyone can read it.");
    const three = view([account({ restingOrders: 2 }), account({ restingOrders: 1 })]);
    expect(verdict(three)).toBe("Hyperliquid shows 2 separate accounts, and 3 orders rest on the book where anyone can read them.");
  });

  it("counts only accounts that hold something", () => {
    const v = view([account(), account({ side: null, size: null, valueUsd: null })]);
    expect(totals(v).holding).toBe(1);
    expect(sideWord(v.accounts[1])).toBe("Nothing held");
    expect(sideWord(account({ side: "short" }))).toBe("Short");
  });

  it("shows the owner's level from this browser, or that one is set elsewhere", () => {
    const p = position([
      { shard: "s0", hasStop: true, hasTp: false },
      { shard: "s1", hasStop: true, hasTp: false },
    ]);
    expect(ownLevel(p, { s1: { stop: 3100 } }, "stop")).toBe(3100);
    expect(ownLevel(p, {}, "stop")).toBe("set");
    expect(ownLevel(p, { s0: { stop: 3100 } }, "tp")).toBe("none");
  });
});
