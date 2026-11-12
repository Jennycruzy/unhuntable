// Position events other parts react to (copies, results). They run as jobs, so a failure
// there never stops the position itself.
import type { Ctx } from "./ctx.js";

export type PositionEvent = "open" | "closing" | "closed";

export function positionEvent(ctx: Ctx, positionId: string, event: PositionEvent): void {
  ctx.jobs.enqueue("position_event", { positionId, event }, `position_event:${positionId}:${event}`, ctx.now());
}
