// Opening a position: plan, then confirm. New pieces get their wallets made in this browser,
// then the server goes on. If new pieces need their policy set, the wallet approves all of
// them in one go.
import { asset } from "unhuntable-client/hyperliquid";
import type { Api } from "./api";
import { makeWallet, type WalletDeps } from "./pieces";
import { setupChainSigPiece } from "./chainsig";
import type { PolicyBatch, PolicyConfirmed, PositionAnswer, TradeRequest } from "./types";
import { updateRecord } from "./vault";
import type { AppWallet } from "./wallet";

export interface TradeDeps extends WalletDeps {
  wallet: AppWallet;
  onStep?: (text: string) => void;
}

export function checkTrade(t: TradeRequest): string | undefined {
  if (!asset(t.coin)) return "Pick a market.";
  if (t.side !== "long" && t.side !== "short") return "Pick long or short.";
  if (!Number.isFinite(t.notionalUsd) || t.notionalUsd <= 0) return "Enter a size in USD.";
  if (!Number.isInteger(t.leverage) || t.leverage < 1 || t.leverage > 10) return "Leverage is a whole number from 1 to 10.";
  if (t.hiding !== "normal" && t.hiding !== "whale") return "Pick Normal or Whale.";
  return undefined;
}

/** POST /api/positions, then make any new piece wallets and continue. Returns the answer with the policy batch, if any. */
export async function openPosition(d: TradeDeps, t: TradeRequest): Promise<PositionAnswer> {
  return finishPieces(d, await d.api.openPosition(t));
}

/** Make any new piece wallets and sign for any NEAR-controlled pieces, then continue. Also used to continue a position later. */
export async function finishPieces(d: TradeDeps, a: PositionAnswer): Promise<PositionAnswer> {
  const chainSig = a.needChainSig ?? [];
  if (a.needWallets.length > 0 || chainSig.length > 0) {
    for (const label of chainSig) {
      d.onStep?.(`Setting up a NEAR-controlled piece (${label}): your pieces key signs, NEAR's MPC network will sign for Hyperliquid…`);
      const address = await setupChainSigPiece(d, label);
      await updateRecord(d.account, (r) => {
        r.addresses[label] = address;
      });
    }
    for (const label of a.needWallets) {
      d.onStep?.(`Making a new piece wallet (${label})…`);
      const address = await makeWallet(d, label);
      await updateRecord(d.account, (r) => {
        r.addresses[label] = address;
      });
    }
    d.onStep?.("Starting the position…");
    a = await d.api.continuePosition(a.positionId);
  }
  return a;
}

/** One wallet approval for the whole batch, unchanged, then tell the server the hashes. */
export async function approveBatch(
  api: Api,
  wallet: AppWallet,
  batch: PolicyBatch,
  ids: { positionId?: string; homeId?: string },
): Promise<PolicyConfirmed> {
  const txHashes = await wallet.signAndSendTransactions(batch.transactions);
  return api.policyConfirm({ ...ids, txHashes });
}

/** The review numbers, exactly as the plan has them. */
export function reviewRows(a: import("./types").PlanAnswer): { pieces: { n: number; size: string; notional: string; funding: string }[]; feesUsd: string; exitFeeUsd: string; count: number } {
  return {
    count: a.plan.pieces.length,
    pieces: a.plan.pieces.map((p, i) => ({ n: i + 1, size: String(p.size), notional: String(p.notionalUsd), funding: String(p.fundingUsd) })),
    feesUsd: String(a.feesUsd),
    exitFeeUsd: String(a.exitFeeUsd),
  };
}
