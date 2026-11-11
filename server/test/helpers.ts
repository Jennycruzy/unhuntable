import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readSecrets, type Config } from "../src/config.js";
import { openDb, type Db } from "../src/db.js";

/** Throwaway secrets: they only look like real keys. */
export const PAYMENT_KEY = "pk_" + "11".repeat(16);
export const WALLET_ID = "00000000-0000-4000-8000-000000000001";
export const WALLET_KEY = "wk_" + "22".repeat(16);

export function secretsFile(mode = 0o600, body: unknown = { paymentKey: PAYMENT_KEY, walletKeys: { [WALLET_ID]: WALLET_KEY } }): string {
  const dir = mkdtempSync(join(tmpdir(), "unhuntable-test-"));
  const path = join(dir, "secrets.json");
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
  chmodSync(path, mode);
  return path;
}

export function testConfig(over: Partial<Config> = {}): Config {
  return {
    port: 0,
    host: "127.0.0.1",
    dbPath: ":memory:",
    outlayerUrl: "https://outlayer.test",
    network: "mainnet",
    nearRpcUrl: "https://near.test",
    appName: "unhuntable",
    corsOrigins: ["https://app.example"],
    version: "dev",
    hyperliquidUrl: "https://hl.test",
    oneClickUrl: "https://oneclick.test",
    guardOwner: "guard.near",
    chainsigContract: "",
    relayAccount: "",
    guardProject: "guard",
    policyContract: "outlayer.near",
    appFeeAccount: "fees.near",
    builderFee: false,
    x402: false,
    x402PayTo: "",
    x402Price: "0.002",
    nearaiUrl: "https://nearai.test/v1",
    nearaiModel: "test/model",
    secrets: readSecrets(secretsFile()),
    ...over,
  };
}

export function memoryDb(now = () => 1_000): Db {
  return openDb(":memory:", { network: "mainnet", now });
}

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)), "utf8"));
}

/** Collects log lines written by pino. */
export function logSink() {
  const lines: string[] = [];
  return { lines, write: (s: string) => void lines.push(s), text: () => lines.join("") };
}

export interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch that records requests and answers from a list in order. No network. */
export function fakeFetch(answers: Array<{ status?: number; body: unknown }>) {
  const sent: Sent[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const a = answers.shift();
    if (!a) throw new Error("unexpected request");
    return new Response(typeof a.body === "string" ? a.body : JSON.stringify(a.body), { status: a.status ?? 200 });
  }) as typeof fetch;
  return { fetch: f, sent };
}
