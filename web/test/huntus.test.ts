import { describe, expect, it } from "vitest";
import { short } from "../lib/huntmap";
import { payerLine, revealHeadline, secondsLeft } from "../lib/huntus";
import type { HuntUsReveal } from "../lib/types";

const piece = (over: Partial<HuntUsReveal["pieces"][number]> = {}): HuntUsReveal["pieces"][number] => ({
  address: "0x" + "a1".repeat(20),
  side: "long",
  size: 0.004,
  valueUsd: 10,
  entryPx: 2500,
  liqPx: 2050,
  leverage: 3,
  restingOrders: 0,
  triggerPxs: [],
  fundedBy: "0x6b9e773128f453f5c2c60935ee2de2cbc5390a24",
  fundedAtMs: 1,
  payerAccounts: 871,
  ...over,
});
const reveal = (over: Partial<HuntUsReveal> = {}): HuntUsReveal => ({ coin: "ETH", asOfMs: 1, pieces: [piece(), piece(), piece()], restingOrders: 0, sendsBetweenPieces: 0, payerWindowHours: 6, ...over });

describe("Hunt us words", () => {
  it("say only what the reveal shows", () => {
    expect(revealHeadline(reveal())).toBe("3 separate accounts. No money ever moved between them, and no stop on the book.");
    expect(revealHeadline(reveal({ restingOrders: 1, sendsBetweenPieces: 2 }))).toBe("3 separate accounts. Money moved between them 2 times, and 1 order on the book.");
    expect(revealHeadline(reveal({ sendsBetweenPieces: 1 }))).toBe("3 separate accounts. Money moved between them once, and no stop on the book.");
  });

  it("name the payer and how widely it pays, or that no funding was found", () => {
    expect(payerLine(piece(), 6, short)).toBe("Funded by 0x6b9e…0a24, which sent money to at least 871 accounts in the last 6 hours");
    expect(payerLine(piece({ payerAccounts: 1 }), 6, short)).toBe("Funded by 0x6b9e…0a24");
    expect(payerLine(piece({ fundedBy: null }), 6, short)).toBe("No funding found");
  });

  it("count the seconds down to zero and stop there", () => {
    expect(secondsLeft(10_000, 0)).toBe(10);
    expect(secondsLeft(10_000, 9_001)).toBe(1);
    expect(secondsLeft(10_000, 12_000)).toBe(0);
  });
});
