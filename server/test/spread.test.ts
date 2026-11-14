import { describe, expect, it } from "vitest";
import { CLOSE_SPLIT_MIN_GAP_MS, CLOSE_SPLIT_MS, CLOSE_SPREAD_MS, closeOffsets, reuseOrder } from "../src/positions.js";

const hex = (b: number) => b.toString(16).padStart(2, "0").repeat(32);

describe("close times", () => {
  it("a one-piece position closes inside 0-90 s", () => {
    for (let b = 0; b < 64; b++) {
      const [o] = closeOffsets(hex(b), 1);
      expect(o).toBeGreaterThanOrEqual(0);
      expect(o).toBeLessThanOrEqual(CLOSE_SPREAD_MS);
    }
  });

  it("split pieces close over 2-20 minutes, each at its own time", () => {
    for (let b = 0; b < 64; b++) {
      for (const n of [2, 3, 6, 12]) {
        const o = closeOffsets(hex(b), n);
        expect(o).toHaveLength(n);
        for (const x of o) {
          expect(x).toBeGreaterThanOrEqual(CLOSE_SPLIT_MS[0]);
          expect(x).toBeLessThanOrEqual(CLOSE_SPLIT_MS[1]);
        }
        const sorted = [...o].sort((a, c) => a - c);
        for (let i = 1; i < n; i++) expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(CLOSE_SPLIT_MIN_GAP_MS);
      }
    }
  });

  it("two pieces never close in the same minute", () => {
    for (let b = 0; b < 256; b++) {
      const [a, c] = closeOffsets(hex(b), 2);
      expect(Math.abs(a - c)).toBeGreaterThanOrEqual(CLOSE_SPLIT_MIN_GAP_MS);
    }
  });

  it("the same draw gives the same times", () => {
    expect(closeOffsets(hex(7), 4)).toEqual(closeOffsets(hex(7), 4));
  });
});

describe("which free pieces a split position reuses", () => {
  const free = ["piece:0", "piece:1", "piece:2", "piece:3", "piece:4"];

  it("keeps every piece once", () => {
    for (let b = 0; b < 32; b++) expect([...reuseOrder(free, hex(b))].sort()).toEqual(free);
  });

  it("does not always pair the oldest pieces", () => {
    const firstTwo = new Set<string>();
    for (let b = 0; b < 32; b++) firstTwo.add(reuseOrder(free, hex(b)).slice(0, 2).sort().join(","));
    expect(firstTwo.size).toBeGreaterThan(3);
  });

  it("is repeatable from the draw and leaves the input alone", () => {
    const copy = [...free];
    expect(reuseOrder(free, hex(9))).toEqual(reuseOrder(free, hex(9)));
    expect(free).toEqual(copy);
  });
});
