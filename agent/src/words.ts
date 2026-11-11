// Plain words for the tools' answers. Nothing here ever holds a stop level.
import type { AgentPosition } from "./api.js";

function pct(v: number | string | null): string {
  if (v === null || v === "") return "not known yet";
  const n = Number(v);
  if (!Number.isFinite(n)) return "not known yet";
  return `${(Math.abs(n) <= 1 ? n * 100 : n).toFixed(1)}% away`;
}

export function describeStatus(positions: AgentPosition[]): string {
  if (positions.length === 0) return "This agent has no positions.";
  return positions
    .map((p) => {
      const stops = p.pieces.filter((x) => x.hasStop).length;
      const guard = p.pieces.some((x) => x.guard !== "ok") ? " The guard is not answering for a piece; stops cannot fire until it is back." : "";
      const liq = p.pieces.map((x, i) => `piece ${i + 1}: liquidation ${pct(x.liqDistance)}`).join("; ");
      return (
        `${p.id}: ${p.side} $${p.notionalUsd} ${p.coin} at ${p.leverage}x, ${p.state}, ${p.pieces.length} ${p.pieces.length === 1 ? "piece" : "pieces"}` +
        ` (${liq}). Sealed stop on ${stops} of ${p.pieces.length}.${guard}`
      );
    })
    .join("\n");
}
