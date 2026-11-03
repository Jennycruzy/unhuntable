import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { keyHash } from "unhuntable-client";
import { describe, expect, it } from "vitest";
import { ConfigError, readSecrets } from "../src/config.js";
import { KeyStore, KeyStoreError } from "../src/keystore.js";
import { createLogger } from "../src/log.js";
import { OutLayerWallet } from "../src/outlayer.js";
import { fakeFetch, fixture, logSink, secretsFile } from "./helpers.js";
import { addUser, harness, KEYSTORE_KEY } from "./world.js";
import { buildServer } from "../src/index.js";
import { testConfig } from "./helpers.js";

function storePath(): string {
  return join(mkdtempSync(join(tmpdir(), "unhuntable-keys-")), "wallet-keys.json");
}

describe("wallet key store", () => {
  it("keystore_round_trip", async () => {
    const path = storePath();
    const ks = new KeyStore({ path, key: KEYSTORE_KEY });
    const { requestId, keyHash: h } = ks.newWalletKey("piece:0", "user-1");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    let seen = "";
    await ks.withRequestKey(requestId, async (k) => void (seen = k));
    expect(seen).toMatch(/^wk_[0-9a-f]{64}$/);
    expect(keyHash(seen)).toBe(h);
    // the file holds no key in the clear
    expect(readFileSync(path, "utf8")).not.toContain(seen);
    expect(readFileSync(path, "utf8")).not.toContain(seen.slice(3));

    ks.confirm(requestId, "wallet-1");
    const again = new KeyStore({ path, key: KEYSTORE_KEY });
    expect(again.get("wallet-1")).toBe(seen);
    expect(again.get("wallet-2")).toBeUndefined();
    expect(again.list()).toEqual([{ requestId, owner: "user-1", label: "piece:0", keyHash: h, walletId: "wallet-1" }]);
    expect(JSON.stringify(again.list())).not.toContain(seen);
    expect(JSON.stringify({ again })).toBe('{"again":"[redacted]"}');
    expect(inspect(again)).toBe("[redacted]");

    // a different keystore key cannot read it
    expect(() => new KeyStore({ path, key: "55".repeat(32) }).get("wallet-1")).toThrow(KeyStoreError);
  });

  it("keystore_refuses_readable_file", () => {
    for (const mode of [0o640, 0o604, 0o644]) {
      const path = storePath();
      writeFileSync(path, JSON.stringify({ entries: {} }));
      chmodSync(path, mode);
      expect(() => new KeyStore({ path, key: KEYSTORE_KEY })).toThrow(/readable by group or others/);
    }
    const path = storePath();
    writeFileSync(path, "not json");
    chmodSync(path, 0o600);
    expect(() => new KeyStore({ path, key: KEYSTORE_KEY })).toThrow(ConfigError);
    expect(() => new KeyStore({ key: "short" })).toThrow(ConfigError);
  });

  it("unknown_request_refused", async () => {
    const ks = new KeyStore({ key: KEYSTORE_KEY });
    expect(() => ks.confirm("00000000-0000-4000-8000-000000000099", "w")).toThrow(KeyStoreError);
    expect(() => ks.info("00000000-0000-4000-8000-000000000099")).toThrow(/no wallet key request/);
    await expect(ks.withRequestKey("nope", async () => 1)).rejects.toThrow(KeyStoreError);

    // over HTTP: unknown ids and another user's request read the same
    const h = harness();
    const alice = addUser(h, "alice.near");
    const bob = addUser(h, "bob.near");
    const app = buildServer({ config: testConfig(), db: h.db, now: h.ctx.now, money: h.ctx });
    const bobs = h.keystore.newWalletKey("piece:0", bob.userId);
    for (const requestId of ["00000000-0000-4000-8000-000000000099", bobs.requestId]) {
      const r = await app.inject({
        method: "POST",
        url: "/api/wallets/confirm",
        headers: { cookie: alice.cookie },
        payload: { requestId, label: "piece:0", seed: "unh-seed" },
      });
      expect(r.statusCode).toBe(404);
      expect(r.json().error).toBe("unknown_request");
    }
  });

  it("the secrets file takes keystoreKey and auroraKey", () => {
    const s = readSecrets(secretsFile(0o600, { paymentKey: "pk_" + "11".repeat(16), walletKeys: {}, keystoreKey: KEYSTORE_KEY, auroraKey: "aurora-test-key" }));
    expect(s.keystoreKey).toBe(KEYSTORE_KEY);
    expect(s.auroraKey).toBe("aurora-test-key");
    expect(() => readSecrets(secretsFile(0o600, { paymentKey: "pk_1", walletKeys: {}, keystoreKey: "zz" }))).toThrow(ConfigError);
  });
});

describe("keys_never_in_logs", () => {
  it("store keys reach only the Authorization header, never logs, errors or answers", async () => {
    const ks = new KeyStore({ key: KEYSTORE_KEY });
    const { requestId } = ks.newWalletKey("balance", "u");
    ks.confirm(requestId, "wallet-1");
    let key = "";
    await ks.withRequestKey(requestId, async (k) => void (key = k));
    const sink = logSink();
    const log = createLogger({ level: "debug", destination: sink });
    const f = fakeFetch([{ body: fixture("balance") }, { status: 403, body: fixture("withdraw-dry-run-not-whitelisted") }]);
    const w = new OutLayerWallet({ baseUrl: "https://outlayer.test", walletKeys: {}, keystore: ks, fetch: f.fetch, log });
    await w.balance("wallet-1");
    const err = await w.withdrawDryRun("wallet-1", { chain: "near", to: "alice.near", amount: "1", token: "t" }).catch((e) => e);
    expect(f.sent[0].headers.authorization).toBe(`Bearer ${key}`);
    expect(String(err.message)).not.toContain(key);
    log.info({ apiKey: key, note: `key ${key}`, store: ks, list: ks.list() }, `made ${key}`);
    log.error(new Error(`failed with ${key}`));
    expect(sink.text()).not.toContain(key);
    expect(sink.text()).not.toContain(key.slice(3));
    expect(sink.lines.length).toBeGreaterThanOrEqual(3);
  });

  it("the key route answers only the hash", async () => {
    const h = harness();
    const alice = addUser(h);
    const sink = logSink();
    const app = buildServer({ config: testConfig(), db: h.db, now: h.ctx.now, money: h.ctx, log: createLogger({ level: "debug", destination: sink }) });
    const r = await app.inject({ method: "POST", url: "/api/wallets/key", headers: { cookie: alice.cookie }, payload: { label: "balance" } });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(Object.keys(body).sort()).toEqual(["keyHash", "requestId"]);
    let key = "";
    await h.keystore.withRequestKey(body.requestId, async (k) => void (key = k));
    expect(keyHash(key)).toBe(body.keyHash);
    expect(r.body).not.toContain(key);
    expect(sink.text()).not.toContain(key);
  });
});
