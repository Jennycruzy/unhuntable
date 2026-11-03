import { ed25519 } from "@noble/curves/ed25519";
import { base58 } from "@scure/base";
import { createHash, createHmac } from "node:crypto";
import { parseSeedPhrase } from "near-seed-phrase";
import { describe, expect, it } from "vitest";
import {
  AUTH_WINDOW_S,
  DeterministicWalletError,
  GAP_LIMIT,
  OutLayerDeterministic,
  addKeyAction,
  apiKeyBody,
  authHeader,
  backupKeyFor,
  keyFromMnemonic,
  keyHash,
  newMnemonic,
  readAuthHeader,
  rediscover,
  registerBody,
  seedFor,
  verifyText,
} from "../src/keys.js";

// Test-only phrases, never used for money.
const PHRASES = [
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  "legal winner thank year wave sausage worth useful legal winner thank yellow",
  "letter advice cage absurd amount doctor acoustic avoid letter advice cage above",
  "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong",
];
const NOW = 1_800_000_000_000;
const ACCOUNT = "alice.near";
const KEY = keyFromMnemonic(PHRASES[1]);

describe("pieces key", () => {
  it("matches near-seed-phrase byte for byte", () => {
    for (const p of PHRASES) {
      const k = keyFromMnemonic(p);
      const want = parseSeedPhrase(p);
      expect(k.publicKeyStr).toBe(want.publicKey);
      expect(k.secretKeyStr).toBe(want.secretKey);
    }
    // case and spacing do not matter
    expect(keyFromMnemonic(`  ${PHRASES[2].toUpperCase().replace(/ /g, "   ")} `).publicKeyStr).toBe(parseSeedPhrase(PHRASES[2]).publicKey);
  });

  it("makes 12 valid words that near-seed-phrase reads the same way", () => {
    for (let i = 0; i < 5; i++) {
      const words = newMnemonic();
      expect(words.split(" ")).toHaveLength(12);
      expect(keyFromMnemonic(words).publicKeyStr).toBe(parseSeedPhrase(words).publicKey);
    }
    expect(newMnemonic()).not.toBe(newMnemonic());
  });

  it("refuses words that are not a valid phrase", () => {
    expect(() => keyFromMnemonic("abandon ".repeat(12))).toThrow(/not a valid/);
    expect(() => keyFromMnemonic("hello world")).toThrow(/not a valid/);
  });

  it("add-key action: function-call by default, full access on request", () => {
    expect(addKeyAction(KEY.publicKeyStr)).toEqual({
      type: "AddKey",
      params: {
        publicKey: KEY.publicKeyStr,
        accessKey: { permission: { receiverId: "outlayer.near", methodNames: ["unhuntable_wallet_auth"], allowance: "1" } },
      },
    });
    expect(addKeyAction(KEY.publicKeyStr, { fullAccess: true }).params.accessKey).toEqual({ permission: "FullAccess" });
    expect(() => addKeyAction("ed25519:0OIl")).toThrow();
  });
});

describe("seeds and backup keys", () => {
  it("are HMAC-SHA256 of the private seed, the same every time", () => {
    const hmac = (t: string) => createHmac("sha256", Buffer.from(KEY.secret)).update(t).digest("hex");
    expect(seedFor(KEY, "balance")).toBe("unh-" + hmac("wallet:balance"));
    expect(seedFor(KEY, "piece:7")).toBe("unh-" + hmac("wallet:piece:7"));
    expect(seedFor(keyFromMnemonic(PHRASES[1]), "piece:0")).toBe(seedFor(KEY, "piece:0"));
    expect(seedFor(keyFromMnemonic(PHRASES[2]), "piece:0")).not.toBe(seedFor(KEY, "piece:0"));
    const seed = seedFor(KEY, "piece:0");
    expect(backupKeyFor(KEY, seed)).toBe("wk_" + hmac("backup:" + seed));
    expect(backupKeyFor(KEY, seed)).toBe(backupKeyFor(keyFromMnemonic(PHRASES[1]), seed));
    expect(keyHash("wk_" + "11".repeat(32))).toBe(createHash("sha256").update("wk_" + "11".repeat(32)).digest("hex"));
    expect(() => seedFor(KEY, "piece:-1")).toThrow();
    expect(() => seedFor(KEY, "piece:01")).toThrow();
  });
});

describe("OutLayer auth formats", () => {
  const seed = seedFor(KEY, "balance");

  it("Bearer near: header holds the fields and a raw ed25519 signature over auth:<seed>:<ts>", () => {
    const h = authHeader(KEY, ACCOUNT, seed, NOW + 999);
    expect(h).toMatch(/^Bearer near:[A-Za-z0-9_-]+$/);
    const j = readAuthHeader(h);
    expect(Object.keys(j)).toEqual(["account_id", "seed", "pubkey", "timestamp", "signature"]);
    expect(j).toMatchObject({ account_id: ACCOUNT, seed, pubkey: KEY.publicKeyStr, timestamp: NOW / 1000 });
    expect(verifyText(KEY.publicKeyStr, `auth:${seed}:${NOW / 1000}`, j.signature)).toBe(true);
    expect(ed25519.verify(base58.decode(j.signature), new TextEncoder().encode(`auth:${seed}:${NOW / 1000}`), KEY.publicKey)).toBe(true);
    expect(verifyText(KEY.publicKeyStr, `auth:${seed}:${NOW / 1000 + 1}`, j.signature)).toBe(false);
  });

  it("register and api-key bodies verify", () => {
    const r = registerBody(KEY, ACCOUNT, seed, NOW);
    expect(r).toMatchObject({ account_id: ACCOUNT, seed, pubkey: KEY.publicKeyStr, message: `register:${seed}:${NOW / 1000}` });
    expect(verifyText(KEY.publicKeyStr, r.message, r.signature)).toBe(true);
    const h = keyHash("wk_" + "22".repeat(32));
    const a = apiKeyBody(KEY, ACCOUNT, seed, h, NOW);
    expect(a).toMatchObject({ account_id: ACCOUNT, seed, key_hash: h, pubkey: KEY.publicKeyStr, message: `api-key:${seed}:${NOW / 1000}` });
    expect(verifyText(KEY.publicKeyStr, a.message, a.signature)).toBe(true);
    expect(() => apiKeyBody(KEY, ACCOUNT, seed, "ABC", NOW)).toThrow();
  });

  it("each request signs with the time it is sent, inside OutLayer's windows", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    let now = NOW;
    const w = new OutLayerDeterministic({
      key: KEY,
      account: ACCOUNT,
      seed,
      now: () => now,
      fetch: (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return new Response(JSON.stringify({ address: "0x" + "ab".repeat(20), wallet_id: "w", near_account_id: "n" }));
      }) as typeof fetch,
    });
    await w.exists();
    now += 45_000;
    await w.exists();
    await w.register();
    await w.addDelegateKey(keyHash("wk_" + "22".repeat(32)));
    const t1 = readAuthHeader(String((seen[0].init.headers as Record<string, string>).Authorization)).timestamp;
    const t2 = readAuthHeader(String((seen[1].init.headers as Record<string, string>).Authorization)).timestamp;
    // a header older than the window is never reused: the second request is signed afresh
    expect(t2 - t1).toBe(45);
    expect(t2 - t1).toBeGreaterThan(AUTH_WINDOW_S);
    // register and api-key carry no Authorization header and sign their message with the current time
    for (const i of [2, 3]) expect((seen[i].init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(JSON.parse(String(seen[2].init.body)).message).toBe(`register:${seed}:${now / 1000}`);
    expect(seen.map((s) => [s.init.method, s.url])).toEqual([
      ["GET", "https://api.outlayer.ai/wallet/v1/address?chain=base"],
      ["GET", "https://api.outlayer.ai/wallet/v1/address?chain=base"],
      ["POST", "https://api.outlayer.ai/register"],
      ["PUT", "https://api.outlayer.ai/wallet/v1/api-key"],
    ]);
  });

  it("exists is false on an error reply and revoking the last key reports last_key", async () => {
    const replies = [
      new Response(JSON.stringify({ error: "wallet_not_found", message: "No wallet" }), { status: 404 }),
      new Response(JSON.stringify({ error: "last_key", message: "Cannot revoke the last key" }), { status: 409 }),
      new Response("", { status: 200 }),
    ];
    const urls: string[] = [];
    const w = new OutLayerDeterministic({
      key: KEY,
      account: ACCOUNT,
      seed,
      now: () => NOW,
      fetch: (async (url: string, init: RequestInit) => {
        urls.push(`${init.method} ${url}`);
        return replies.shift()!;
      }) as typeof fetch,
    });
    expect(await w.exists()).toBe(false);
    const h = keyHash("wk_" + "33".repeat(32));
    await expect(w.revokeDelegateKey(h)).rejects.toMatchObject({ code: "last_key", status: 409 });
    await w.revokeDelegateKey(h);
    expect(urls[1]).toBe(`DELETE https://api.outlayer.ai/wallet/v1/api-key/${h}`);
    const down = new OutLayerDeterministic({ key: KEY, account: ACCOUNT, seed, fetch: (async () => { throw new Error("offline"); }) as typeof fetch });
    await expect(down.exists()).rejects.toBeInstanceOf(DeterministicWalletError);
  });
});

describe("rediscover", () => {
  function have(labels: string[]) {
    const seeds = new Set(labels.map((l) => seedFor(KEY, l)));
    const asked: string[] = [];
    return { asked, exists: async (seed: string, label: string) => (asked.push(label), seeds.has(seed)) };
  }

  it("finds the balance wallet and pieces, and stops after 20 missing in a row", async () => {
    const h = have(["balance", "piece:0", "piece:1", "piece:3", "piece:22"]);
    const found = await rediscover(ACCOUNT, KEY, h.exists);
    expect(found.map((f) => f.label)).toEqual(["balance", "piece:0", "piece:1", "piece:3", "piece:22"]);
    expect(found[0].seed).toBe(seedFor(KEY, "balance"));
    // piece:22 is 18 after piece:3, so it is found; then 20 misses (piece:23..piece:42) end the walk
    expect(h.asked.at(-1)).toBe("piece:42");
    expect(h.asked).toHaveLength(1 + 43);
  });

  it("a gap of 20 hides anything after it", async () => {
    const h = have(["balance", "piece:0", "piece:21"]);
    expect((await rediscover(ACCOUNT, KEY, h.exists)).map((f) => f.label)).toEqual(["balance", "piece:0"]);
    expect(h.asked.at(-1)).toBe("piece:20");
  });

  it("nothing found asks exactly 20 labels", async () => {
    const h = have([]);
    expect(await rediscover(ACCOUNT, KEY, h.exists)).toEqual([]);
    expect(h.asked).toHaveLength(GAP_LIMIT);
    expect(h.asked[0]).toBe("balance");
  });
});
