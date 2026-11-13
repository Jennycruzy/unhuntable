import { describe, expect, it } from "vitest";
import { clock, entryOf, stepLine, stopPrice } from "../lib/judge";
import type { JudgeRun } from "../lib/types";

const run = (state: string, pieces: { size: number; entryPx: number | null }[]): JudgeRun =>
  ({ id: "r", live: true, endsMs: 0, stopSealed: false, stopByMs: null, position: { state, pieces } as any }) as JudgeRun;

describe("judge mode words and sums", () => {
  it("puts the stop on the losing side of entry", () => {
    expect(stopPrice(100_000, "long", 0.02)).toBe(98_000);
    expect(stopPrice(3_000, "short", 0.02)).toBe(3_060);
    expect(stopPrice(150.123, "long", 0.01)).toBe(148.62);
    expect(stopPrice(2.5, "short", 0.03)).toBe(2.575);
    expect(() => stopPrice(0, "long", 0.02)).toThrow();
    expect(() => stopPrice(100, "long", 1)).toThrow();
  });

  it("counts down in minutes and seconds, never below zero", () => {
    expect(clock(600_000)).toBe("10:00");
    expect(clock(65_400)).toBe("1:06");
    expect(clock(-5)).toBe("0:00");
  });

  it("reads one entry over the pieces, only once all have one", () => {
    expect(entryOf(run("opening", [{ size: 1, entryPx: null }]))).toBeNull();
    expect(entryOf(run("open", [{ size: 1, entryPx: 100 }, { size: 3, entryPx: 200 }]))).toBe(175);
    expect(entryOf(run("open", []))).toBeNull();
  });

  it("says where the run is", () => {
    expect(stepLine(run("opening", []))).toMatch(/random moment/);
    expect(stepLine(run("failed", []))).toMatch(/Nothing is held/);
  });
});
