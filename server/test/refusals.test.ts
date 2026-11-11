import { describe, expect, it } from "vitest";
import { API_ERRORS, ApiError, HTTP_STATUS, REFUSALS, sentenceVars, sentence, type ErrorCode } from "../src/refusals.js";

const CODES = [
  "policy_not_set",
  "policy_denied",
  "max_leverage",
  "over_cap",
  "shard_min_notional",
  "stale_price",
  "prices_disagree",
  "too_few_sources",
  "reserve_low",
  "refill_cap",
  "refill_pending",
  "venue_rejected",
  "guard_unreachable",
  "guard_unlisted",
  "deposit_below_min",
  "quote_expired",
  "exit_needs_unlock",
  "exit_fee",
  "judge_session_spent",
  "sealed_call_required",
  "chainsig_refused",
  "chainsig_sign_again",
  "stocks_need_near",
  "agent_needs_pieces",
  "agent_needs_app",
  "agent_limit",
  "agent_stocks",
  "payment_required",
  "payment_failed",
];

describe("refusal map complete", () => {
  it("has exactly the agreed codes, each with a sentence", () => {
    expect(Object.keys(REFUSALS).sort()).toEqual([...CODES].sort());
    for (const c of Object.keys({ ...REFUSALS, ...API_ERRORS }) as ErrorCode[]) {
      expect(HTTP_STATUS[c], c).toBeGreaterThanOrEqual(400);
      const vars = Object.fromEntries(sentenceVars(c).map((p) => [p, "X"]));
      const s = sentence(c, vars);
      expect(s, c).toMatch(/^[A-Z].*[.)]$/);
      expect(s, c).not.toMatch(/[{}]/);
    }
  });

  it("keeps the agreed wording", () => {
    expect(REFUSALS.max_leverage).toBe("The most leverage here is 10x. Lower it and try again.");
    expect(REFUSALS.refill_pending).toBe("A refill is on its way (about 1–3 minutes).");
    expect(REFUSALS.exit_fee).toBe("Leaving Hyperliquid costs about $1.20 per piece (Hyperliquid's new-account fee plus routing).");
  });

  it("fills in the named values", () => {
    expect(sentenceVars("venue_rejected")).toEqual(["reason"]);
    expect(sentenceVars("deposit_below_min")).toEqual(["min"]);
    expect(sentenceVars("judge_session_spent")).toEqual(["time"]);
    expect(sentence("venue_rejected", { reason: "insufficient margin" })).toBe("Hyperliquid refused the order: insufficient margin. Nothing changed.");
    expect(sentence("deposit_below_min", { min: "5 USDC" })).toBe("The smallest deposit for this route is 5 USDC.");
    expect(sentence("judge_session_spent", { time: "18:00 UTC" })).toBe("This judge session is used up. The next one opens at 18:00 UTC.");
    expect(() => sentence("venue_rejected")).toThrow(/needs reason/);
  });

  it("ApiError carries code, sentence and status", () => {
    const e = new ApiError("policy_denied");
    expect(e.status).toBe(403);
    expect(e.body()).toEqual({ error: "policy_denied", message: REFUSALS.policy_denied });
  });
});
