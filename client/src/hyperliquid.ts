// Hyperliquid actions and their EIP-712 signing data, built exactly like the official SDK
// and like the guard's Rust code (guard/src/lib.rs): ordered msgpack, action hash,
// Agent typed data for L1 actions, HyperliquidTransaction typed data for user-signed ones.
// Pure code: runs in Node and in browsers.
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";

export const HL_API = "https://api.hyperliquid.xyz";
export const SIGNATURE_CHAIN_ID = 0x66eee; // 421614
export const SIGNATURE_CHAIN_HEX = "0x66eee";
export const USDC_SPOT_TOKEN = "USDC:0x6d1e7cde53ba9467b783cb7c530ce054";
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface Asset {
  coin: string;
  index: number;
  szDecimals: number;
}

/** Perp universe indexes, as in the guard. */
export const ASSETS: readonly Asset[] = [
  { coin: "BTC", index: 0, szDecimals: 5 },
  { coin: "ETH", index: 1, szDecimals: 4 },
  { coin: "SOL", index: 5, szDecimals: 2 },
];

export function asset(coin: string): Asset | undefined {
  return ASSETS.find((a) => a.coin === coin);
}

// ------------------------------------------------------------ msgpack

/** Values in an action. Object key order is kept, so bytes match the SDK's dict order. */
export type Value = string | number | boolean | Value[] | { [k: string]: Value };

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function header(small: number, smallMax: number, codes: [number, number, number?], n: number): Uint8Array {
  if (n <= smallMax) return new Uint8Array([small | n]);
  const [c8, c16, c32] = codes;
  if (c8 && n < 0x100) return new Uint8Array([c8, n]);
  if (n < 0x10000) return new Uint8Array([c16, n >> 8, n & 0xff]);
  const b = new Uint8Array(5);
  b[0] = c32!;
  new DataView(b.buffer).setUint32(1, n);
  return b;
}

function packStr(s: string): Uint8Array {
  const b = utf8ToBytes(s);
  return concat([header(0xa0, 31, [0xd9, 0xda, 0xdb], b.length), b]);
}

function packUint(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`msgpack: ${n} is not an unsigned integer`);
  if (n < 0x80) return new Uint8Array([n]);
  if (n < 0x100) return new Uint8Array([0xcc, n]);
  if (n < 0x10000) return new Uint8Array([0xcd, n >> 8, n & 0xff]);
  if (n < 0x100000000) {
    const b = new Uint8Array(5);
    b[0] = 0xce;
    new DataView(b.buffer).setUint32(1, n);
    return b;
  }
  const b = new Uint8Array(9);
  b[0] = 0xcf;
  new DataView(b.buffer).setBigUint64(1, BigInt(n));
  return b;
}

/** Msgpack with the same choices as rmp (smallest int and length forms). */
export function msgpack(v: Value): Uint8Array {
  if (typeof v === "string") return packStr(v);
  if (typeof v === "number") return packUint(v);
  if (typeof v === "boolean") return new Uint8Array([v ? 0xc3 : 0xc2]);
  if (Array.isArray(v)) return concat([header(0x90, 15, [0, 0xdc, 0xdd], v.length), ...v.map(msgpack)]);
  const entries = Object.entries(v);
  return concat([header(0x80, 15, [0, 0xde, 0xdf], entries.length), ...entries.flatMap(([k, x]) => [packStr(k), msgpack(x)])]);
}

// ------------------------------------------------------------ numbers

/** Hyperliquid float_to_wire: 8 decimals, trailing zeros stripped. */
export function floatToWire(x: number): string {
  let r = x.toFixed(8);
  if (r.includes(".")) r = r.replace(/0+$/, "").replace(/\.$/, "");
  return r === "-0" ? "0" : r;
}

/** Perp price rule: at most 5 significant figures and 6 - szDecimals decimals; integers always valid. */
export function roundPx(px: number, szDecimals: number): number {
  if (px >= 100_000) return Math.round(px);
  const sig = Number(px.toExponential(4));
  const p = 10 ** (6 - szDecimals);
  return Math.round(sig * p) / p;
}

export function roundSz(sz: number, szDecimals: number): number {
  const p = 10 ** szDecimals;
  return Math.floor(sz * p) / p;
}

// ------------------------------------------------------------ actions

/** One IOC limit order; reduceOnly true for closes. */
export function orderAction(a: Asset, isBuy: boolean, px: number, sz: number, opts: { reduceOnly?: boolean; builder?: { address: string; fee: number } } = {}) {
  const action: { [k: string]: Value } = {
    type: "order",
    orders: [
      {
        a: a.index,
        b: isBuy,
        p: floatToWire(roundPx(px, a.szDecimals)),
        s: floatToWire(roundSz(sz, a.szDecimals)),
        r: opts.reduceOnly ?? true,
        t: { limit: { tif: "Ioc" } },
      },
    ],
    grouping: "na",
  };
  if (opts.builder) action.builder = { b: opts.builder.address.toLowerCase(), f: opts.builder.fee };
  return action;
}

/** Reduce-only IOC close, `slip` (0.03 = 3%) through the mid price. */
export function closeOrder(a: Asset, positionSize: number, mid: number, slip = 0.03) {
  const isBuy = positionSize < 0; // a short closes by buying
  const px = isBuy ? mid * (1 + slip) : mid * (1 - slip);
  return orderAction(a, isBuy, px, Math.abs(positionSize), { reduceOnly: true });
}

/** Opening IOC order (not reduce-only), 3% through the mid price. */
export function openOrder(a: Asset, isBuy: boolean, mid: number, sz: number) {
  return orderAction(a, isBuy, isBuy ? mid * 1.03 : mid * 0.97, sz, { reduceOnly: false });
}

export function updateLeverageAction(a: Asset, leverage: number) {
  return { type: "updateLeverage", asset: a.index, isCross: true, leverage };
}

/** keccak256(msgpack(action) ‖ nonce u64 BE ‖ 0x00): the hash of an L1 action with no vault. */
export function actionHash(action: Value, nonce: number): Uint8Array {
  const n = new Uint8Array(8);
  new DataView(n.buffer).setBigUint64(0, BigInt(nonce));
  return keccak_256(concat([msgpack(action), n, new Uint8Array([0])]));
}

// ------------------------------------------------------------ EIP-712

export interface TypedField {
  name: string;
  type: "string" | "bool" | "uint64" | "uint256" | "address" | "bytes32";
}

export interface TypedData {
  domain: { name: string; version: string; chainId: number; verifyingContract: string };
  types: Record<string, TypedField[]>;
  primaryType: string;
  message: Record<string, string | number | boolean>;
}

const DOMAIN_FIELDS: TypedField[] = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];

function word(type: TypedField["type"], v: string | number | boolean): Uint8Array {
  const out = new Uint8Array(32);
  switch (type) {
    case "string":
      return keccak_256(utf8ToBytes(String(v)));
    case "bool":
      out[31] = v ? 1 : 0;
      return out;
    case "uint64":
    case "uint256": {
      let n = BigInt(v as number);
      for (let i = 31; i >= 0 && n > 0n; i--) {
        out[i] = Number(n & 0xffn);
        n >>= 8n;
      }
      return out;
    }
    case "address": {
      const b = hexToBytes(String(v).replace(/^0x/, "").padStart(40, "0"));
      if (b.length !== 20) throw new Error(`bad address ${v}`);
      out.set(b, 12);
      return out;
    }
    case "bytes32": {
      const b = hexToBytes(String(v).replace(/^0x/, ""));
      if (b.length !== 32) throw new Error("bytes32 must be 32 bytes");
      return b;
    }
  }
}

function structHash(name: string, fields: TypedField[], values: Record<string, string | number | boolean>): Uint8Array {
  const typeString = `${name}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`;
  return keccak_256(concat([keccak_256(utf8ToBytes(typeString)), ...fields.map((f) => word(f.type, values[f.name]))]));
}

/** The 32-byte digest an EIP-712 signer signs. */
export function typedDataDigest(td: TypedData): Uint8Array {
  const domain = structHash("EIP712Domain", DOMAIN_FIELDS, td.domain);
  const msg = structHash(td.primaryType, td.types[td.primaryType], td.message);
  return keccak_256(concat([new Uint8Array([0x19, 0x01]), domain, msg]));
}

/** The JSON form OutLayer's sign-typed-data takes (the eth_signTypedData version 4 shape). */
export function typedDataJson(td: TypedData) {
  return { types: { EIP712Domain: DOMAIN_FIELDS, ...td.types }, primaryType: td.primaryType, domain: td.domain, message: td.message };
}

/** Typed data for an L1 action (orders, leverage): Agent(source "a", connectionId = action hash). */
export function l1TypedData(action: Value, nonce: number): TypedData {
  return {
    domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: ZERO_ADDRESS },
    types: { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] },
    primaryType: "Agent",
    message: { source: "a", connectionId: "0x" + bytesToHex(actionHash(action, nonce)) },
  };
}

function userSigned(name: string, fields: TypedField[], message: Record<string, string | number | boolean>): TypedData {
  return {
    domain: { name: "HyperliquidSignTransaction", version: "1", chainId: SIGNATURE_CHAIN_ID, verifyingContract: ZERO_ADDRESS },
    types: { [`HyperliquidTransaction:${name}`]: fields },
    primaryType: `HyperliquidTransaction:${name}`,
    message,
  };
}

/** Move USDC between perp and spot. toPerp false moves perp → spot. */
export function usdClassTransfer(amount: string, toPerp: boolean, nonce: number) {
  const action = { type: "usdClassTransfer", hyperliquidChain: "Mainnet", signatureChainId: SIGNATURE_CHAIN_HEX, amount, toPerp, nonce };
  const typed = userSigned(
    "UsdClassTransfer",
    [
      { name: "hyperliquidChain", type: "string" },
      { name: "amount", type: "string" },
      { name: "toPerp", type: "bool" },
      { name: "nonce", type: "uint64" },
    ],
    { hyperliquidChain: "Mainnet", amount, toPerp, nonce },
  );
  return { action, typed, nonce };
}

/** Send a spot token (USDC by default) to another address. */
export function spotSend(destination: string, amount: string, time: number, token = USDC_SPOT_TOKEN) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(destination)) throw new Error("destination must be a 0x address");
  const dest = destination.toLowerCase();
  const action = { type: "spotSend", hyperliquidChain: "Mainnet", signatureChainId: SIGNATURE_CHAIN_HEX, destination: dest, token, amount, time };
  const typed = userSigned(
    "SpotSend",
    [
      { name: "hyperliquidChain", type: "string" },
      { name: "destination", type: "string" },
      { name: "token", type: "string" },
      { name: "amount", type: "string" },
      { name: "time", type: "uint64" },
    ],
    { hyperliquidChain: "Mainnet", destination: dest, token, amount, time },
  );
  return { action, typed, nonce: time };
}

/** approveBuilderFee, as the guard signs it. */
export function approveBuilderFee(maxFeeRate: string, builder: string, nonce: number) {
  const action = { type: "approveBuilderFee", hyperliquidChain: "Mainnet", signatureChainId: SIGNATURE_CHAIN_HEX, maxFeeRate, builder: builder.toLowerCase(), nonce };
  const typed = userSigned(
    "ApproveBuilderFee",
    [
      { name: "hyperliquidChain", type: "string" },
      { name: "maxFeeRate", type: "string" },
      { name: "builder", type: "address" },
      { name: "nonce", type: "uint64" },
    ],
    { hyperliquidChain: "Mainnet", maxFeeRate, builder: builder.toLowerCase(), nonce },
  );
  return { action, typed, nonce };
}

// ------------------------------------------------------------ signatures and posting

export interface HlSignature {
  r: string;
  s: string;
  v: number;
}

/** "0x" + r(64 hex) + s(64 hex) + v(2 hex) → { r, s, v } with v 27 or 28. */
export function splitSignature(sig: string): HlSignature {
  const m = /^0x([0-9a-fA-F]{64})([0-9a-fA-F]{64})([0-9a-fA-F]{2})$/.exec(sig);
  if (!m) throw new Error("signature must be 0x + 130 hex characters");
  let v = parseInt(m[3], 16);
  if (v < 27) v += 27;
  if (v !== 27 && v !== 28) throw new Error(`signature v ${v} is not 27 or 28`);
  return { r: "0x" + m[1].toLowerCase(), s: "0x" + m[2].toLowerCase(), v };
}

/** The body posted to /exchange. vaultAddress is sent (null) only for L1 actions. */
export function exchangeBody(action: Value, nonce: number, signature: HlSignature, l1: boolean) {
  return l1 ? { action, nonce, signature, vaultAddress: null } : { action, nonce, signature };
}
