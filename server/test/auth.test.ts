import { ed25519 } from "@noble/curves/ed25519";
import { base58 } from "@scure/base";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SIGN_IN_TEXT, hashToken, nearViewAccessKey, nep413Hash, sessionUser, signIn, type ViewAccessKey } from "../src/auth.js";
import { ApiError } from "../src/refusals.js";
import { fakeFetch, memoryDb } from "./helpers.js";

const NOW = 1_800_000_000_000;
const SECRET = new Uint8Array(32).fill(0x11); // throwaway key
const PUB = ed25519.getPublicKey(SECRET);
const PUBLIC_KEY = "ed25519:" + base58.encode(PUB);
const ACCOUNT = "alice.near";

let nonceByte = 0;
function signed(over: { message?: string; recipient?: string; nonce?: Uint8Array; secret?: Uint8Array; callbackUrl?: string } = {}) {
  const nonce = over.nonce ?? new Uint8Array(32).fill(++nonceByte);
  const message = over.message ?? `${SIGN_IN_TEXT}\n${new Date(NOW).toISOString()}`;
  const recipient = over.recipient ?? "unhuntable";
  const sig = ed25519.sign(nep413Hash({ message, nonce, recipient, callbackUrl: over.callbackUrl }), over.secret ?? SECRET);
  return {
    accountId: ACCOUNT,
    publicKey: PUBLIC_KEY,
    signature: Buffer.from(sig).toString("base64"),
    message,
    nonce: Buffer.from(nonce).toString("base64"),
    recipient,
    ...(over.callbackUrl === undefined ? {} : { callbackUrl: over.callbackUrl }),
  };
}

function setup(viewAccessKey: ViewAccessKey = async (a, k) => a === ACCOUNT && k === PUBLIC_KEY) {
  const db = memoryDb();
  const deps = { db, network: "mainnet", appName: "unhuntable", viewAccessKey, now: () => NOW };
  return { db, deps };
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "accepted";
  } catch (e) {
    if (e instanceof ApiError) return e.code;
    throw e;
  }
}

describe("NEP-413 payload", () => {
  it("hashes the borsh layout: tag, message, nonce, recipient, callbackUrl option", () => {
    const nonce = new Uint8Array(32).fill(7);
    const le = (n: number) => {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(n);
      return b;
    };
    const str = (s: string) => Buffer.concat([le(Buffer.byteLength(s)), Buffer.from(s)]);
    const want = (cb?: string) =>
      createHash("sha256")
        .update(Buffer.concat([le(2147484061), str("hi"), nonce, str("app"), cb === undefined ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), str(cb)])]))
        .digest("hex");
    expect(Buffer.from(nep413Hash({ message: "hi", nonce, recipient: "app" })).toString("hex")).toBe(want());
    expect(Buffer.from(nep413Hash({ message: "hi", nonce, recipient: "app", callbackUrl: "https://x" })).toString("hex")).toBe(want("https://x"));
  });
});

describe("NEP-413 accept/refuse cases", () => {
  it("accepts a good sign-in and stores only the session hash", async () => {
    const { db, deps } = setup();
    const s = await signIn(deps, signed());
    expect(s.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.expiresMs).toBe(NOW + 12 * 3600_000);
    const row = db.prepare("SELECT id, user_id FROM sessions").get() as { id: string; user_id: string };
    expect(row.id).toBe(hashToken(s.token));
    expect(row.id).not.toBe(s.token);
    expect(sessionUser(db, s.token, NOW)).toBe(s.userId);
    expect(sessionUser(db, s.token, NOW + 12 * 3600_000)).toBeUndefined();
    expect(db.prepare("SELECT near_account FROM users").all()).toEqual([{ near_account: ACCOUNT }]);
    // a second sign-in reuses the user
    const s2 = await signIn(deps, signed({ callbackUrl: "https://app.example/back" }));
    expect(s2.userId).toBe(s.userId);
  });

  it("accepts a message up to 5 minutes off", async () => {
    const { deps } = setup();
    for (const d of [-299_000, 299_000]) {
      expect(await code(signIn(deps, signed({ message: `${SIGN_IN_TEXT}\n${new Date(NOW + d).toISOString()}` })))).toBe("accepted");
    }
  });

  it("refuses a wrong recipient", async () => {
    expect(await code(signIn(setup().deps, signed({ recipient: "other.app" })))).toBe("wrong_recipient");
  });

  it("refuses a stale or malformed message", async () => {
    const { deps } = setup();
    for (const message of [
      `${SIGN_IN_TEXT}\n${new Date(NOW - 301_000).toISOString()}`,
      `${SIGN_IN_TEXT}\n${new Date(NOW + 301_000).toISOString()}`,
      `Sign in to Something\n${new Date(NOW).toISOString()}`,
      `${SIGN_IN_TEXT} ${new Date(NOW).toISOString()}`,
      `${SIGN_IN_TEXT}\nnow`,
    ]) {
      expect(await code(signIn(deps, signed({ message }))), message).toBe("stale_message");
    }
  });

  it("refuses a reused nonce", async () => {
    const { deps } = setup();
    const nonce = new Uint8Array(32).fill(0xaa);
    expect(await code(signIn(deps, signed({ nonce })))).toBe("accepted");
    expect(await code(signIn(deps, signed({ nonce })))).toBe("nonce_reused");
  });

  it("forgets nonces after 10 minutes", async () => {
    const { db } = setup();
    let now = NOW;
    const deps = { db, network: "mainnet", appName: "unhuntable", viewAccessKey: async () => true, now: () => now };
    const nonce = new Uint8Array(32).fill(0xbb);
    await signIn(deps, signed({ nonce }));
    now += 10 * 60_000 + 1;
    expect(db.prepare("SELECT COUNT(*) AS n FROM sign_in_nonces").get()).toEqual({ n: 1 });
    // a later sign-in clears expired nonces
    await code(signIn(deps, signed({ message: `${SIGN_IN_TEXT}\n${new Date(now).toISOString()}` })));
    expect((db.prepare("SELECT COUNT(*) AS n FROM sign_in_nonces WHERE nonce = ?").get(Buffer.from(nonce).toString("base64")) as { n: number }).n).toBe(0);
  });

  it("refuses a bad signature", async () => {
    const { deps } = setup();
    const other = new Uint8Array(32).fill(0x22);
    expect(await code(signIn(deps, signed({ secret: other })))).toBe("bad_signature");
    const good = signed();
    const flipped = Buffer.from(good.signature, "base64");
    flipped[0] ^= 1;
    expect(await code(signIn(deps, { ...good, signature: flipped.toString("base64") }))).toBe("bad_signature");
    // the signature covers the message: changing it after signing fails
    expect(await code(signIn(deps, { ...signed(), message: `${SIGN_IN_TEXT}\n${new Date(NOW + 1000).toISOString()}` }))).toBe("bad_signature");
    expect(await code(signIn(deps, { ...signed(), signature: "short" }))).toBe("bad_signature");
    expect(await code(signIn(deps, { ...signed(), publicKey: "ed25519:notbase58!" }))).toBe("bad_signature");
  });

  it("refuses a key that is not on the account", async () => {
    const { deps } = setup(async () => false);
    expect(await code(signIn(deps, signed()))).toBe("key_not_on_account");
  });

  it("refuses when NEAR cannot be reached", async () => {
    const { deps } = setup(async () => {
      throw new Error("down");
    });
    expect(await code(signIn(deps, signed()))).toBe("near_unreachable");
  });

  it("refuses a nonce that is not 32 bytes", async () => {
    const { deps } = setup();
    expect(await code(signIn(deps, { ...signed(), nonce: Buffer.alloc(16).toString("base64") }))).toBe("bad_request");
  });
});

describe("view_access_key over NEAR RPC", () => {
  it("is true only for a full-access key", async () => {
    const { fetch, sent } = fakeFetch([
      { body: { jsonrpc: "2.0", id: "unhuntable", result: { nonce: 1, permission: "FullAccess", block_height: 1 } } },
      { body: { jsonrpc: "2.0", id: "unhuntable", result: { nonce: 1, permission: { FunctionCall: { receiver_id: "x.near" } } } } },
      { body: { jsonrpc: "2.0", id: "unhuntable", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCESS_KEY" } } } },
      { status: 500, body: "oops" },
    ]);
    const view = nearViewAccessKey("https://near.test", fetch);
    expect(await view(ACCOUNT, PUBLIC_KEY)).toBe(true);
    expect(await view(ACCOUNT, PUBLIC_KEY)).toBe(false);
    expect(await view(ACCOUNT, PUBLIC_KEY)).toBe(false);
    await expect(view(ACCOUNT, PUBLIC_KEY)).rejects.toThrow();
    expect(sent[0].body).toMatchObject({
      method: "query",
      params: { request_type: "view_access_key", finality: "final", account_id: ACCOUNT, public_key: PUBLIC_KEY },
    });
  });
});
