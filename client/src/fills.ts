// How much a split entry saved against taking the whole size from the book at once.
// Pure: it reads a Hyperliquid l2Book reply and a list of fills, nothing else.

export interface BookLevel {
  px: string;
  sz: string;
  n: number;
}

/** Hyperliquid l2Book reply: levels[0] are bids, levels[1] are asks, best price first. */
export interface L2Book {
  coin: string;
  time: number;
  levels: [BookLevel[], BookLevel[]];
}

export interface Fill {
  px: number;
  sz: number;
}

export type FillSide = "buy" | "sell";

export interface FillSavings {
  benchmarkAvgPx: number;
  ourAvgPx: number;
  savedUsd: number;
  savedBps: number;
}

export interface FillSavingsError {
  code: "book_too_thin";
}

const EPS = 1e-12;

function positive(name: string, x: number): number {
  if (typeof x !== "number" || !Number.isFinite(x) || !(x > 0)) throw new TypeError(`${name} must be a positive number`);
  return x;
}

/** Size-weighted average price of taking size from the book on the given side. */
export function bookAvgPx(book: L2Book, side: FillSide, size: number): number | FillSavingsError {
  if (side !== "buy" && side !== "sell") throw new TypeError("side must be buy or sell");
  const levels = book?.levels?.[side === "buy" ? 1 : 0];
  if (!Array.isArray(levels)) throw new TypeError("book has no levels");
  let left = size;
  let cost = 0;
  for (const l of levels) {
    if (left <= EPS * size) break;
    const px = positive("book price", Number(l.px));
    const take = Math.min(left, positive("book size", Number(l.sz)));
    cost += take * px;
    left -= take;
  }
  if (left > EPS * size) return { code: "book_too_thin" };
  return cost / size;
}

/**
 * Compare our fills with walking the book for the full size in one go.
 * A positive savedUsd means our fills were better.
 */
export function fillSavings(book: L2Book, side: FillSide, totalSize: number, fills: Fill[]): FillSavings | FillSavingsError {
  positive("total size", totalSize);
  if (!Array.isArray(fills) || fills.length === 0) throw new TypeError("fills are required");
  let sz = 0;
  let cost = 0;
  for (const f of fills) {
    const s = positive("fill size", f.sz);
    sz += s;
    cost += positive("fill price", f.px) * s;
  }
  const benchmarkAvgPx = bookAvgPx(book, side, totalSize);
  if (typeof benchmarkAvgPx !== "number") return benchmarkAvgPx;
  const ourAvgPx = cost / sz;
  const savedUsd = (side === "buy" ? benchmarkAvgPx - ourAvgPx : ourAvgPx - benchmarkAvgPx) * totalSize;
  const savedBps = (savedUsd / (benchmarkAvgPx * totalSize)) * 10_000;
  return { benchmarkAvgPx, ourAvgPx, savedUsd, savedBps };
}
