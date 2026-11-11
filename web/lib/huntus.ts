// Words for the Hunt us page, said only from what Hyperliquid answered.
import type { HuntUsReveal } from "./types";

/** The headline after the reveal. It never claims more than the reveal shows. */
export function revealHeadline(r: HuntUsReveal): string {
  const n = r.pieces.length;
  const sends = r.sendsBetweenPieces === 0 ? "No money ever moved between them" : `Money moved between them ${r.sendsBetweenPieces === 1 ? "once" : `${r.sendsBetweenPieces} times`}`;
  const book = r.restingOrders === 0 ? "no stop on the book" : `${r.restingOrders === 1 ? "1 order" : `${r.restingOrders} orders`} on the book`;
  return `${n} separate accounts. ${sends}, and ${book}.`;
}

/** "funded by 0x6b9e…0a24, which sent money to at least 871 accounts in the last 6 hours". */
export function payerLine(p: HuntUsReveal["pieces"][number], hours: number, short: (a: string) => string): string {
  if (!p.fundedBy) return "No funding found";
  const spread = p.payerAccounts && p.payerAccounts > 1 ? `, which sent money to at least ${p.payerAccounts} accounts in the last ${hours} hours` : "";
  return `Funded by ${short(p.fundedBy)}${spread}`;
}

export function secondsLeft(revealAtMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((revealAtMs - nowMs) / 1000));
}
