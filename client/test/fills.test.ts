import { describe, expect, it } from "vitest";
import { bookAvgPx, fillSavings, type L2Book } from "../src/fills.js";

const book: L2Book = {
  coin: "ETH",
  time: 1,
  levels: [
    [
      { px: "99", sz: "1", n: 1 },
      { px: "98", sz: "3", n: 2 },
      { px: "97", sz: "1", n: 1 },
    ],
    [
      { px: "100", sz: "1", n: 1 },
      { px: "101", sz: "2", n: 3 },
      { px: "102", sz: "5", n: 1 },
    ],
  ],
};

describe("fill_savings_math", () => {
  it("buy walks the asks", () => {
    // book for 2: 1 @ 100 + 1 @ 101 = 100.5; ours: 1 @ 100.2 + 1 @ 100.4 = 100.3
    const r = fillSavings(book, "buy", 2, [{ px: 100.2, sz: 1 }, { px: 100.4, sz: 1 }]);
    if ("code" in r) throw new Error(r.code);
    expect(r.benchmarkAvgPx).toBeCloseTo(100.5, 12);
    expect(r.ourAvgPx).toBeCloseTo(100.3, 12);
    expect(r.savedUsd).toBeCloseTo(0.4, 12); // (100.5 - 100.3) * 2
    expect(r.savedBps).toBeCloseTo((0.4 / 201) * 10_000, 9); // 19.90 bps
  });

  it("sell walks the bids", () => {
    // book for 3: 1 @ 99 + 2 @ 98 = 295 / 3; ours: 3 @ 99
    const r = fillSavings(book, "sell", 3, [{ px: 99, sz: 3 }]);
    if ("code" in r) throw new Error(r.code);
    expect(r.benchmarkAvgPx).toBeCloseTo(295 / 3, 12);
    expect(r.ourAvgPx).toBe(99);
    expect(r.savedUsd).toBeCloseTo(2, 12); // (99 - 98.333) * 3
    expect(r.savedBps).toBeCloseTo((2 / 295) * 10_000, 9); // 67.80 bps
  });

  it("worse fills give negative savings", () => {
    const r = fillSavings(book, "buy", 1, [{ px: 100.5, sz: 1 }]);
    if ("code" in r) throw new Error(r.code);
    expect(r.savedUsd).toBeCloseTo(-0.5, 12);
    expect(r.savedBps).toBeCloseTo(-50, 9);
  });

  it("takes partial levels and the whole book", () => {
    expect(bookAvgPx(book, "buy", 0.5)).toBe(100);
    expect(bookAvgPx(book, "buy", 8)).toBeCloseTo((100 + 202 + 510) / 8, 12);
    expect(bookAvgPx(book, "sell", 5)).toBeCloseTo((99 + 294 + 97) / 5, 12);
  });

  it("book_too_thin", () => {
    expect(fillSavings(book, "buy", 8.01, [{ px: 100, sz: 8.01 }])).toEqual({ code: "book_too_thin" });
    expect(fillSavings(book, "sell", 6, [{ px: 99, sz: 6 }])).toEqual({ code: "book_too_thin" });
    const empty: L2Book = { coin: "ETH", time: 1, levels: [[], []] };
    expect(fillSavings(empty, "buy", 1, [{ px: 1, sz: 1 }])).toEqual({ code: "book_too_thin" });
  });

  it("refuses bad arguments", () => {
    expect(() => fillSavings(book, "buy", 0, [{ px: 1, sz: 1 }])).toThrow(TypeError);
    expect(() => fillSavings(book, "buy", 1, [])).toThrow(TypeError);
    expect(() => fillSavings(book, "buy", 1, [{ px: -1, sz: 1 }])).toThrow(TypeError);
    expect(() => fillSavings(book, "hold" as any, 1, [{ px: 1, sz: 1 }])).toThrow(TypeError);
  });
});
