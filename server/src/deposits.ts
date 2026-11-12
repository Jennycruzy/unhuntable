// Money coming in. Two routes into the user's private balance:
//  near:   OutLayer cross-chain confidential deposit on the "balance" wallet.
//  aurora: an Aurora Swap (1Click) quote with confidentiality "advanced", our app fee of 6 bps,
//          paid out to the private balance in Confidential Intents, refunds to refundTo.
// A job polls every 15 s until the deposit is done, refunded or expired.
import { USDC_NEAR, fromUnits, toUnits } from "unhuntable-client";
import { z } from "zod";
import { addAlert, balanceWallet, userRow, usd, type Ctx } from "./ctx.js";
import { newId } from "./db.js";
import { OneClickError, type OneClickStatus } from "./oneclick.js";
import { OutLayerWalletError } from "./outlayer.js";
import { ApiError, sentence } from "./refusals.js";
import { privateUnits } from "./wallets.js";

export const DEPOSIT_POLL_MS = 15_000;
export const OUR_FEE_BPS = 6;
/** The smallest deposit the near route takes, in USDC. */
export const NEAR_MIN_USDC = "2";
const QUOTE_TTL_MS = 30 * 60_000;

export const QuoteBody = z.object({
  route: z.enum(["near", "aurora"]),
  chain: z.string().regex(/^[a-z0-9_-]{2,32}$/),
  token: z.string().min(1).max(200),
  amount: z.string().regex(/^\d{1,12}(\.\d{1,18})?$/),
  refundTo: z.string().min(2).max(200),
});

/** 1Click asset ids for the tokens the deposit page offers on the MetaMask or Phantom route. */
export const AURORA_ASSETS: Record<string, Record<string, string>> = {
  eth: {
    USDC: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
    USDT: "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near",
    ETH: "nep141:eth.omft.near",
  },
  base: {
    USDC: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    ETH: "nep141:base.omft.near",
  },
  arb: {
    USDC: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
    // USDT on Arbitrum is USDT0 on 1Click
    USDT: "nep141:arb-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9.omft.near",
    ETH: "nep141:arb.omft.near",
  },
  sol: {
    USDC: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
    USDT: "nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near",
    SOL: "nep141:sol.omft.near",
  },
};

/** The 1Click asset id for a chain and token: a token name the page shows, or an asset id as is. */
export function auroraAsset(chain: string, token: string): string | undefined {
  if (token.startsWith("nep141:") || token.startsWith("nep245:")) return token;
  return AURORA_ASSETS[chain]?.[token.toUpperCase()];
}

/** Decimals of an amount for a chain and token. Hypercore USDC carries 8. */
export function decimalsFor(chain: string, token: string): number {
  if (chain === "hypercore") return 8;
  const t = token.toLowerCase();
  if (t.includes("wrap.near") || t === "near" || t === "wnear") return 24;
  if (/usdc|usdt/.test(t)) return 6;
  if (/btc/.test(t)) return 8;
  if (t === "sol" || t.includes("sol.omft")) return 9;
  if (/eth/.test(t)) return 18;
  return 6;
}

interface DepositRow {
  id: string;
  user_id: string;
  route: "near" | "aurora";
  chain: string;
  token: string;
  amount_in: string | null;
  amount_out: string | null;
  deposit_address: string;
  status: "waiting" | "seen" | "done" | "refunded" | "expired";
  expires_ms: number | null;
  min_amount: string | null;
  balance_before: string | null;
}

function belowMin(min: string): ApiError {
  return new ApiError("deposit_below_min", { min: `${min} USDC` });
}

const NEAR_ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOL_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const CHAIN_NAMES: Record<string, string> = { eth: "Ethereum", base: "Base", arb: "Arbitrum", sol: "Solana" };

/** The refund must be an address on the chain the money comes from; 1Click only answers "bad request" otherwise. */
function checkRefund(body: z.infer<typeof QuoteBody>): void {
  const r = body.refundTo.trim();
  if (body.route === "near") {
    if (r.length < 2 || r.length > 64 || !NEAR_ACCOUNT.test(r)) throw new ApiError("refund_wrong_chain", { chain: "NEAR", example: "alice.near" });
    return;
  }
  const chain = CHAIN_NAMES[body.chain] ?? body.chain;
  if (body.chain === "sol") {
    if (!SOL_ADDRESS.test(r)) throw new ApiError("refund_wrong_chain", { chain, example: "your Phantom address" });
  } else if (!EVM_ADDRESS.test(r)) {
    throw new ApiError("refund_wrong_chain", { chain, example: "0x… from MetaMask" });
  }
}

export async function quote(ctx: Ctx, userId: string, body: z.infer<typeof QuoteBody>) {
  const u = userRow(ctx, userId);
  checkRefund(body);
  const bal = balanceWallet(ctx, userId);
  const id = newId();
  const decimals = decimalsFor(body.chain, body.token);
  const units = toUnits(body.amount, decimals);
  if (units <= 0n) throw new ApiError("bad_request");
  const before = (await privateUnits(ctx, bal.wallet_id)).toString();
  let answer: { depositAddress: string; amountIn: string; amountOut: string; feeUsd: string; ourFeeBps: number; expiresMs: number; minAmount: string };
  let quoteJson: unknown;

  if (body.route === "near") {
    if (/usdc/i.test(body.token) && Number(body.amount) < Number(NEAR_MIN_USDC)) throw belowMin(NEAR_MIN_USDC);
    let d;
    try {
      // OutLayer names NEAR on the near chain "wNEAR"; the page shows it as NEAR.
      const token = body.chain === "near" && body.token.toUpperCase() === "NEAR" ? "wNEAR" : body.token;
      d = await ctx.wallet.depositCrossChain(bal.wallet_id, { chain: body.chain, token, amount: units.toString() });
    } catch (e) {
      if (e instanceof OutLayerWalletError && /too low/i.test(e.message)) throw belowMin(NEAR_MIN_USDC);
      if (e instanceof OutLayerWalletError && e.code !== "unreachable") throw new ApiError("bad_request");
      if (e instanceof OutLayerWalletError) throw new ApiError("route_unavailable");
      throw e;
    }
    const amountIn = fromUnits(BigInt(d.amount), decimals);
    const amountOut = fromUnits(BigInt(d.amountOut), 6);
    answer = {
      depositAddress: d.depositAddress,
      amountIn,
      amountOut,
      feeUsd: /usdc/i.test(body.token) ? usd(Number(amountIn) - Number(amountOut)) : "0.00",
      ourFeeBps: 0,
      expiresMs: Date.parse(d.expiresAt) || ctx.now() + QUOTE_TTL_MS,
      minAmount: NEAR_MIN_USDC,
    };
    quoteJson = { ...d, refundTo: body.refundTo };
  } else {
    const nearAddr = await ctx.wallet.address(bal.wallet_id, "near");
    const originAsset = auroraAsset(body.chain, body.token);
    if (!originAsset) throw new ApiError("bad_request");
    let q;
    try {
      q = await ctx.oneClick.quote({
        dry: false,
        swapType: "EXACT_INPUT",
        slippageTolerance: 100,
        originAsset,
        depositType: "ORIGIN_CHAIN",
        destinationAsset: USDC_NEAR,
        amount: units.toString(),
        refundTo: body.refundTo,
        refundType: "ORIGIN_CHAIN",
        recipient: nearAddr.address,
        recipientType: "CONFIDENTIAL_INTENTS",
        deadline: new Date(ctx.now() + QUOTE_TTL_MS).toISOString(),
        confidentiality: "advanced",
        appFees: [{ recipient: ctx.appFeeAccount, fee: OUR_FEE_BPS }],
      });
    } catch (e) {
      if (e instanceof OneClickError && /too low|minimum/i.test(e.message)) {
        const m = /(\d+(?:\.\d+)?)/.exec(e.message);
        // 1Click names the minimum in the token's smallest units
        throw belowMin(m ? (/^\d+$/.test(m[1]) ? fromUnits(BigInt(m[1]), decimals) : m[1]) : "the route's minimum");
      }
      if (e instanceof OneClickError && e.status === 400) throw new ApiError("bad_request");
      if (e instanceof OneClickError) throw new ApiError("route_unavailable");
      throw e;
    }
    const qq = q.quote;
    answer = {
      depositAddress: qq.depositAddress,
      amountIn: qq.amountInFormatted,
      amountOut: qq.amountOutFormatted,
      feeUsd: usd(Math.max(0, Number(qq.amountInUsd) - Number(qq.amountOutUsd))),
      ourFeeBps: OUR_FEE_BPS,
      expiresMs: (qq.deadline && Date.parse(qq.deadline)) || ctx.now() + QUOTE_TTL_MS,
      minAmount: fromUnits(BigInt(qq.minAmountIn), decimals),
    };
    quoteJson = q.raw;
  }

  ctx.db
    .prepare(
      `INSERT INTO deposits (id, user_id, route, chain, token, amount_in, amount_out, deposit_address, quote_json, status, expires_ms, min_amount, balance_before, created_ms, network)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?, ?, ?, ?)`,
    )
    .run(id, u.id, body.route, body.chain, body.token, answer.amountIn, answer.amountOut, answer.depositAddress, JSON.stringify(quoteJson), answer.expiresMs, answer.minAmount, before, ctx.now(), ctx.network);
  ctx.jobs.enqueue("deposit_poll", { depositId: id }, `deposit_poll:${id}:${ctx.now() + DEPOSIT_POLL_MS}`, ctx.now() + DEPOSIT_POLL_MS);
  return { id, ...answer };
}

export function depositStatus(ctx: Ctx, userId: string, id: string) {
  const d = ctx.db.prepare("SELECT * FROM deposits WHERE id = ? AND user_id = ?").get(id, userId) as DepositRow | undefined;
  if (!d) throw new ApiError("not_found");
  const out: { id: string; status: DepositRow["status"]; amountIn?: string; amountOut?: string } = { id: d.id, status: d.status };
  if (d.amount_in) out.amountIn = d.amount_in;
  if (d.amount_out) out.amountOut = d.amount_out;
  return out;
}

const AURORA_STATUS: Record<OneClickStatus, DepositRow["status"]> = {
  PENDING_DEPOSIT: "waiting",
  KNOWN_DEPOSIT_TX: "seen",
  PROCESSING: "seen",
  INCOMPLETE_DEPOSIT: "seen",
  SUCCESS: "done",
  REFUNDED: "refunded",
  FAILED: "refunded",
};

/** One poll of a deposit. Schedules the next one unless it is finished. */
export async function pollDeposit(ctx: Ctx, depositId: string): Promise<void> {
  const d = ctx.db.prepare("SELECT * FROM deposits WHERE id = ?").get(depositId) as DepositRow | undefined;
  if (!d || d.status === "done" || d.status === "refunded" || d.status === "expired") return;
  let next: DepositRow["status"] = d.status;
  let incomplete = false;
  if (d.route === "aurora") {
    const s = await ctx.oneClick.status(d.deposit_address);
    next = AURORA_STATUS[s] ?? d.status;
    incomplete = s === "INCOMPLETE_DEPOSIT";
  } else {
    const bal = balanceWallet(ctx, d.user_id);
    if ((await privateUnits(ctx, bal.wallet_id)) > BigInt(d.balance_before ?? "0")) next = "done";
  }
  // Statuses only move forward: a seen deposit never goes back to waiting.
  if (d.status === "seen" && next === "waiting") next = "seen";
  if (next === "waiting" && d.expires_ms !== null && ctx.now() > d.expires_ms) {
    next = "expired";
    addAlert(ctx, d.user_id, sentence("quote_expired"));
  }
  if (incomplete && d.status !== "seen") {
    addAlert(ctx, d.user_id, `The deposit of ${d.amount_in} was less than quoted. ${sentence("deposit_below_min", { min: `${d.min_amount} ${d.token}` })}`);
  }
  if (next !== d.status) ctx.db.prepare("UPDATE deposits SET status = ? WHERE id = ?").run(next, d.id);
  if (next === "done") addAlert(ctx, d.user_id, `Your deposit arrived in your private balance.`);
  if (next !== "done" && next !== "refunded" && next !== "expired") {
    const at = ctx.now() + DEPOSIT_POLL_MS;
    ctx.jobs.enqueue("deposit_poll", { depositId }, `deposit_poll:${depositId}:${at}`, at);
  }
}
