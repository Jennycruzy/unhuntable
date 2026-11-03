import { createHash } from "node:crypto";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  LADDER,
  fundingNeed,
  isPlanError,
  maintenanceRatio,
  pieceEquity,
  plan,
  type Piece,
  type Plan,
  type PlanError,
  type PlanInput,
} from "../src/planner.js";
import { VrfStream, sha256 } from "../src/vrf.js";

const VRF_A = new Uint8Array(32).fill(0x11);
const VRF_B = new Uint8Array(32).fill(0x22);

const eth = (over: Partial<PlanInput> = {}): PlanInput => ({
  coin: "ETH",
  side: "long",
  notionalUsd: 600,
  leverage: 5,
  hiding: "whale",
  markPx: 2300,
  szDecimals: 4,
  maxLeverage: 25,
  ...over,
});

function ok(r: Plan | PlanError): Plan {
  if (isPlanError(r)) throw new Error(`unexpected ${r.code}: ${r.message}`);
  return r;
}

function err(r: Plan | PlanError): PlanError {
  if (!isPlanError(r)) throw new Error("expected a refusal");
  return r;
}

describe("vrf stream", () => {
  it("sha256 matches node:crypto", () => {
    for (const len of [0, 1, 3, 55, 56, 63, 64, 65, 200]) {
      const b = new Uint8Array(len).map((_, i) => (i * 7 + 3) & 0xff);
      expect(Buffer.from(sha256(b)).toString("hex")).toBe(createHash("sha256").update(b).digest("hex"));
    }
  });

  it("reads big-endian u32 from the bytes, then from sha256(vrf ‖ counter)", () => {
    const vrf = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x80, 0x00, 0x00, 0x00, 0xaa, 0xbb]);
    const s = new VrfStream(vrf);
    expect(s.u32()).toBe(1);
    expect(s.uniform()).toBe(0.5);
    const h0 = createHash("sha256").update(Buffer.concat([vrf, Buffer.from([0, 0, 0, 0])])).digest();
    const h1 = createHash("sha256").update(Buffer.concat([vrf, Buffer.from([0, 0, 0, 1])])).digest();
    const tail = Buffer.concat([Buffer.from([0xaa, 0xbb]), h0, h1]);
    for (let i = 0; i < 16; i++) expect(s.u32()).toBe(tail.readUInt32BE(i * 4));
  });
});

describe("plan_deterministic_for_vrf", () => {
  it("same input and bytes give deep-equal plans", () => {
    for (const input of [eth(), eth({ hiding: "normal" }), eth({ coin: "BTC", markPx: 104000, szDecimals: 5, maxLeverage: 40, notionalUsd: 5000 })]) {
      expect(plan(input, VRF_A)).toEqual(plan(input, Uint8Array.from(VRF_A)));
    }
  });

  it("different bytes give different offsets", () => {
    const a = ok(plan(eth(), VRF_A));
    const b = ok(plan(eth(), VRF_B));
    expect(a.pieces.map((p) => p.entryOffsetMs)).not.toEqual(b.pieces.map((p) => p.entryOffsetMs));
    const na = ok(plan(eth({ hiding: "normal" }), VRF_A));
    const nb = ok(plan(eth({ hiding: "normal" }), VRF_B));
    expect(na.pieces[0].entryOffsetMs).not.toBe(nb.pieces[0].entryOffsetMs);
  });

  it("does not change the input or the bytes", () => {
    const input = eth();
    const copy = { ...input };
    const vrf = Uint8Array.from(VRF_A);
    plan(input, vrf);
    expect(input).toEqual(copy);
    expect(vrf).toEqual(VRF_A);
  });
});

describe("plan shape", () => {
  it("normal is one piece entering within 90 s", () => {
    const p = ok(plan(eth({ hiding: "normal" }), VRF_A));
    expect(p.pieces).toHaveLength(1);
    expect(p.pieces[0].size).toBe(p.totalSize);
    expect(p.pieces[0].entryOffsetMs).toBeGreaterThanOrEqual(0);
    expect(p.pieces[0].entryOffsetMs).toBeLessThanOrEqual(90_000);
  });

  it("whale picks clamp(ceil(notional / 50), 2, 12) pieces when they are big enough", () => {
    expect(ok(plan(eth({ notionalUsd: 600 }), VRF_A)).pieces).toHaveLength(12);
    expect(ok(plan(eth({ notionalUsd: 260 }), VRF_A)).pieces).toHaveLength(6);
    expect(ok(plan(eth({ notionalUsd: 60 }), VRF_A)).pieces).toHaveLength(2);
    expect(ok(plan(eth({ notionalUsd: 20_000, leverage: 10 }), VRF_A)).pieces).toHaveLength(12);
  });

  it("small whale positions use 2 pieces of at least $12", () => {
    const p = ok(plan(eth({ notionalUsd: 30 }), VRF_A));
    expect(p.pieces).toHaveLength(2);
    for (const x of p.pieces) expect(x.notionalUsd).toBeGreaterThanOrEqual(12);
  });

  it("totals and fees add up", () => {
    const p = ok(plan(eth(), VRF_A));
    expect(p.vrfHex).toBe("11".repeat(32));
    expect(p.totalFundingUsd).toBe(p.pieces.reduce((a, x) => a + x.fundingUsd, 0));
    const fees = p.pieces.reduce((a, x) => a + 0.00045 * x.notionalUsd * 2 + 0.33, 0);
    expect(p.estFeesUsd).toBeCloseTo(fees, 9);
    p.pieces.forEach((x, i) => {
      expect(x.index).toBe(i);
      expect(x.notionalUsd).toBeCloseTo(x.size * 2300, 9);
      expect(x.reserveUsd).toBeCloseTo(pieceEquity(x.notionalUsd, 5, 25) - x.notionalUsd / 5, 9);
      expect(x.reserveUsd).toBeGreaterThanOrEqual(0);
    });
  });
});

describe("plan_amounts_from_ladder", () => {
  it("every fundingUsd is a ladder value covering equity, fees and the route fee", () => {
    for (const [notionalUsd, leverage] of [[600, 5], [12_000, 10], [9_000, 1], [40, 2], [3_000, 3]]) {
      const p = ok(plan(eth({ notionalUsd, leverage }), VRF_B));
      for (const x of p.pieces) {
        expect(LADDER).toContain(x.fundingUsd);
        const e = pieceEquity(x.notionalUsd, leverage, 25);
        expect(x.fundingUsd).toBeGreaterThanOrEqual(e + 0.002 * x.notionalUsd + 0.33);
        // smallest such rung
        const lower = LADDER.filter((l) => l < x.fundingUsd);
        if (lower.length) expect(lower[lower.length - 1]).toBeLessThan(fundingNeed(x.notionalUsd, leverage, 25));
      }
    }
  });
});

describe("plan_sizes_sum_exactly", () => {
  it("sizes add up to totalSize in whole size units", () => {
    for (const input of [
      eth(),
      eth({ notionalUsd: 777.77 }),
      eth({ coin: "BTC", markPx: 104321.5, szDecimals: 5, maxLeverage: 40, notionalUsd: 4321 }),
      eth({ coin: "SOL", markPx: 151.37, szDecimals: 2, maxLeverage: 20, notionalUsd: 999 }),
    ]) {
      const p = ok(plan(input, VRF_A));
      const scale = 10 ** input.szDecimals;
      const units = p.pieces.map((x) => Math.round(x.size * scale));
      units.forEach((u, i) => expect(u / scale).toBe(p.pieces[i].size));
      expect(units.reduce((a, b) => a + b, 0)).toBe(Math.round(p.totalSize * scale));
      expect(Math.round(p.totalSize * scale)).toBe(Math.floor((input.notionalUsd / input.markPx) * scale));
    }
  });
});

describe("plan_whale_offsets_spaced", () => {
  it("offsets sit in [120 s, 1200 s] at least 20 s apart", () => {
    for (let k = 0; k < 50; k++) {
      const vrf = new Uint8Array(32).map((_, i) => (i * 31 + k * 17) & 0xff);
      const p = ok(plan(eth({ notionalUsd: 2000 }), vrf));
      const o = p.pieces.map((x) => x.entryOffsetMs).sort((a, b) => a - b);
      expect(o).toHaveLength(12);
      expect(o[0]).toBeGreaterThanOrEqual(120_000);
      expect(o[o.length - 1]).toBeLessThanOrEqual(1_200_000);
      for (let i = 1; i < o.length; i++) expect(o[i] - o[i - 1]).toBeGreaterThanOrEqual(20_000);
    }
  });
});

describe("liquidation_distance_at_least_18pct", () => {
  it("each piece keeps liquidation at least 18% away at open", () => {
    for (const [leverage, maxLeverage] of [[1, 25], [5, 25], [10, 25], [10, 40], [10, 20], [3, 3]]) {
      const p = ok(plan(eth({ leverage, maxLeverage, notionalUsd: 3000 }), VRF_A));
      const mmr = maintenanceRatio(maxLeverage);
      for (const x of p.pieces) {
        const e = x.notionalUsd / leverage + x.reserveUsd;
        expect((e - mmr * x.notionalUsd) / x.notionalUsd).toBeGreaterThanOrEqual(0.18 - 1e-9);
      }
    }
  });
});

describe("plan_refusals", () => {
  const MIN = "Each piece must be at least $12. Add size or use fewer pieces.";
  const CAP = "That position is bigger than the safety cap. Lower the size.";

  it("shard_min_notional", () => {
    expect(err(plan(eth({ hiding: "normal", notionalUsd: 11 }), VRF_A))).toEqual({ code: "shard_min_notional", message: MIN });
    expect(err(plan(eth({ notionalUsd: 23.99 }), VRF_A))).toEqual({ code: "shard_min_notional", message: MIN });
    // $12.01 rounds down to under $12 of ETH at 4 decimals
    expect(err(plan(eth({ hiding: "normal", notionalUsd: 12.01 }), VRF_A)).code).toBe("shard_min_notional");
  });

  it("max_leverage", () => {
    const ten = "The most leverage here is 10x. Lower it and try again.";
    expect(err(plan(eth({ leverage: 11 }), VRF_A))).toEqual({ code: "max_leverage", message: ten });
    expect(err(plan(eth({ leverage: 0 }), VRF_A))).toEqual({ code: "max_leverage", message: ten });
    expect(err(plan(eth({ leverage: 5, maxLeverage: 3 }), VRF_A))).toEqual({
      code: "max_leverage",
      message: "The most leverage here is 3x. Lower it and try again.",
    });
  });

  it("over_cap", () => {
    expect(err(plan(eth({ hiding: "normal", notionalUsd: 2000, leverage: 1 }), VRF_A))).toEqual({ code: "over_cap", message: CAP });
    expect(err(plan(eth({ notionalUsd: 50_000, leverage: 1 }), VRF_A))).toEqual({ code: "over_cap", message: CAP });
  });

  it("bad_input", () => {
    expect(err(plan(eth({ markPx: -1 }), VRF_A))).toEqual({ code: "bad_input", message: "Mark price must be a positive number." });
    const cases: Array<[Partial<PlanInput>, Uint8Array]> = [
      [{ coin: "DOGE" as any }, VRF_A],
      [{ side: "up" as any }, VRF_A],
      [{ hiding: "max" as any }, VRF_A],
      [{ notionalUsd: NaN }, VRF_A],
      [{ szDecimals: 1.5 }, VRF_A],
      [{ maxLeverage: 0 }, VRF_A],
      [{ leverage: 2.5 }, VRF_A],
      [{}, new Uint8Array(0)],
    ];
    for (const [over, vrf] of cases) {
      const e = err(plan(eth(over), vrf));
      expect(e.code).toBe("bad_input");
      expect(e.message).toMatch(/^[A-Z].*\.$/);
    }
  });
});

describe("no_inter_piece_transfer", () => {
  it("plan and piece carry only the listed fields", () => {
    expectTypeOf<keyof Plan>().toEqualTypeOf<
      "coin" | "side" | "leverage" | "totalSize" | "pieces" | "totalFundingUsd" | "estFeesUsd" | "vrfHex"
    >();
    expectTypeOf<keyof Piece>().toEqualTypeOf<"index" | "size" | "notionalUsd" | "fundingUsd" | "entryOffsetMs" | "reserveUsd">();
    const p = ok(plan(eth(), VRF_A));
    expect(Object.keys(p).sort()).toEqual(["coin", "estFeesUsd", "leverage", "pieces", "side", "totalFundingUsd", "totalSize", "vrfHex"]);
    for (const x of p.pieces) {
      expect(Object.keys(x).sort()).toEqual(["entryOffsetMs", "fundingUsd", "index", "notionalUsd", "reserveUsd", "size"]);
    }
  });
});
