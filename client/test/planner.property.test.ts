import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { LADDER, isPlanError, maintenanceRatio, pieceEquity, plan, type PlanInput } from "../src/planner.js";

const COINS = [
  { coin: "BTC", szDecimals: 5, maxLeverage: 40, px: [20_000, 200_000] },
  { coin: "ETH", szDecimals: 4, maxLeverage: 25, px: [500, 10_000] },
  { coin: "SOL", szDecimals: 2, maxLeverage: 20, px: [5, 1_000] },
] as const;

const input = fc
  .record({
    c: fc.constantFrom(...COINS),
    pxU: fc.double({ min: 0, max: 1, noNaN: true }),
    side: fc.constantFrom("long" as const, "short" as const),
    notionalUsd: fc.double({ min: 1, max: 30_000, noNaN: true }),
    leverage: fc.integer({ min: 1, max: 10 }),
    hiding: fc.constantFrom("normal" as const, "whale" as const),
  })
  .map(({ c, pxU, ...rest }): PlanInput => ({
    ...rest,
    coin: c.coin,
    szDecimals: c.szDecimals,
    maxLeverage: c.maxLeverage,
    markPx: c.px[0] + pxU * (c.px[1] - c.px[0]),
  }));

const vrf = fc.uint8Array({ minLength: 1, maxLength: 96 });

describe("plan properties", () => {
  it("plan_respects_min_notional", () => {
    fc.assert(
      fc.property(input, vrf, (inp, bytes) => {
        const r = plan(inp, bytes);
        if (isPlanError(r)) {
          expect(["shard_min_notional", "over_cap"]).toContain(r.code);
          return;
        }
        for (const p of r.pieces) expect(p.notionalUsd).toBeGreaterThanOrEqual(12);
      }),
      { numRuns: 500 },
    );
  });

  it("every plan is exact, funded from the ladder, spaced, safe and repeatable", () => {
    fc.assert(
      fc.property(input, vrf, (inp, bytes) => {
        const r = plan(inp, bytes);
        if (isPlanError(r)) return;
        expect(plan(inp, Uint8Array.from(bytes))).toEqual(r);
        const scale = 10 ** inp.szDecimals;
        const sum = r.pieces.reduce((a, p) => a + Math.round(p.size * scale), 0);
        expect(sum).toBe(Math.round(r.totalSize * scale));
        const mmr = maintenanceRatio(inp.maxLeverage);
        for (const p of r.pieces) {
          expect(LADDER).toContain(p.fundingUsd);
          const e = pieceEquity(p.notionalUsd, inp.leverage, inp.maxLeverage);
          expect(p.fundingUsd).toBeGreaterThanOrEqual(e + 0.002 * p.notionalUsd + 0.33);
          expect((e - mmr * p.notionalUsd) / p.notionalUsd).toBeGreaterThanOrEqual(0.18 - 1e-9);
        }
        const o = r.pieces.map((p) => p.entryOffsetMs).sort((a, b) => a - b);
        if (inp.hiding === "normal") {
          expect(r.pieces).toHaveLength(1);
          expect(o[0]).toBeGreaterThanOrEqual(0);
          expect(o[0]).toBeLessThanOrEqual(90_000);
        } else {
          expect(r.pieces.length).toBeGreaterThanOrEqual(2);
          expect(r.pieces.length).toBeLessThanOrEqual(12);
          expect(o[0]).toBeGreaterThanOrEqual(120_000);
          expect(o[o.length - 1]).toBeLessThanOrEqual(1_200_000);
          for (let i = 1; i < o.length; i++) expect(o[i] - o[i - 1]).toBeGreaterThanOrEqual(20_000);
        }
      }),
      { numRuns: 500 },
    );
  });
});
