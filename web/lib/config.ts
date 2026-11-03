// Settings read at build time. NEXT_PUBLIC_ values are baked into the static pages.
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/+$/, "");
export const NETWORK: "mainnet" | "testnet" = process.env.NEXT_PUBLIC_NEAR_NETWORK === "testnet" ? "testnet" : "mainnet";
/** The NEP-413 recipient the server checks (its APP_NAME). */
export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "unhuntable";
export const NEAR_RPC = NETWORK === "testnet" ? "https://rpc.testnet.near.org" : "https://rpc.mainnet.near.org";
/** Default tolerance for an invisible stop, in basis points. */
export const DEFAULT_JITTER_BPS = 20;
