// Settings come from the environment. Secrets come only from the file named by
// SECRETS_FILE, which must not be readable by group or others.
import { readFileSync, statSync } from "node:fs";
import { z } from "zod";

export interface Secrets {
  paymentKey: string;
  /** OutLayer wallet API key per wallet id. */
  walletKeys: Record<string, string>;
  /** 32 bytes hex: encrypts the wallet key store. */
  keystoreKey?: string;
  /** Aurora Swap (1Click) API key. */
  auroraKey?: string;
  /** "ed25519:<base58>" key of the NEAR account that relays signer-contract calls and pays their gas. */
  relayKey?: string;
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
  /** File of wallet API keys made by the server, encrypted with secrets.keystoreKey. */
  walletKeysFile?: string;
  hyperliquidUrl: string;
  oneClickUrl: string;
  /** NEAR account and project of the guard on OutLayer. */
  guardOwner: string;
  guardProject: string;
  /** The contract that stores wallet policies. */
  policyContract: string;
  /** Account in INTENTS that receives our app fee on Aurora deposits. */
  appFeeAccount: string;
  /** The signer contract for pieces controlled by NEAR Chain Signatures; empty = off. */
  chainsigContract: string;
  /** NEAR account that relays signer-contract calls (its key is secrets.relayKey). */
  relayAccount: string;
  /** The Hunt Map collector's SQLite file, read for /api/hunt-map; unset = no map. */
  huntmapDb?: string;
  /** BUILDER_FEE=on: new NEAR-controlled pieces approve the builder fee and their opens carry it. */
  builderFee: boolean;
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
  keystoreKey: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
  auroraKey: z.string().min(1).optional(),
  relayKey: z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,90}$/).optional(),
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
  if (!parsed.success) throw new ConfigError(`secrets file ${path} must hold { paymentKey, walletKeys: { walletId: apiKey } }, and keystoreKey must be 32 bytes of hex`);
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

function onOff(name: string, v: string | undefined): boolean {
  if (v === undefined || v === "" || v === "off") return false;
  if (v === "on") return true;
  throw new ConfigError(`${name} must be on or off`);
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
    walletKeysFile: env.WALLET_KEYS_FILE || undefined,
    hyperliquidUrl: (env.HYPERLIQUID_URL ?? "https://api.hyperliquid.xyz").replace(/\/+$/, ""),
    oneClickUrl: (env.ONECLICK_URL ?? "https://1click.chaindefuser.com").replace(/\/+$/, ""),
    guardOwner: env.GUARD_OWNER ?? "",
    guardProject: env.GUARD_PROJECT ?? "",
    policyContract: env.POLICY_CONTRACT ?? "outlayer.near",
    appFeeAccount: env.APP_FEE_ACCOUNT ?? "",
    chainsigContract: env.CHAINSIG_CONTRACT ?? "",
    relayAccount: env.RELAY_ACCOUNT ?? "",
    huntmapDb: env.HUNTMAP_DB || undefined,
    builderFee: onOff("BUILDER_FEE", env.BUILDER_FEE),
    secrets: readSecrets(env.SECRETS_FILE),
  };
}
