// Sign-in with a NEP-413 signed message. The wallet signs
// sha256(borsh(u32 2^31 + 413) ‖ borsh({ message, nonce, recipient, callbackUrl })),
// we check the signature, the message time, the nonce and that the key belongs to the account,
// then issue a session cookie. Only the cookie's sha256 is stored.
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { base58 } from "@scure/base";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { Db } from "./db.js";
import { newId } from "./db.js";
import { ApiError } from "./refusals.js";

export const NEP413_TAG = 2 ** 31 + 413; // 2147484061
export const SIGN_IN_TEXT = "Sign in to Unhuntable";
export const MESSAGE_WINDOW_MS = 5 * 60_000;
export const NONCE_TTL_MS = 10 * 60_000;
export const SESSION_TTL_MS = 12 * 60 * 60_000;
export const SESSION_COOKIE = "sid";

/** True when publicKey is a full-access key of accountId. Injected so tests use no network. */
export type ViewAccessKey = (accountId: string, publicKey: string) => Promise<boolean>;

export const SessionRequest = z.object({
  accountId: z.string().regex(/^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/),
  publicKey: z.string().startsWith("ed25519:"),
  signature: z.string().min(1),
  message: z.string().max(200),
  nonce: z.string(),
  recipient: z.string().max(200),
  callbackUrl: z.string().max(500).optional(),
});
export type SessionRequest = z.infer<typeof SessionRequest>;

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function borshString(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  return concat(u32(bytes.length), bytes);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** The 32 bytes a NEP-413 signature covers. */
export function nep413Hash(p: { message: string; nonce: Uint8Array; recipient: string; callbackUrl?: string }): Uint8Array {
  if (p.nonce.length !== 32) throw new Error("nonce must be 32 bytes");
  const cb = p.callbackUrl === undefined ? new Uint8Array([0]) : concat(new Uint8Array([1]), borshString(p.callbackUrl));
  return sha256(concat(u32(NEP413_TAG), borshString(p.message), p.nonce, borshString(p.recipient), cb));
}

export function decodeEd25519Key(publicKey: string): Uint8Array | undefined {
  try {
    const k = base58.decode(publicKey.slice("ed25519:".length));
    return k.length === 32 ? k : undefined;
  } catch {
    return undefined;
  }
}

function base64Bytes(s: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return undefined;
  return new Uint8Array(Buffer.from(s, "base64"));
}

/** Parse "Sign in to Unhuntable\n<ISO time>" and return the time in ms. */
export function messageTime(message: string): number | undefined {
  const m = /^Sign in to Unhuntable\n(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)$/.exec(message);
  if (!m) return undefined;
  const t = Date.parse(m[1]);
  return Number.isFinite(t) ? t : undefined;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** NEAR RPC view_access_key: true only for a full-access key. */
export function nearViewAccessKey(rpcUrl: string, f: typeof fetch = fetch): ViewAccessKey {
  return async (accountId, publicKey) => {
    const res = await f(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "unhuntable",
        method: "query",
        params: { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey },
      }),
    });
    if (!res.ok) throw new Error(`NEAR RPC answered HTTP ${res.status}`);
    const body = (await res.json()) as { result?: { permission?: unknown; error?: string }; error?: unknown };
    if (body.result?.permission !== undefined) return body.result.permission === "FullAccess";
    if (body.error || body.result?.error) return false;
    throw new Error("NEAR RPC answer has no result");
  };
}

export interface AuthDeps {
  db: Db;
  network: string;
  appName: string;
  viewAccessKey: ViewAccessKey;
  now: () => number;
}

/** Check a sign-in and return a new session token for the account. Throws ApiError on refusal. */
export async function signIn(deps: AuthDeps, req: SessionRequest): Promise<{ token: string; userId: string; expiresMs: number }> {
  const { db, network, now } = deps;
  if (req.recipient !== deps.appName) throw new ApiError("wrong_recipient");
  const t = messageTime(req.message);
  if (t === undefined || Math.abs(now() - t) > MESSAGE_WINDOW_MS) throw new ApiError("stale_message");
  const nonce = base64Bytes(req.nonce);
  if (!nonce || nonce.length !== 32) throw new ApiError("bad_request");
  const pub = decodeEd25519Key(req.publicKey);
  const sig = base64Bytes(req.signature);
  if (!pub || !sig || sig.length !== 64) throw new ApiError("bad_signature");
  const hash = nep413Hash({ message: req.message, nonce, recipient: req.recipient, callbackUrl: req.callbackUrl });
  let good = false;
  try {
    good = ed25519.verify(sig, hash, pub);
  } catch {
    good = false;
  }
  if (!good) throw new ApiError("bad_signature");

  // The nonce is spent once the signature is good, whatever happens next.
  db.prepare("DELETE FROM sign_in_nonces WHERE expires_ms <= ?").run(now());
  const stored = db
    .prepare("INSERT OR IGNORE INTO sign_in_nonces (nonce, expires_ms, created_ms, network) VALUES (?, ?, ?, ?)")
    .run(Buffer.from(nonce).toString("base64"), now() + NONCE_TTL_MS, now(), network);
  if (stored.changes === 0) throw new ApiError("nonce_reused");

  let onAccount: boolean;
  try {
    onAccount = await deps.viewAccessKey(req.accountId, req.publicKey);
  } catch {
    throw new ApiError("near_unreachable");
  }
  if (!onAccount) throw new ApiError("key_not_on_account");

  const token = randomBytes(32).toString("base64url");
  const expiresMs = now() + SESSION_TTL_MS;
  const userId = db.transaction(() => {
    db.prepare("INSERT OR IGNORE INTO users (id, near_account, created_ms, network) VALUES (?, ?, ?, ?)").run(
      newId(),
      req.accountId,
      now(),
      network,
    );
    const u = db.prepare("SELECT id FROM users WHERE near_account = ?").get(req.accountId) as { id: string };
    db.prepare("DELETE FROM sessions WHERE expires_ms <= ?").run(now());
    db.prepare("INSERT INTO sessions (id, user_id, expires_ms, created_ms, network) VALUES (?, ?, ?, ?, ?)").run(
      hashToken(token),
      u.id,
      expiresMs,
      now(),
      network,
    );
    return u.id;
  })();
  return { token, userId, expiresMs };
}

/** The user id for a session token, or undefined when it is unknown or expired. */
export function sessionUser(db: Db, token: string | undefined, now: number): string | undefined {
  if (!token) return undefined;
  const r = db.prepare("SELECT user_id FROM sessions WHERE id = ? AND expires_ms > ?").get(hashToken(token), now) as
    | { user_id: string }
    | undefined;
  return r?.user_id;
}

export function endSession(db: Db, token: string | undefined): void {
  if (token) db.prepare("DELETE FROM sessions WHERE id = ?").run(hashToken(token));
}

export function sessionCookie(token: string, maxAgeS: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeS}`;
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}
