import { ed25519 } from "@noble/curves/ed25519";
import { base58 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { SIGN_IN_TEXT, hashToken, nep413Hash } from "../src/auth.js";
import { buildServer } from "../src/index.js";
import { createLogger } from "../src/log.js";
import { logSink, memoryDb, testConfig } from "./helpers.js";

const NOW = 1_800_000_000_000;
const SECRET = new Uint8Array(32).fill(0x11);
const PUBLIC_KEY = "ed25519:" + base58.encode(ed25519.getPublicKey(SECRET));

function server(over: { version?: string } = {}) {
  const db = memoryDb();
  const sink = logSink();
  const app = buildServer({
    config: testConfig(over),
    db,
    now: () => NOW,
    viewAccessKey: async (a, k) => a === "alice.near" && k === PUBLIC_KEY,
    log: createLogger({ level: "debug", destination: sink }),
  });
  return { app, db, sink };
}

function signInBody(nonceByte = 1) {
  const nonce = new Uint8Array(32).fill(nonceByte);
  const message = `${SIGN_IN_TEXT}\n${new Date(NOW).toISOString()}`;
  const sig = ed25519.sign(nep413Hash({ message, nonce, recipient: "unhuntable" }), SECRET);
  return {
    accountId: "alice.near",
    publicKey: PUBLIC_KEY,
    signature: Buffer.from(sig).toString("base64"),
    message,
    nonce: Buffer.from(nonce).toString("base64"),
    recipient: "unhuntable",
  };
}

describe("health and evidence endpoints", () => {
  it("health answers ok with the version", async () => {
    const { app } = server({ version: "0123abc" });
    const r = await app.inject({ method: "GET", url: "/api/health" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, version: "0123abc" });
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(r.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("evidence counts by kind for this network", async () => {
    const { app, db } = server();
    const add = db.prepare("INSERT INTO evidence (id, kind, ref, payload_sha256, created_ms, network) VALUES (?, ?, 'r', 'h', 1, ?)");
    add.run("e1", "tick", "mainnet");
    add.run("e2", "tick", "mainnet");
    add.run("e3", "proof", "mainnet");
    add.run("e4", "tick", "testnet");
    const r = await app.inject({ method: "GET", url: "/api/evidence" });
    expect(r.json()).toEqual({ counts: { proof: 1, tick: 2 } });
    const empty = await server().app.inject({ method: "GET", url: "/api/evidence" });
    expect(empty.json()).toEqual({ counts: {} });
  });

  it("unknown routes get 404 with a plain sentence", async () => {
    const { app } = server();
    for (const [method, url] of [
      ["GET", "/"],
      ["GET", "/index.html"],
      ["POST", "/api/health"],
      ["GET", "/api/nothing"],
    ] as const) {
      const r = await app.inject({ method, url });
      expect(r.statusCode, url).toBe(404);
      expect(r.json()).toEqual({ error: "not_found", message: "There is nothing here." });
      expect(r.headers["content-type"]).toContain("application/json");
    }
  });

  it("CORS only for allowed origins", async () => {
    const { app } = server();
    const ok = await app.inject({ method: "GET", url: "/api/health", headers: { origin: "https://app.example" } });
    expect(ok.headers["access-control-allow-origin"]).toBe("https://app.example");
    expect(ok.headers["access-control-allow-credentials"]).toBe("true");
    const other = await app.inject({ method: "GET", url: "/api/health", headers: { origin: "https://evil.example" } });
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
    const pre = await app.inject({ method: "OPTIONS", url: "/api/session", headers: { origin: "https://app.example" } });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers["access-control-allow-methods"]).toBe("GET, POST");
    const badPre = await app.inject({ method: "OPTIONS", url: "/api/session", headers: { origin: "https://evil.example" } });
    expect(badPre.statusCode).toBe(404);
  });
});

describe("session endpoints", () => {
  it("signs in with a secure cookie and logs out", async () => {
    const { app, db, sink } = server();
    const r = await app.inject({ method: "POST", url: "/api/session", payload: signInBody() });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, accountId: "alice.near" });
    const cookie = String(r.headers["set-cookie"]);
    expect(cookie).toMatch(/^sid=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200$/);
    const token = /^sid=([^;]+)/.exec(cookie)![1];
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id = ?").get(hashToken(token))).toEqual({ n: 1 });
    expect(sink.text()).not.toContain(token);

    const again = await app.inject({ method: "POST", url: "/api/session", payload: signInBody() });
    expect(again.statusCode).toBe(401);
    expect(again.json()).toEqual({ error: "nonce_reused", message: "This sign-in was already used. Sign in again." });

    const out = await app.inject({ method: "POST", url: "/api/logout", headers: { cookie: `other=1; sid=${token}` } });
    expect(out.json()).toEqual({ ok: true });
    expect(String(out.headers["set-cookie"])).toContain("Max-Age=0");
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
  });

  it("refuses bad bodies with bad_request", async () => {
    const { app } = server();
    for (const payload of [{}, { ...signInBody(2), accountId: "Not An Account" }, "not json"]) {
      const r = await app.inject({ method: "POST", url: "/api/session", payload, headers: { "content-type": "application/json" } });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe("bad_request");
    }
  });

  it("refusals carry their code and sentence", async () => {
    const { app } = server();
    const r = await app.inject({ method: "POST", url: "/api/session", payload: { ...signInBody(3), recipient: "other.app" } });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: "wrong_recipient", message: "This sign-in was made for another app." });
  });
});
