// Wallet policies. A piece may only send to its own Hyperliquid account and to its owner;
// the private balance may only send to the owner's pieces and the owner's own exit
// addresses. Policies are stored on chain by the OWNER's NEAR account (store_wallet_policy
// on outlayer.near), so we build the transactions and the user signs them once.
// We never trust a policy until we have read it back.
import type { Ctx, WalletRow } from "./ctx.js";
import { ApiError } from "./refusals.js";
import { OutLayerWalletError } from "./outlayer.js";
import { NearRpcError } from "./near.js";
import { base58, hex } from "@scure/base";

export const TRANSACTION_TYPES = ["transfer", "call", "intents_withdraw", "intents_swap", "cross_chain_withdraw", "confidential"] as const;
/** Gas and deposit for one store_wallet_policy call: storage is about 0.0108 NEAR; the rest comes back. */
export const STORE_GAS = "100000000000000";
export const STORE_DEPOSIT = "100000000000000000000000";

export interface Policy {
  rules: { addresses: { mode: "whitelist"; list: string[] }; transaction_types: string[] };
  capabilities: Record<"confidential" | "swap" | "cross_chain_withdraw" | "evm_sign" | "solana_sign", { allowed: boolean }>;
  authorized_key_hashes: string[];
}

function policy(list: string[], keyHash: string, evmSign: boolean): Policy {
  return {
    rules: { addresses: { mode: "whitelist", list }, transaction_types: [...TRANSACTION_TYPES] },
    capabilities: {
      confidential: { allowed: true },
      swap: { allowed: true },
      cross_chain_withdraw: { allowed: true },
      evm_sign: { allowed: evmSign },
      solana_sign: { allowed: false },
    },
    authorized_key_hashes: [keyHash],
  };
}

/**
 * The wallet's own NEAR account (implicit: 64 hex characters of its ed25519 key).
 * A private swap pays out to this account, so a whitelist without it refuses every swap.
 * OutLayer reports the key as "ed25519:<64 hex>"; NEAR tools write "ed25519:<base58>". Both work.
 */
export function walletAccount(walletPubkey: string | null): string {
  if (!walletPubkey?.startsWith("ed25519:")) throw new ApiError("wallet_missing");
  const body = walletPubkey.slice("ed25519:".length);
  if (/^[0-9a-f]{64}$/.test(body)) return body;
  let bytes: Uint8Array;
  try {
    bytes = base58.decode(body);
  } catch {
    throw new ApiError("wallet_missing");
  }
  if (bytes.length !== 32) throw new ApiError("wallet_missing");
  return hex.encode(bytes);
}

/** A piece: its own EVM address, the owner's NEAR account and its own NEAR account. evmSign is true only while going home. */
export function piecePolicy(p: { evmAddress: string; owner: string; walletAccount: string; keyHash: string; evmSign?: boolean }): Policy {
  return policy([...new Set([p.evmAddress.toLowerCase(), p.owner, p.walletAccount])], p.keyHash, p.evmSign ?? false);
}

/** The private balance: every piece's EVM address, the owner's exit addresses and its own NEAR account. */
export function balancePolicy(p: { pieceAddresses: string[]; exitAddresses: string[]; walletAccount: string; keyHash: string }): Policy {
  const list = [...new Set([...p.pieceAddresses.map((a) => a.toLowerCase()), ...p.exitAddresses, p.walletAccount])];
  return policy(list, p.keyHash, false);
}

export interface PolicyTransaction {
  receiverId: string;
  actions: { type: "FunctionCall"; params: { methodName: "store_wallet_policy"; args: Record<string, unknown>; gas: string; deposit: string } }[];
}

export interface PolicyBatch {
  summary: string[];
  transactions: PolicyTransaction[];
}

export interface BatchItem {
  wallet: WalletRow;
  policy: Policy;
  sentence: string;
}

/** Encrypt and sign each policy through OutLayer and wrap it as one store_wallet_policy transaction. */
export async function buildBatch(ctx: Ctx, owner: string, items: BatchItem[]): Promise<PolicyBatch> {
  const batch: PolicyBatch = { summary: [], transactions: [] };
  for (const it of items) {
    if (!it.wallet.wallet_id) throw new ApiError("wallet_missing");
    const encrypted = await ctx.wallet.encryptPolicy(it.wallet.wallet_id, it.policy);
    const signed = await ctx.wallet.signPolicy(it.wallet.wallet_id, encrypted, owner);
    batch.summary.push(it.sentence);
    batch.transactions.push({
      receiverId: ctx.policyContract,
      actions: [
        {
          type: "FunctionCall",
          params: {
            methodName: "store_wallet_policy",
            args: {
              wallet_pubkey: signed.walletPubkey,
              encrypted_data: encrypted,
              wallet_signature: signed.walletSignature,
              version: signed.version,
              locked: signed.locked,
              valid_until: signed.validUntil,
              // named only when the policy is made; the contract refuses it on an update
              ...(signed.version === 1 ? { storage_refund_to: owner } : {}),
            },
            gas: STORE_GAS,
            deposit: STORE_DEPOSIT,
          },
        },
      ],
    });
  }
  return batch;
}

export function lockSentence(name: string, owner: string): string {
  return `Lock piece ${name}: it can only send to its own Hyperliquid account and to ${owner}. Our server cannot sign for it.`;
}

export function unlockSentence(name: string): string {
  return `Unlock piece ${name} so it can send its money home: it can sign Hyperliquid transfers until you lock it again.`;
}

export function balanceSentence(pieces: number, owner: string): string {
  return `Update your private balance: it can only send to your ${pieces} piece${pieces === 1 ? "" : "s"} and to your own addresses (${owner}).`;
}

/** Read a wallet's policy back: on chain the owner must be the user, and at OutLayer evm_sign must be as expected. */
export async function readBack(ctx: Ctx, owner: string, w: WalletRow, evmSign: boolean): Promise<void> {
  if (!w.wallet_id || !w.wallet_pubkey) throw new ApiError("wallet_missing");
  let view: unknown;
  try {
    view = await ctx.near.view(ctx.policyContract, "get_wallet_policy", { wallet_pubkey: w.wallet_pubkey });
  } catch (e) {
    if (e instanceof NearRpcError) throw new ApiError("near_unreachable");
    throw e;
  }
  if (!view || typeof view !== "object") throw new ApiError("policy_not_set");
  if ((view as { owner?: unknown }).owner !== owner) throw new ApiError("policy_owner_wrong");
  let p;
  try {
    p = await ctx.wallet.policy(w.wallet_id);
  } catch (e) {
    if (e instanceof OutLayerWalletError) throw new ApiError("policy_not_set");
    throw e;
  }
  if (p.policy !== "stored" || p.capabilities.evm_sign?.allowed !== evmSign) throw new ApiError("policy_not_set");
}
