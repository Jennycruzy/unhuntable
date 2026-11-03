// Position planner. Turns one position and VRF output bytes into an exact plan:
// how many pieces (separate accounts), each piece's size, how much USDC to fund it
// with, how much of that is reserve, and when it enters. Pure and deterministic:
// the same input and the same bytes always give the same plan, so anyone holding
// the VRF output can check it later. It never touches the network.
import { VrfStream, toHex } from "./vrf.js";

export type PlanCoin = "BTC" | "ETH" | "SOL";
export type PlanSide = "long" | "short";
export type Hiding = "normal" | "whale";

export interface PlanInput {
  coin: PlanCoin;
  side: PlanSide;
  notionalUsd: number;
  /** Whole number 1-10. */
  leverage: number;
  /** normal: one piece. whale: split into 2-12 pieces. */
  hiding: Hiding;
  markPx: number;
  /** Hyperliquid size decimals for the coin (BTC 5, ETH 4, SOL 2). */
  szDecimals: number;
  /** The venue's leverage limit for the coin, passed in by the caller. */
  maxLeverage: number;
}

export interface Piece {
  index: number;
  /** Coin units, rounded down to szDecimals. */
  size: number;
  notionalUsd: number;
  /** USDC sent to the piece's account; always a ladder value. */
  fundingUsd: number;
  entryOffsetMs: number;
  /** Equity kept on top of the opening margin so liquidation stays at least 18% away. */
  reserveUsd: number;
}

export interface Plan {
  coin: PlanCoin;
  side: PlanSide;
  leverage: number;
  totalSize: number;
  pieces: Piece[];
  totalFundingUsd: number;
  estFeesUsd: number;
  vrfHex: string;
}

export type PlanErrorCode = "shard_min_notional" | "max_leverage" | "over_cap" | "bad_input";

export interface PlanError {
  code: PlanErrorCode;
  message: string;
}

/** Funding amounts in USDC. Every piece is funded with exactly one of these. */
export const LADDER: readonly number[] = [12, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200, 300, 500, 750, 1000];
/** Hyperliquid refuses orders under $10, reduce-only closes too; $12 leaves room for price moves. */
export const MIN_PIECE_USD = 12;
export const MAX_PLAN_LEVERAGE = 10;
export const MAX_PIECES = 12;
/** Liquidation must be at least this far from the entry price at open. */
export const MIN_LIQ_DISTANCE = 0.18;
export const TRADING_FEE_RESERVE = 0.002;
export const ROUTE_FEE_USD = 0.33;
export const TAKER_FEE = 0.00045;
export const NORMAL_ENTRY_MS: readonly [number, number] = [0, 90_000];
export const WHALE_ENTRY_MS: readonly [number, number] = [120_000, 1_200_000];
export const WHALE_MIN_GAP_MS = 20_000;
const JITTER = 0.15;

const MSG = {
  minNotional: "Each piece must be at least $12. Add size or use fewer pieces.",
  overCap: "That position is bigger than the safety cap. Lower the size.",
  leverage: (most: number) => `The most leverage here is ${most}x. Lower it and try again.`,
};

export function isPlanError(r: Plan | PlanError): r is PlanError {
  return "code" in r;
}

function fail(code: PlanErrorCode, message: string): PlanError {
  return { code, message };
}

/** Maintenance margin ratio used for the liquidation check: 1 / (2 * maxLeverage). */
export function maintenanceRatio(maxLeverage: number): number {
  return 1 / (2 * maxLeverage);
}

/** Account equity a piece needs: enough for the margin and an 18% liquidation distance. */
export function pieceEquity(notionalUsd: number, leverage: number, maxLeverage: number): number {
  return notionalUsd * Math.max(1 / leverage, MIN_LIQ_DISTANCE + maintenanceRatio(maxLeverage));
}

/** What a piece must be funded with at least: equity, trading fees and the funding route fee. */
export function fundingNeed(notionalUsd: number, leverage: number, maxLeverage: number): number {
  return pieceEquity(notionalUsd, leverage, maxLeverage) + TRADING_FEE_RESERVE * notionalUsd + ROUTE_FEE_USD;
}

/** Smallest ladder value at or above need, or undefined if need is over the top rung. */
export function ladderAmount(need: number): number | undefined {
  return LADDER.find((x) => x >= need);
}

/** floor(x) at a number of decimals, as a whole count of 10^-decimals units. */
function floorUnits(x: number, decimals: number): number {
  // toPrecision trims float noise such as 4.4999999999 so an exact value is not floored away
  return Math.floor(Number((x * 10 ** decimals).toPrecision(15)));
}

function checkInput(input: PlanInput, vrf: Uint8Array): PlanError | undefined {
  const pos = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x > 0;
  if (typeof input !== "object" || input === null) return fail("bad_input", "The plan input is missing.");
  if (!["BTC", "ETH", "SOL"].includes(input.coin)) return fail("bad_input", "Coin must be BTC, ETH or SOL.");
  if (input.side !== "long" && input.side !== "short") return fail("bad_input", "Side must be long or short.");
  if (input.hiding !== "normal" && input.hiding !== "whale") return fail("bad_input", "Hiding must be normal or whale.");
  if (!pos(input.notionalUsd)) return fail("bad_input", "Position size in USD must be a positive number.");
  if (!pos(input.markPx)) return fail("bad_input", "Mark price must be a positive number.");
  if (!Number.isInteger(input.szDecimals) || input.szDecimals < 0 || input.szDecimals > 8) {
    return fail("bad_input", "Size decimals must be a whole number from 0 to 8.");
  }
  if (!pos(input.maxLeverage) || input.maxLeverage < 1) return fail("bad_input", "The venue leverage limit must be at least 1.");
  if (typeof input.leverage !== "number" || !Number.isInteger(input.leverage)) return fail("bad_input", "Leverage must be a whole number.");
  if (!(vrf instanceof Uint8Array) || vrf.length === 0) return fail("bad_input", "VRF output bytes are required.");
  return undefined;
}

/** Split total units into n jittered shares that sum to total exactly. */
function splitUnits(total: number, n: number, s: VrfStream): number[] {
  if (n === 1) return [total];
  const w = Array.from({ length: n }, () => 1 - JITTER + 2 * JITTER * s.uniform());
  const sum = w.reduce((a, b) => a + b, 0);
  const units = w.map((x) => Math.floor((total * x) / sum));
  let largest = 0;
  for (let i = 1; i < n; i++) if (units[i] > units[largest]) largest = i;
  units[largest] += total - units.reduce((a, b) => a + b, 0);
  return units;
}

/**
 * Build the plan for one position. Returns a PlanError with a plain sentence
 * when the position cannot be planned safely.
 */
export function plan(input: PlanInput, vrf: Uint8Array): Plan | PlanError {
  const bad = checkInput(input, vrf);
  if (bad) return bad;
  const { coin, side, notionalUsd, leverage, hiding, markPx, szDecimals, maxLeverage } = input;

  const most = Math.min(MAX_PLAN_LEVERAGE, maxLeverage);
  if (leverage < 1 || leverage > most) return fail("max_leverage", MSG.leverage(most));

  const scale = 10 ** szDecimals;
  const totalUnits = floorUnits(notionalUsd / markPx, szDecimals);
  if (!Number.isSafeInteger(totalUnits)) return fail("over_cap", MSG.overCap);

  const notionalOf = (u: number) => (u / scale) * markPx;
  const minOk = (units: number[]) => units.every((u) => notionalOf(u) >= MIN_PIECE_USD);
  const capOk = (units: number[]) => units.every((u) => ladderAmount(fundingNeed(notionalOf(u), leverage, maxLeverage)) !== undefined);
  // Each candidate piece count reads the VRF stream from the start, so the plan depends only on the count chosen.
  const attempt = (n: number) => {
    const s = new VrfStream(vrf);
    return { n, s, units: splitUnits(totalUnits, n, s) };
  };

  let chosen: ReturnType<typeof attempt> | undefined;
  if (hiding === "normal") {
    chosen = attempt(1);
    if (!minOk(chosen.units)) return fail("shard_min_notional", MSG.minNotional);
    if (!capOk(chosen.units)) return fail("over_cap", MSG.overCap);
  } else {
    if (notionalUsd < 2 * MIN_PIECE_USD) return fail("shard_min_notional", MSG.minNotional);
    const start = Math.min(MAX_PIECES, Math.max(2, Math.ceil(notionalUsd / 50)));
    for (let n = start; n >= 2 && !chosen; n--) {
      const a = attempt(n);
      if (minOk(a.units)) chosen = a;
    }
    if (!chosen) return fail("shard_min_notional", MSG.minNotional);
    if (!capOk(chosen.units)) {
      let bigger: ReturnType<typeof attempt> | undefined;
      for (let n = chosen.n + 1; n <= MAX_PIECES && !bigger; n++) {
        const a = attempt(n);
        if (minOk(a.units) && capOk(a.units)) bigger = a;
      }
      if (!bigger) return fail("over_cap", MSG.overCap);
      chosen = bigger;
    }
  }

  const { s, units } = chosen;
  // Shuffle so piece order says nothing about which piece got the rounding remainder.
  for (let i = units.length - 1; i > 0; i--) {
    const j = s.int(0, i);
    [units[i], units[j]] = [units[j], units[i]];
  }

  const offsets: number[] = [];
  if (hiding === "normal") {
    offsets.push(s.int(NORMAL_ENTRY_MS[0], NORMAL_ENTRY_MS[1]));
  } else {
    for (let i = 0; i < units.length; i++) {
      let o: number;
      do o = s.int(WHALE_ENTRY_MS[0], WHALE_ENTRY_MS[1]);
      while (offsets.some((p) => Math.abs(p - o) < WHALE_MIN_GAP_MS));
      offsets.push(o);
    }
  }

  const pieces: Piece[] = units.map((u, index) => {
    const n = notionalOf(u);
    const equity = pieceEquity(n, leverage, maxLeverage);
    return {
      index,
      size: u / scale,
      notionalUsd: n,
      fundingUsd: ladderAmount(fundingNeed(n, leverage, maxLeverage))!,
      entryOffsetMs: offsets[index],
      reserveUsd: equity - n / leverage,
    };
  });

  return {
    coin,
    side,
    leverage,
    totalSize: totalUnits / scale,
    pieces,
    totalFundingUsd: pieces.reduce((a, p) => a + p.fundingUsd, 0),
    estFeesUsd: pieces.reduce((a, p) => a + TAKER_FEE * p.notionalUsd * 2 + ROUTE_FEE_USD, 0),
    vrfHex: toHex(vrf),
  };
}
