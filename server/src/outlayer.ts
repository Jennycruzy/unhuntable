// OutLayer wallet API client, plus guard calls through the shared client library.
// The wallet API key for a wallet id comes from config secrets and goes only into the
// Authorization header. Every POST carries a fresh X-Idempotency-Key.
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { GuardClient } from "unhuntable-client";
import { z } from "zod";
import type { Config } from "./config.js";
import type { RefusalCode } from "./refusals.js";

export class OutLayerWalletError extends Error {
  constructor(
    /** OutLayer's error code, or ours: unknown_wallet, unreachable, http_error, bad_reply. */
    readonly code: string,
    message: string,
    readonly status: number,
    /** Our refusal for this error, when there is one. */
    readonly refusal?: RefusalCode,
  ) {
    super(message);
    this.name = "OutLayerWalletError";
  }
}

const REFUSAL_FOR: Record<string, RefusalCode> = { policy_denied: "policy_denied" };

const ErrorReply = z.object({ error: z.string(), message: z.string().optional() });

/** OutLayer sometimes wraps the message as JSON text: {"error":"..."}. Unwrap it. */
function plainMessage(m: string | undefined, code: string): string {
  if (!m) return code;
  try {
    const inner = JSON.parse(m) as unknown;
    if (inner && typeof inner === "object" && typeof (inner as { error?: unknown }).error === "string") return (inner as { error: string }).error;
  } catch {
    // not JSON, keep as is
  }
  return m;
}

const Amount = z.string().regex(/^\d+$/);

const AddressReply = z
  .object({
    wallet_id: z.string(),
    chain: z.string(),
    address: z.string(),
    public_key: z.string(),
    asset_account_id: z.string().nullable(),
    executor_account_id: z.string().nullable(),
  })
  .transform((r) => ({
    walletId: r.wallet_id,
    chain: r.chain,
    address: r.address,
    publicKey: r.public_key,
    assetAccountId: r.asset_account_id,
    executorAccountId: r.executor_account_id,
  }));

const BalanceReply = z
  .object({ balances: z.array(z.object({ token: z.string(), balance: Amount })), account_id: z.string() })
  .transform((r) => ({ balances: r.balances, accountId: r.account_id }));

const QuoteReply = z
  .object({ amount_out: Amount, min_amount_out: Amount, time_estimate_seconds: z.number() })
  .transform((r) => ({ amountOut: r.amount_out, minAmountOut: r.min_amount_out, timeEstimateSeconds: r.time_estimate_seconds }));

const SubmittedReply = z
  .object({ request_id: z.string(), status: z.string(), intent_hash: z.string(), deposit_address: z.string() })
  .transform((r) => ({ requestId: r.request_id, status: r.status, intentHash: r.intent_hash, depositAddress: r.deposit_address }));

const RequestReply = z
  .object({
    request_id: z.string(),
    type: z.string(),
    status: z.string(),
    result: z
      .object({
        amount: Amount.optional(),
        recipient: z.string().optional(),
        submitted: z.boolean().optional(),
        amount_out: Amount.optional(),
        intent_hash: z.string().optional(),
        confidential: z.boolean().optional(),
        origin_asset: z.string().optional(),
        submitted_at: z.string().optional(),
        swap_details: z.object({ amountIn: Amount, amountOut: Amount, intentHashes: z.array(z.string()) }).partial().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .transform((r) => ({
    requestId: r.request_id,
    type: r.type,
    status: r.status,
    result: r.result
      ? {
          amount: r.result.amount,
          recipient: r.result.recipient,
          submitted: r.result.submitted,
          amountOut: r.result.amount_out,
          intentHash: r.result.intent_hash,
          confidential: r.result.confidential,
          originAsset: r.result.origin_asset,
          submittedAt: r.result.submitted_at,
          swapDetails: r.result.swap_details,
        }
      : null,
  }));

const CrossChainReply = z
  .object({
    intent_id: z.string(),
    deposit_address: z.string(),
    amount: Amount,
    amount_out: Amount,
    min_amount_out: Amount,
    expires_at: z.string(),
  })
  .transform((r) => ({
    intentId: r.intent_id,
    depositAddress: r.deposit_address,
    amount: r.amount,
    amountOut: r.amount_out,
    minAmountOut: r.min_amount_out,
    expiresAt: r.expires_at,
  }));

const PolicyReply = z
  .object({
    wallet_id: z.string(),
    controller: z.string(),
    frozen: z.boolean(),
    policy: z.enum(["stored", "none"]),
    rules: z
      .object({
        addresses: z.object({ mode: z.string(), list: z.array(z.string()) }).optional(),
        transaction_types: z.array(z.string()).optional(),
      })
      .passthrough()
      .nullable(),
    approval: z.unknown().nullable(),
    capabilities: z.record(z.object({ allowed: z.boolean() }).passthrough()),
    authorized_key_hashes: z.array(z.string()),
  })
  .transform((r) => ({
    walletId: r.wallet_id,
    controller: r.controller,
    frozen: r.frozen,
    policy: r.policy,
    rules: r.rules,
    approval: r.approval,
    capabilities: r.capabilities,
    authorizedKeyHashes: r.authorized_key_hashes,
  }));

const SignReply = z
  .object({ signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/), chain: z.string(), wallet_id: z.string() })
  .transform((r) => ({ signature: r.signature, chain: r.chain, walletId: r.wallet_id }));

const EncryptedPolicyReply = z.object({ encrypted_base64: z.string().min(1) }).transform((r) => r.encrypted_base64);

// What store_wallet_policy needs from the wallet's signature (outlayer contract/src/wallet.rs).
const SignedPolicyReply = z
  .object({
    signature_hex: z.string().regex(/^[0-9a-f]+$/),
    public_key_hex: z.string().regex(/^[0-9a-f]{64}$/),
    version: z.number().int().positive(),
    locked: z.boolean(),
    valid_until: z.number().int().positive(),
  })
  .transform((r) => ({
    walletPubkey: "ed25519:" + r.public_key_hex,
    walletSignature: r.signature_hex,
    version: r.version,
    locked: r.locked,
    validUntil: r.valid_until,
  }));

export type SignedPolicy = z.output<typeof SignedPolicyReply>;
export type WalletAddress = z.output<typeof AddressReply>;
export type WalletBalance = z.output<typeof BalanceReply>;
export type Quote = z.output<typeof QuoteReply>;
export type Submitted = z.output<typeof SubmittedReply>;
export type RequestStatus = z.output<typeof RequestReply>;
export type CrossChainDeposit = z.output<typeof CrossChainReply>;
export type WalletPolicy = z.output<typeof PolicyReply>;
export type TypedDataSignature = z.output<typeof SignReply>;

export interface WithdrawBody {
  chain: string;
  to: string;
  /** Token units, as a whole-number string. */
  amount: string;
  token: string;
}

export interface SwapBody {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
}

export interface CrossChainBody {
  chain: string;
  token: string;
  amount: string;
}

/** A pieces-key-signed grant of an API key for one deterministic wallet (apiKeyBody in the client). */
export interface KeyGrant {
  account_id: string;
  seed: string;
  key_hash: string;
  pubkey: string;
  message: string;
  signature: string;
}

export interface WalletClientOptions {
  baseUrl: string;
  walletKeys: Record<string, string>;
  /** Keys the server made for wallets (keystore.ts). Read when walletKeys has none. */
  keystore?: { get(walletId: string): string | undefined };
  fetch?: typeof fetch;
  uuid?: () => string;
  log?: Logger;
}

export class OutLayerWallet {
  private readonly f: typeof fetch;
  private readonly uuid: () => string;

  constructor(private readonly opts: WalletClientOptions) {
    this.f = opts.fetch ?? fetch;
    this.uuid = opts.uuid ?? randomUUID;
  }

  private keyFor(walletId: string): string {
    const key = this.opts.walletKeys[walletId] ?? this.opts.keystore?.get(walletId);
    if (!key) throw new OutLayerWalletError("unknown_wallet", "No API key is configured for this wallet.", 0);
    return key;
  }

  private call<S extends z.ZodTypeAny>(walletId: string, method: "GET" | "POST", path: string, schema: S, body?: unknown): Promise<z.output<S>> {
    let key: string;
    try {
      key = this.keyFor(walletId);
    } catch (e) {
      return Promise.reject(e);
    }
    return this.send(key, walletId, method, path, schema, body);
  }

  private async send<S extends z.ZodTypeAny>(key: string, walletId: string, method: "GET" | "POST", path: string, schema: S, body?: unknown): Promise<z.output<S>> {
    const headers: Record<string, string> = { Authorization: `Bearer ${key}`, Accept: "application/json" };
    if (method === "POST") {
      headers["Content-Type"] = "application/json";
      headers["X-Idempotency-Key"] = this.uuid();
    }
    const t0 = Date.now();
    let res: Response;
    try {
      res = await this.f(`${this.opts.baseUrl.replace(/\/+$/, "")}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      this.opts.log?.warn({ method, path, walletId }, "outlayer wallet unreachable");
      throw new OutLayerWalletError("unreachable", "OutLayer did not answer.", 0);
    }
    const text = await res.text();
    this.opts.log?.debug({ method, path, walletId, status: res.status, ms: Date.now() - t0 }, "outlayer wallet call");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new OutLayerWalletError(res.ok ? "bad_reply" : "http_error", `OutLayer answered HTTP ${res.status} with a body that is not JSON.`, res.status);
    }
    const err = ErrorReply.safeParse(json);
    if (err.success) {
      throw new OutLayerWalletError(err.data.error, plainMessage(err.data.message, err.data.error), res.status, REFUSAL_FOR[err.data.error]);
    }
    if (!res.ok) throw new OutLayerWalletError("http_error", `OutLayer answered HTTP ${res.status}.`, res.status);
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new OutLayerWalletError("bad_reply", "OutLayer's answer is not in the shape we expect.", res.status);
    return parsed.data;
  }

  /**
   * Hand OutLayer an API-key grant the pieces key signed (PUT /wallet/v1/api-key).
   * OutLayer checks the signature itself; we only carry it, because OutLayer does not let browsers send PUT.
   */
  async grantKey(grant: KeyGrant): Promise<void> {
    let res: Response;
    try {
      res = await this.f(`${this.opts.baseUrl.replace(/\/+$/, "")}/wallet/v1/api-key`, {
        method: "PUT",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(grant),
      });
    } catch {
      this.opts.log?.warn({ path: "/wallet/v1/api-key" }, "outlayer wallet unreachable");
      throw new OutLayerWalletError("unreachable", "OutLayer did not answer.", 0);
    }
    const text = await res.text();
    let json: unknown = {};
    try {
      json = text === "" ? {} : JSON.parse(text);
    } catch {
      if (!res.ok) throw new OutLayerWalletError("http_error", `OutLayer answered HTTP ${res.status}.`, res.status);
    }
    const err = ErrorReply.safeParse(json);
    if (err.success) throw new OutLayerWalletError(err.data.error, plainMessage(err.data.message, err.data.error), res.status, REFUSAL_FOR[err.data.error]);
    if (!res.ok) throw new OutLayerWalletError("http_error", `OutLayer answered HTTP ${res.status}.`, res.status);
  }

  /** The wallet's address on a chain. The Hyperliquid account is the base address. */
  address(walletId: string, chain: string): Promise<WalletAddress> {
    return this.call(walletId, "GET", `/wallet/v1/address?chain=${encodeURIComponent(chain)}`, AddressReply);
  }

  /** The address answer for a key that is not tied to a wallet id yet. Proves the key works. */
  addressWithKey(apiKey: string, chain: string): Promise<WalletAddress> {
    return this.send(apiKey, "(new key)", "GET", `/wallet/v1/address?chain=${encodeURIComponent(chain)}`, AddressReply);
  }

  /** Confidential balances in token units (USDC has 6 decimals). */
  balance(walletId: string): Promise<WalletBalance> {
    return this.call(walletId, "GET", "/wallet/v1/confidential/balance", BalanceReply);
  }

  /** What a withdrawal would deliver. On hypercore amount_out has 8 decimals. */
  withdrawDryRun(walletId: string, body: WithdrawBody): Promise<Quote> {
    return this.call(walletId, "POST", "/wallet/v1/confidential/withdraw/dry-run", QuoteReply, body);
  }

  withdraw(walletId: string, body: WithdrawBody): Promise<Submitted> {
    return this.call(walletId, "POST", "/wallet/v1/confidential/withdraw", SubmittedReply, body);
  }

  request(walletId: string, requestId: string): Promise<RequestStatus> {
    return this.call(walletId, "GET", `/wallet/v1/requests/${encodeURIComponent(requestId)}`, RequestReply);
  }

  swapQuote(walletId: string, b: SwapBody): Promise<Quote> {
    return this.call(walletId, "POST", "/wallet/v1/confidential/swap/quote", QuoteReply, { token_in: b.tokenIn, token_out: b.tokenOut, amount_in: b.amountIn });
  }

  swap(walletId: string, b: SwapBody): Promise<Submitted> {
    return this.call(walletId, "POST", "/wallet/v1/confidential/swap", SubmittedReply, { token_in: b.tokenIn, token_out: b.tokenOut, amount_in: b.amountIn });
  }

  depositCrossChain(walletId: string, body: CrossChainBody): Promise<CrossChainDeposit> {
    return this.call(walletId, "POST", "/wallet/v1/confidential/deposit/cross-chain", CrossChainReply, body);
  }

  policy(walletId: string): Promise<WalletPolicy> {
    return this.call(walletId, "GET", "/wallet/v1/policy", PolicyReply);
  }

  /** Encrypt a policy for this wallet. Answers the encrypted policy (base64) for signPolicy and the chain. */
  encryptPolicy(walletId: string, policy: object): Promise<string> {
    return this.call(walletId, "POST", "/wallet/v1/encrypt-policy", EncryptedPolicyReply, { wallet_id: walletId, ...policy });
  }

  /** Sign an encrypted policy for store_wallet_policy sent by `caller`: the signature names the caller and the next version. */
  signPolicy(walletId: string, encryptedData: string, caller: string): Promise<SignedPolicy> {
    return this.call(walletId, "POST", "/wallet/v1/sign-policy", SignedPolicyReply, { encrypted_data: encryptedData, caller });
  }

  signTypedData(walletId: string, chain: string, typedData: unknown): Promise<TypedDataSignature> {
    return this.call(walletId, "POST", "/wallet/v1/evm/sign-typed-data", SignReply, { chain, typed_data: typedData });
  }
}

export function walletClient(
  config: Config,
  opts: { fetch?: typeof fetch; log?: Logger; keystore?: { get(walletId: string): string | undefined } } = {},
): OutLayerWallet {
  return new OutLayerWallet({ baseUrl: config.outlayerUrl, walletKeys: config.secrets.walletKeys, ...opts });
}

/** A guard client paying with the configured payment key. */
export function guardClient(config: Config, p: { owner: string; project: string; boxPub?: string; fetch?: typeof fetch }): GuardClient {
  return new GuardClient({ ...p, paymentKey: config.secrets.paymentKey, baseUrl: config.outlayerUrl });
}
