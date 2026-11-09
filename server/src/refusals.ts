// Every refusal and API error has a code and one plain sentence. Sentences with
// {name} are filled in when sent.
import type { FastifyReply } from "fastify";

export const REFUSALS = {
  policy_not_set: "Your new pieces need your approval in your wallet before we can trade. Open the approval.",
  policy_denied: "Your wallet policy blocked this. Nothing moved. You can change the policy in your wallet settings.",
  max_leverage: "The most leverage here is 10x. Lower it and try again.",
  over_cap: "That piece is bigger than the safety cap. We split it into more pieces instead.",
  shard_min_notional: "Each piece must be at least $10 on Hyperliquid. Add size or use fewer pieces.",
  stale_price: "Prices are out of date right now, so we didn't trade. We'll retry in a moment.",
  prices_disagree: "Price sources disagree right now, so we held off. Your stop is still set.",
  too_few_sources: "Not enough price sources answered, so we held off. Retrying.",
  reserve_low: "This piece's margin is thin. The guard cut size; a refill is on its way.",
  refill_cap: "Today's refill limit is reached. Add funds or lower the position.",
  refill_pending: "A refill is on its way (about 1–3 minutes).",
  venue_rejected: "Hyperliquid refused the order: {reason}. Nothing changed.",
  guard_unreachable:
    "The guard isn't answering. Your positions are open on Hyperliquid; stops can't fire until it's back. You can close now.",
  guard_unlisted: "This guard version isn't on our published list, so we won't use it.",
  deposit_below_min: "The smallest deposit for this route is {min}.",
  quote_expired: "That quote expired. Get a new one.",
  exit_needs_unlock: "Sending money home needs your approval in your wallet (one tap), then a second tap to lock it again.",
  exit_fee: "Leaving Hyperliquid costs about $1.20 per piece (Hyperliquid's new-account fee plus routing).",
  judge_session_spent: "This judge session is used up. The next one opens at {time}.",
  sealed_call_required: "Send this call as a sealed box.",
  chainsig_refused: "NEAR's signer contract refused this step: {reason}. Nothing moved.",
  chainsig_sign_again: "This piece's approval is too old for Hyperliquid. Open the app and continue the position to sign it again.",
} as const;

/** Errors of the API itself: sign-in, bad requests, unknown routes. */
export const API_ERRORS = {
  bad_request: "That request is not in the shape we expect.",
  not_found: "There is nothing here.",
  not_signed_in: "Sign in first.",
  wrong_recipient: "This sign-in was made for another app.",
  stale_message: "This sign-in message is too old or not in the expected form. Sign in again.",
  nonce_reused: "This sign-in was already used. Sign in again.",
  bad_signature: "The signature does not match this key and message.",
  key_not_on_account: "That key is not a full-access key of this NEAR account.",
  near_unreachable: "We couldn't reach NEAR to check your key. Try again in a moment.",
  internal: "Something went wrong on our side. Try again.",
  pieces_key_missing: "That key is not on your NEAR account yet. Add the pieces key in your wallet, then try again.",
  unknown_request: "We have no wallet key request with that id. Ask for a new key and try again.",
  wallet_key_refused: "OutLayer did not accept our key for this wallet. Add the key to the wallet again, then confirm.",
  balance_missing: "Make your private balance wallet first, then try again.",
  wallet_missing: "Make this piece wallet first, then try again.",
  policy_owner_wrong: "That policy was stored by another NEAR account. Store it again from your own account.",
  piece_in_use: "That piece still holds an open position. Close it first, then send it home.",
  shard_not_yours: "That piece is not part of this position. Seal the box for one of its own pieces.",
  wrong_state: "This can't be done in the position's current state. Reload and try again.",
  route_unavailable: "This deposit route is not available right now. Try the other route.",
} as const;

export type RefusalCode = keyof typeof REFUSALS;
export type ApiErrorCode = keyof typeof API_ERRORS;
export type ErrorCode = RefusalCode | ApiErrorCode;

const SENTENCES: Record<ErrorCode, string> = { ...REFUSALS, ...API_ERRORS };

export const HTTP_STATUS: Record<ErrorCode, number> = {
  policy_not_set: 409,
  policy_denied: 403,
  max_leverage: 422,
  over_cap: 422,
  shard_min_notional: 422,
  stale_price: 503,
  prices_disagree: 503,
  too_few_sources: 503,
  reserve_low: 409,
  refill_cap: 429,
  refill_pending: 409,
  venue_rejected: 502,
  guard_unreachable: 503,
  guard_unlisted: 409,
  deposit_below_min: 422,
  quote_expired: 410,
  exit_needs_unlock: 403,
  exit_fee: 409,
  judge_session_spent: 429,
  sealed_call_required: 400,
  chainsig_refused: 409,
  chainsig_sign_again: 409,
  bad_request: 400,
  not_found: 404,
  not_signed_in: 401,
  wrong_recipient: 401,
  stale_message: 401,
  nonce_reused: 401,
  bad_signature: 401,
  key_not_on_account: 401,
  near_unreachable: 503,
  internal: 500,
  pieces_key_missing: 409,
  unknown_request: 404,
  wallet_key_refused: 409,
  balance_missing: 409,
  wallet_missing: 409,
  policy_owner_wrong: 409,
  piece_in_use: 409,
  shard_not_yours: 403,
  wrong_state: 409,
  route_unavailable: 503,
};

/** Names a sentence needs filled in, such as ["reason"]. */
export function sentenceVars(code: ErrorCode): string[] {
  return [...SENTENCES[code].matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
}

/** The sentence for a code with every {name} filled. Throws if a value is missing. */
export function sentence(code: ErrorCode, vars: Record<string, string | number> = {}): string {
  return SENTENCES[code].replace(/\{(\w+)\}/g, (_, name: string) => {
    if (!(name in vars)) throw new Error(`sentence for ${code} needs ${name}`);
    return String(vars[name]);
  });
}

export function isErrorCode(code: string): code is ErrorCode {
  return Object.prototype.hasOwnProperty.call(SENTENCES, code);
}

/** An error that becomes { error, message } with the code's HTTP status. */
export class ApiError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    vars: Record<string, string | number> = {},
  ) {
    super(sentence(code, vars));
    this.name = "ApiError";
    this.status = HTTP_STATUS[code];
  }

  body(): { error: ErrorCode; message: string } {
    return { error: this.code, message: this.message };
  }
}

export function sendError(reply: FastifyReply, code: ErrorCode, vars: Record<string, string | number> = {}) {
  const e = new ApiError(code, vars);
  return reply.code(e.status).send(e.body());
}
