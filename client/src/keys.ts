// The pieces key and the OutLayer deterministic wallets it signs for.
//
// Every wallet a user has with us is derived by OutLayer from the user's NEAR account
// plus a seed. The seeds come from the pieces key, and the pieces key comes from the
// user's 12 words. So the 12 words and OutLayer's public API are enough to find every
// wallet and move the money home, without our servers.
//
// Pure code: runs in Node and in browsers. The 12 words never leave this module.
import { ed25519 } from "@noble/curves/ed25519";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import { sha512 } from "@noble/hashes/sha512";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { base58, base64urlnopad } from "@scure/base";
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";

export const NEAR_PATH = "m/44'/397'/0'";
export const OUTLAYER_API = "https://api.outlayer.ai";
/** OutLayer accepts a Bearer near: header within this many seconds of its clock. */
export const AUTH_WINDOW_S = 30;
/** Register and api-key messages are accepted within this many seconds. */
export const MESSAGE_WINDOW_S = 300;

export interface PiecesKey {
  /** 32-byte ed25519 private seed. Never sent anywhere. */
  readonly secret: Uint8Array;
  readonly publicKey: Uint8Array;
  /** "ed25519:<base58>" */
  readonly publicKeyStr: string;
  /** "ed25519:<base58 of seed ‖ public key>", the format NEAR wallets use. */
  readonly secretKeyStr: string;
}

/** 12 new English BIP39 words. */
export function newMnemonic(): string {
  return generateMnemonic(wordlist, 128);
}

export function normalizeMnemonic(words: string): string {
  return words.trim().split(/\s+/).map((w) => w.toLowerCase()).join(" ");
}

/** SLIP-0010 ed25519 derivation (hardened steps only). */
function slip10(seed: Uint8Array, path: string): Uint8Array {
  if (!/^m(\/\d+')+$/.test(path)) throw new Error("path must be hardened steps only, like m/44'/397'/0'");
  let I = hmac(sha512, utf8ToBytes("ed25519 seed"), seed);
  let key = I.slice(0, 32);
  let chain = I.slice(32);
  for (const part of path.split("/").slice(1)) {
    const index = (Number(part.slice(0, -1)) + 0x80000000) >>> 0;
    const data = new Uint8Array(37);
    data.set(key, 1);
    new DataView(data.buffer).setUint32(33, index);
    I = hmac(sha512, chain, data);
    key = I.slice(0, 32);
    chain = I.slice(32);
  }
  return key;
}

/** The pieces key from 12 words, with NEAR's standard derivation (BIP39 seed → SLIP-0010, m/44'/397'/0'). */
export function keyFromMnemonic(words: string): PiecesKey {
  const phrase = normalizeMnemonic(words);
  if (!validateMnemonic(phrase, wordlist)) throw new Error("those words are not a valid 12-word phrase");
  return keyFromSecret(slip10(mnemonicToSeedSync(phrase, ""), NEAR_PATH));
}

export function keyFromSecret(secret: Uint8Array): PiecesKey {
  if (secret.length !== 32) throw new Error("secret must be 32 bytes");
  const publicKey = ed25519.getPublicKey(secret);
  const both = new Uint8Array(64);
  both.set(secret);
  both.set(publicKey, 32);
  return {
    secret: Uint8Array.from(secret),
    publicKey,
    publicKeyStr: "ed25519:" + base58.encode(publicKey),
    secretKeyStr: "ed25519:" + base58.encode(both),
  };
}

/** Raw ed25519 signature (not NEP-413) over the UTF-8 bytes of message, in base58. */
export function signText(key: PiecesKey, message: string): string {
  return base58.encode(ed25519.sign(utf8ToBytes(message), key.secret));
}

export function verifyText(publicKeyStr: string, message: string, signature: string): boolean {
  try {
    return ed25519.verify(base58.decode(signature), utf8ToBytes(message), base58.decode(publicKeyStr.replace(/^ed25519:/, "")));
  } catch {
    return false;
  }
}

/** The NEAR action a wallet signs to add the pieces key to the user's account. */
export function addKeyAction(publicKey: string, opts: { fullAccess?: boolean } = {}) {
  if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(publicKey)) throw new Error("public key must be ed25519:<base58>");
  if (opts.fullAccess) {
    return { type: "AddKey" as const, params: { publicKey, accessKey: { permission: "FullAccess" as const } } };
  }
  // A function-call key on outlayer.near with a 1 yoctoNEAR allowance: it cannot spend NEAR.
  return {
    type: "AddKey" as const,
    params: {
      publicKey,
      accessKey: { permission: { receiverId: "outlayer.near", methodNames: ["unhuntable_wallet_auth"], allowance: "1" } },
    },
  };
}

// ------------------------------------------------------------ seeds and keys

function mac(key: PiecesKey, text: string): string {
  return bytesToHex(hmac(sha256, key.secret, utf8ToBytes(text)));
}

/** Wallet seed for a label: "balance" or "piece:<n>". Same words, same seed, forever. */
export function seedFor(key: PiecesKey, label: string): string {
  if (!/^(balance|piece:(0|[1-9]\d*))$/.test(label)) throw new Error(`unknown wallet label ${label}`);
  return "unh-" + mac(key, "wallet:" + label);
}

export function pieceLabel(n: number): string {
  return `piece:${n}`;
}

/** The backup delegate key for a wallet seed, so our server's key can always be revoked. */
export function backupKeyFor(key: PiecesKey, seed: string): string {
  return "wk_" + mac(key, "backup:" + seed);
}

/** sha256 hex of the full "wk_…" key string, as OutLayer stores it. */
export function keyHash(apiKey: string): string {
  return bytesToHex(sha256(utf8ToBytes(apiKey)));
}

// ------------------------------------------------------------ OutLayer auth

function unixSeconds(nowMs: number): number {
  return Math.floor(nowMs / 1000);
}

/** Authorization header value: "Bearer near:<base64url of JSON>". */
export function authHeader(key: PiecesKey, account: string, seed: string, nowMs: number): string {
  const timestamp = unixSeconds(nowMs);
  const json = {
    account_id: account,
    seed,
    pubkey: key.publicKeyStr,
    timestamp,
    signature: signText(key, `auth:${seed}:${timestamp}`),
  };
  return "Bearer near:" + base64urlnopad.encode(utf8ToBytes(JSON.stringify(json)));
}

/** Decode a Bearer near: header (for tests and checks). */
export function readAuthHeader(header: string): { account_id: string; seed: string; pubkey: string; timestamp: number; signature: string } {
  const m = /^Bearer near:([A-Za-z0-9_-]+={0,2})$/.exec(header);
  if (!m) throw new Error("not a Bearer near: header");
  return JSON.parse(new TextDecoder().decode(base64urlnopad.decode(m[1].replace(/=+$/, ""))));
}

export function registerBody(key: PiecesKey, account: string, seed: string, nowMs: number) {
  const message = `register:${seed}:${unixSeconds(nowMs)}`;
  return { account_id: account, seed, pubkey: key.publicKeyStr, message, signature: signText(key, message) };
}

export function apiKeyBody(key: PiecesKey, account: string, seed: string, apiKeyHash: string, nowMs: number) {
  if (!/^[0-9a-f]{64}$/.test(apiKeyHash)) throw new Error("key hash must be 64 lowercase hex characters");
  const message = `api-key:${seed}:${unixSeconds(nowMs)}`;
  return { account_id: account, seed, key_hash: apiKeyHash, pubkey: key.publicKeyStr, message, signature: signText(key, message) };
}

// ------------------------------------------------------------ OutLayer client

export class DeterministicWalletError extends Error {
  constructor(
    /** OutLayer's error code, or ours: http_error, bad_reply, unreachable, last_key. */
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DeterministicWalletError";
  }
}

export interface DeterministicOptions {
  key: PiecesKey;
  account: string;
  seed: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  /** Clock in ms (tests). */
  now?: () => number;
}

function unwrapMessage(m: unknown, code: string): string {
  if (typeof m !== "string" || !m) return code;
  try {
    const inner = JSON.parse(m) as { error?: unknown };
    if (inner && typeof inner.error === "string") return inner.error;
  } catch {
    // plain text
  }
  return m;
}

/** One OutLayer deterministic wallet (account + seed), signed for by the pieces key. */
export class OutLayerDeterministic {
  readonly seed: string;
  private readonly f: typeof fetch;
  private readonly base: string;
  private readonly now: () => number;

  constructor(private readonly opts: DeterministicOptions) {
    this.seed = opts.seed;
    this.f = opts.fetch ?? ((...a) => fetch(...a));
    this.base = (opts.baseUrl ?? OUTLAYER_API).replace(/\/+$/, "");
    this.now = opts.now ?? Date.now;
  }

  /** Send a request; with auth, the Bearer near: header is added. Error replies throw. */
  async request<T = Record<string, unknown>>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (auth) headers.Authorization = authHeader(this.opts.key, this.opts.account, this.seed, this.now());
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await this.f(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new DeterministicWalletError("unreachable", "OutLayer did not answer.", 0);
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text === "" ? {} : JSON.parse(text);
    } catch {
      throw new DeterministicWalletError(res.ok ? "bad_reply" : "http_error", `OutLayer answered HTTP ${res.status} with a body that is not JSON.`, res.status);
    }
    const j = json as { error?: unknown; message?: unknown };
    if (j && typeof j === "object" && typeof j.error === "string") {
      throw new DeterministicWalletError(j.error, unwrapMessage(j.message, j.error), res.status);
    }
    if (!res.ok) throw new DeterministicWalletError("http_error", `OutLayer answered HTTP ${res.status}.`, res.status);
    return json as T;
  }

  /** Create the wallet, or get the same one again: same account and seed give the same wallet. */
  async register(): Promise<{ walletId: string; nearAccountId: string; trial: unknown }> {
    const r = await this.request<{ wallet_id: string; near_account_id: string; trial?: unknown }>(
      "POST",
      "/register",
      registerBody(this.opts.key, this.opts.account, this.seed, this.now()),
      false,
    );
    if (typeof r.wallet_id !== "string") throw new DeterministicWalletError("bad_reply", "OutLayer's register answer has no wallet id.", 200);
    return { walletId: r.wallet_id, nearAccountId: r.near_account_id, trial: r.trial ?? null };
  }

  /** Let an API key (by its sha256) act for this wallet. */
  async addDelegateKey(apiKeyHash: string): Promise<{ walletId: string; nearAccountId: string }> {
    const r = await this.request<{ wallet_id: string; near_account_id: string }>(
      "PUT",
      "/wallet/v1/api-key",
      apiKeyBody(this.opts.key, this.opts.account, this.seed, apiKeyHash, this.now()),
      false,
    );
    return { walletId: r.wallet_id, nearAccountId: r.near_account_id };
  }

  /** Remove an API key. OutLayer refuses to remove a wallet's last key (HTTP 409). */
  async revokeDelegateKey(apiKeyHash: string): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(apiKeyHash)) throw new Error("key hash must be 64 lowercase hex characters");
    try {
      await this.request("DELETE", `/wallet/v1/api-key/${apiKeyHash}`);
    } catch (e) {
      if (e instanceof DeterministicWalletError && e.status === 409) {
        throw new DeterministicWalletError("last_key", "OutLayer will not remove a wallet's last key. Add the backup key first.", 409);
      }
      throw e;
    }
  }

  /** True if the wallet exists. Does not create it. An error reply means it does not exist. */
  async exists(): Promise<boolean> {
    try {
      const r = await this.request<{ address?: unknown }>("GET", "/wallet/v1/address?chain=base");
      return typeof r.address === "string";
    } catch (e) {
      if (e instanceof DeterministicWalletError && e.code !== "unreachable" && e.code !== "bad_reply") return false;
      throw e;
    }
  }

  /** The wallet's EVM address (also its Hyperliquid account). */
  async evmAddress(): Promise<string> {
    const r = await this.request<{ address?: unknown }>("GET", "/wallet/v1/address?chain=base");
    if (typeof r.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(r.address)) {
      throw new DeterministicWalletError("bad_reply", "OutLayer's address answer has no EVM address.", 200);
    }
    return r.address.toLowerCase();
  }
}

// ------------------------------------------------------------ rediscovery

export const GAP_LIMIT = 20;

export interface FoundWallet {
  label: string;
  seed: string;
}

/**
 * Walk "balance", then "piece:0", "piece:1", ... and stop after GAP_LIMIT labels in a row
 * that do not exist. `exists` checks one seed (OutLayerDeterministic.exists in real use).
 */
export async function rediscover(
  account: string,
  key: PiecesKey,
  exists: (seed: string, label: string) => Promise<boolean>,
  gap = GAP_LIMIT,
): Promise<FoundWallet[]> {
  if (!account) throw new Error("account is required");
  const found: FoundWallet[] = [];
  let missing = 0;
  for (let i = -1; missing < gap; i++) {
    const label = i < 0 ? "balance" : pieceLabel(i);
    const seed = seedFor(key, label);
    if (await exists(seed, label)) {
      found.push({ label, seed });
      missing = 0;
    } else {
      missing += 1;
    }
  }
  return found;
}
