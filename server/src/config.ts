// Settings come from the environment. Secrets come only from the file named by
// SECRETS_FILE, which must not be readable by group or others.
import { readFileSync, statSync } from "node:fs";
import { z } from "zod";

export interface Secrets {
  paymentKey: string;
  /** OutLayer wallet API key per wallet id. */
  walletKeys: Record<string, string>;
}

export interface Config {
  port: number;
  host: string;
  dbPath: string;
  outlayerUrl: string;
  network: "mainnet" | "testnet";
  nearRpcUrl: string;
  /** NEP-413 recipient the sign-in message must name. */
  appName: string;
  corsOrigins: string[];
  version: string;
  secrets: Secrets;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const SecretsFile = z.object({
  paymentKey: z.string().min(1),
  walletKeys: z.record(z.string().min(1), z.string().min(1)),
});

/** Read and check the secrets file. Error messages never include file contents. */
export function readSecrets(path: string | undefined): Secrets {
  if (!path) throw new ConfigError("SECRETS_FILE must name the secrets file");
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    throw new ConfigError(`secrets file ${path} cannot be read`);
  }
  if ((mode & 0o077) !== 0) {
    throw new ConfigError(`secrets file ${path} is readable by group or others; run chmod 600 on it`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new ConfigError(`secrets file ${path} is not valid JSON`);
  }
  const parsed = SecretsFile.safeParse(raw);
  if (!parsed.success) throw new ConfigError(`secrets file ${path} must hold { paymentKey, walletKeys: { walletId: apiKey } }`);
  const s = parsed.data;
  // If the object is ever logged or serialised, it prints as "[redacted]".
  Object.defineProperty(s, "toJSON", { value: () => "[redacted]", enumerable: false });
  Object.defineProperty(s, Symbol.for("nodejs.util.inspect.custom"), { value: () => "[redacted]", enumerable: false });
  return s;
}

function int(name: string, v: string | undefined, dflt: number): number {
  if (v === undefined || v === "") return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new ConfigError(`${name} must be a port number`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const network = env.NETWORK ?? "mainnet";
  if (network !== "mainnet" && network !== "testnet") throw new ConfigError("NETWORK must be mainnet or testnet");
  return {
    port: int("PORT", env.PORT, 8080),
    host: env.HOST ?? "127.0.0.1",
    dbPath: env.DB_PATH ?? "unhuntable.sqlite",
    outlayerUrl: (env.OUTLAYER_URL ?? "https://api.outlayer.ai").replace(/\/+$/, ""),
    network,
    nearRpcUrl: env.NEAR_RPC_URL ?? `https://rpc.${network}.near.org`,
    appName: env.APP_NAME ?? "unhuntable",
    corsOrigins: (env.CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    version: env.GIT_SHA || "dev",
    secrets: readSecrets(env.SECRETS_FILE),
  };
}
