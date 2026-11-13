import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, readSecrets } from "../src/config.js";
import { PAYMENT_KEY, WALLET_ID, WALLET_KEY, secretsFile } from "./helpers.js";

describe("config secret-file permissions", () => {
  it("reads a mode 600 secrets file", () => {
    const s = readSecrets(secretsFile(0o600));
    expect(s.paymentKey).toBe(PAYMENT_KEY);
    expect(s.walletKeys[WALLET_ID]).toBe(WALLET_KEY);
  });

  it("also accepts 400", () => {
    expect(readSecrets(secretsFile(0o400)).paymentKey).toBe(PAYMENT_KEY);
  });

  for (const mode of [0o640, 0o604, 0o644, 0o660, 0o666]) {
    it(`refuses mode ${mode.toString(8)}`, () => {
      expect(() => readSecrets(secretsFile(mode))).toThrow(/readable by group or others/);
    });
  }

  it("refuses a missing setting, a missing file, bad JSON and a wrong shape without echoing contents", () => {
    expect(() => readSecrets(undefined)).toThrow(ConfigError);
    expect(() => readSecrets("/nonexistent/secrets.json")).toThrow(ConfigError);
    expect(() => readSecrets(secretsFile(0o600, `{"paymentKey": "${PAYMENT_KEY}"`))).toThrow(/not valid JSON/);
    try {
      readSecrets(secretsFile(0o600, { paymentKey: PAYMENT_KEY, walletKeys: [WALLET_KEY] }));
      throw new Error("expected a refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect(String((e as Error).message)).not.toContain(PAYMENT_KEY);
      expect(String((e as Error).message)).not.toContain(WALLET_KEY);
    }
  });

  it("never prints secrets when the object is logged", () => {
    const s = readSecrets(secretsFile());
    expect(JSON.stringify({ s })).toBe('{"s":"[redacted]"}');
    expect(inspect(s)).toBe("[redacted]");
  });

  it("reads settings from env and secrets only from SECRETS_FILE", () => {
    const c = loadConfig({ SECRETS_FILE: secretsFile(), PORT: "9000", DB_PATH: "/tmp/x.sqlite", PAYMENT_KEY: "pk_" + "33".repeat(16) });
    expect(c.port).toBe(9000);
    expect(c.dbPath).toBe("/tmp/x.sqlite");
    expect(c.outlayerUrl).toBe("https://api.outlayer.ai");
    expect(c.network).toBe("mainnet");
    expect(c.version).toBe("dev");
    expect(c.secrets.paymentKey).toBe(PAYMENT_KEY);
    expect(() => loadConfig({})).toThrow(ConfigError);
    // judge mode: off unless both are given, and a bad hash or one half alone stops the start
    expect(loadConfig({ SECRETS_FILE: secretsFile() }).judge).toBeUndefined();
    expect(loadConfig({ SECRETS_FILE: secretsFile(), JUDGE_USER: "u1", JUDGE_CODE_SHA256: "AB".repeat(32) }).judge).toEqual({ userId: "u1", codeSha256: "ab".repeat(32), perDay: 12 });
    expect(() => loadConfig({ SECRETS_FILE: secretsFile(), JUDGE_USER: "u1" })).toThrow(ConfigError);
    expect(() => loadConfig({ SECRETS_FILE: secretsFile(), JUDGE_USER: "u1", JUDGE_CODE_SHA256: "abc" })).toThrow(ConfigError);
    expect(() => loadConfig({ SECRETS_FILE: secretsFile(), JUDGE_USER: "u1", JUDGE_CODE_SHA256: "ab".repeat(32), JUDGE_PER_DAY: "0" })).toThrow(ConfigError);
    expect(() => loadConfig({ SECRETS_FILE: secretsFile(), NETWORK: "devnet" })).toThrow(ConfigError);
    expect(loadConfig({ SECRETS_FILE: secretsFile(), NETWORK: "testnet", GIT_SHA: "abc123" })).toMatchObject({
      network: "testnet",
      nearRpcUrl: "https://rpc.testnet.near.org",
      version: "abc123",
    });
  });
});
