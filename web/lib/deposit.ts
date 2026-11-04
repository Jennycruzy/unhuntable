import type { Route } from "./types";

export interface ChainChoice {
  id: string;
  name: string;
  tokens: string[];
}

/** route "near": from a NEAR wallet. route "aurora": from an EVM or Solana wallet such as MetaMask or Phantom. */
export const ROUTES: { id: Route; name: string; chains: ChainChoice[] }[] = [
  { id: "near", name: "NEAR wallet", chains: [{ id: "near", name: "NEAR", tokens: ["USDC", "USDT", "NEAR"] }] },
  {
    id: "aurora",
    name: "MetaMask or Phantom",
    chains: [
      { id: "eth", name: "Ethereum", tokens: ["USDC", "USDT", "ETH"] },
      { id: "base", name: "Base", tokens: ["USDC", "ETH"] },
      { id: "arb", name: "Arbitrum", tokens: ["USDC", "USDT", "ETH"] },
      { id: "sol", name: "Solana", tokens: ["USDC", "USDT", "SOL"] },
    ],
  },
];

export type DepositView =
  | { kind: "form" }
  | { kind: "waiting" | "seen"; msLeft: number }
  | { kind: "done"; amountOut?: string }
  | { kind: "refunded" }
  | { kind: "expired" };

/** What to show for a deposit status and the time left on the quote. */
export function depositView(status: string, expiresMs: number, nowMs: number, amountOut?: string): DepositView {
  if (status === "done") return { kind: "done", amountOut };
  if (status === "refunded") return { kind: "refunded" };
  if (status === "expired") return { kind: "expired" };
  if (status === "seen") return { kind: "seen", msLeft: expiresMs - nowMs };
  if (expiresMs <= nowMs) return { kind: "expired" };
  return { kind: "waiting", msLeft: expiresMs - nowMs };
}
