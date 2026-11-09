// Settings read at build time. NEXT_PUBLIC_ values are baked into the static pages.
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/+$/, "");
export const NETWORK: "mainnet" | "testnet" = process.env.NEXT_PUBLIC_NEAR_NETWORK === "testnet" ? "testnet" : "mainnet";
/** The NEP-413 recipient the server checks (its APP_NAME). */
export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "unhuntable";
export const NEAR_RPC = NETWORK === "testnet" ? "https://rpc.testnet.near.org" : "https://rpc.mainnet.near.org";
/** Default tolerance for an invisible stop, in basis points. */
export const DEFAULT_JITTER_BPS = 20;
/** The signer contract that controls chain-signature pieces. The browser signs for no other. */
export const CHAINSIG_CONTRACT = process.env.NEXT_PUBLIC_CHAINSIG_CONTRACT ?? (NETWORK === "testnet" ? "unh-signer-qo8rfc.testnet" : "unhuntable.near");
/** RPC the browser uses to check a piece's account with NEAR's MPC network itself. */
export const NEAR_VIEW_RPC = NETWORK === "testnet" ? "https://test.rpc.fastnear.com" : "https://free.rpc.fastnear.com";
