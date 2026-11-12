// The trader tag the guard counts a user's pieces under. Every piece is tagged when it is first
// registered, so a user who becomes a trader later has every trade since then in their record.
import { createHash } from "node:crypto";

export function traderTag(userId: string): string {
  return createHash("sha256").update(`unhuntable-trader-v1:${userId}`).digest("hex");
}
