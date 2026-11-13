// Words and sums for judge mode: one small real trade on our demo account.
import type { JudgeRun, Side } from "./types";

/** Stop distances a judge can pick, as fractions of the entry price. */
export const STOP_CHOICES = [0.01, 0.02, 0.03] as const;
export const DEFAULT_STOP = 0.02;

/** The stop price that sits `distance` away from entry on the losing side. */
export function stopPrice(entryPx: number, side: Side, distance: number): number {
  if (!(entryPx > 0) || !(distance > 0 && distance < 1)) throw new Error("A stop needs an entry price and a distance between 0 and 1.");
  const raw = side === "long" ? entryPx * (1 - distance) : entryPx * (1 + distance);
  const digits = raw >= 1000 ? 0 : raw >= 10 ? 2 : 4;
  return Number(raw.toFixed(digits));
}

/** "9:05" for the time left, "0:00" once it has passed. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The entry price of a run's open position, or null until every piece has one. */
export function entryOf(run: JudgeRun): number | null {
  const pieces = run.position?.pieces ?? [];
  if (pieces.length === 0 || pieces.some((p) => !(Number(p.entryPx) > 0))) return null;
  // one size-weighted entry over the pieces
  const size = pieces.reduce((n, p) => n + Number(p.size), 0);
  return pieces.reduce((n, p) => n + Number(p.entryPx) * Number(p.size), 0) / size;
}

export type Step = "planned" | "ready" | "opening" | "open" | "closing" | "closed" | "failed";

/** Where the run is, in words a judge reads. */
export function stepLine(run: JudgeRun): string {
  const s = run.position?.state;
  switch (s) {
    case "planned":
    case "funding":
      return "Planned with a verifiable random draw. Readying the piece…";
    case "policy_wait":
      return "Waiting for the demo account's owner. Nothing is open.";
    case "opening":
      return "The piece opens at a random moment within 90 seconds, so its timing gives nothing away.";
    case "open":
      return "Open on Hyperliquid.";
    case "closing":
      return "Closing through the guard…";
    case "closed":
      return "Closed on Hyperliquid.";
    case "failed":
      return "Called off before anything opened. Nothing is held.";
    default:
      return "Reading…";
  }
}
