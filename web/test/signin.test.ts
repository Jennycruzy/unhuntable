import { describe, expect, it } from "vitest";
import { Api, ApiError } from "../lib/api";
import { SIGN_IN_TEXT, WrongNetwork, signIn, signInRequest } from "../lib/signin";
import { scriptedFetch, testWallet } from "./helpers";

describe("sign in", () => {
  it("asks the wallet for exactly the fields the server checks", () => {
    const now = Date.UTC(2026, 0, 2, 3, 4, 5, 678);
    const r = signInRequest(now);
    expect(Object.keys(r).sort()).toEqual(["message", "nonce", "recipient"]);
    expect(r.message).toBe(`${SIGN_IN_TEXT}\n2026-01-02T03:04:05.678Z`);
    expect(SIGN_IN_TEXT).toBe("Sign in to Unhuntable");
    expect(r.recipient).toBe("unhuntable");
    expect(r.nonce).toBeInstanceOf(Uint8Array);
    expect(r.nonce).toHaveLength(32);
    expect(r).not.toHaveProperty("callbackUrl");
    expect(signInRequest(now).nonce).not.toEqual(r.nonce);
  });

  it("sends the signed message to POST /api/session with credentials", async () => {
    const { fetch, sent } = scriptedFetch([["POST /api/session", { body: { ok: true, accountId: "alice.near", expiresMs: 1 } }]]);
    const { wallet, calls } = testWallet();
    expect(await signIn(new Api(fetch, "https://api.example"), wallet)).toBe("alice.near");
    const asked = calls.find((c) => c.kind === "signMessage")!.arg as { message: string; recipient: string; nonce: Uint8Array };
    expect(Object.keys(asked).sort()).toEqual(["message", "nonce", "recipient"]);
    const body = JSON.parse(sent[0].body);
    expect(sent[0].url).toBe("https://api.example/api/session");
    expect(Object.keys(body).sort()).toEqual(["accountId", "message", "nonce", "publicKey", "recipient", "signature"]);
    expect(body.message).toBe(asked.message);
    expect(Buffer.from(body.nonce, "base64")).toEqual(Buffer.from(asked.nonce));
  });

  it("shows the server's refusal word for word", async () => {
    const message = "This sign-in message is too old or not in the expected form. Sign in again.";
    const { fetch } = scriptedFetch([["POST /api/session", { status: 401, body: { error: "stale_message", message } }]]);
    const err = await signIn(new Api(fetch, ""), testWallet().wallet).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe(message);
    expect(err.code).toBe("stale_message");
  });

  it("stops on the wrong network before anything is signed", async () => {
    const { fetch, sent } = scriptedFetch([]);
    const { wallet, calls } = testWallet("alice.testnet");
    await expect(signIn(new Api(fetch, ""), wallet)).rejects.toBeInstanceOf(WrongNetwork);
    expect(calls.map((c) => c.kind)).toEqual(["signIn"]);
    expect(sent).toHaveLength(0);
  });
});

describe("api", () => {
  it("sends credentials include on every call and only JSON", async () => {
    let init: RequestInit | undefined;
    const f = (async (_u: string, i: RequestInit) => {
      init = i;
      return new Response(JSON.stringify({ accountId: "alice.near", piecesKey: "missing", wallets: [] }));
    }) as unknown as typeof fetch;
    await new Api(f, "").me();
    expect(init?.credentials).toBe("include");
  });

  it("turns an unreachable server into a plain sentence", async () => {
    const f = (async () => {
      throw new TypeError("failed");
    }) as unknown as typeof fetch;
    await expect(new Api(f, "").me()).rejects.toThrow("We couldn't reach our server. Check your connection and try again.");
  });
});
