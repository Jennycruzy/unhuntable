// Pieces whose Hyperliquid account is controlled by NEAR Chain Signatures, through the
// signer contract (signer/, deployed as unhuntable.near).
//
// Each such piece has its own ed25519 key, made from the user's 12 words. NEAR's MPC
// network derives the piece's Hyperliquid account from the contract's account and that
// key, so the account has no private key anywhere. The contract asks the MPC network to
// sign a Hyperliquid action only when the piece key signed that exact action with the
// piece's current counter.
//
// This module builds everything the browser, the server and the exit tool need: piece
// keys, the contract's borsh arguments, the exact text the piece key signs (checked here,
// never taken from a server), the Hyperliquid action to post, and the MPC answer turned
// into a Hyperliquid signature that is checked against the piece's account.
//
// Pure code: runs in Node and in browsers.
import { ed25519 } from "@noble/curves/ed25519";
import { secp256k1 } from "@noble/curves/secp256k1";
import { hmac } from "@noble/hashes/hmac";
import { keccak_256 } from "@noble/hashes/sha3";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import { base58 } from "@scure/base";
import { SIGNATURE_CHAIN_HEX, SIGNATURE_CHAIN_ID, ZERO_ADDRESS, typedDataDigest, type HlSignature, type TypedData, type TypedField } from "./hyperliquid.js";
import { keyFromSecret, type PiecesKey } from "./keys.js";

export const SIGNER_CONTRACT = "unhuntable.near";
export const MPC_SIGNER = "v1.signer";
export const MESSAGE_PREFIX = "unhuntable-hl-v1";
export const PATH_PREFIX = "u1/";
/** Gas the server attaches to `sign` (the contract needs at least 50 TGas). */
export const SIGN_GAS = "60000000000000";
/** Storage deposit attached to `add_piece`; the unused part comes back. */
export const ADD_PIECE_DEPOSIT = "10000000000000000000000";
export type HlChain = "Mainnet" | "Testnet";

/** Every action the contract signs. The order is the borsh tag and matches signer/src/hl.rs. */
export type ChainSigAction =
  | { kind: "approveAgent"; agentAddress: string; agentName: string; nonce: number }
  | { kind: "usdClassTransfer"; amount: string; toPerp: boolean; nonce: number }
  | { kind: "sendAsset"; destination: string; sourceDex: string; destinationDex: string; token: string; amount: string; nonce: number }
  | { kind: "withdraw"; destination: string; amount: string; time: number }
  | { kind: "spotSend"; destination: string; token: string; amount: string; time: number }
  | { kind: "usdSend"; destination: string; amount: string; time: number }
  | { kind: "approveBuilderFee"; maxFeeRate: string; builder: string; nonce: number };

/** The only builder fee the signer contract signs: one basis point (Hyperliquid allows up to 0.1% on perps). */
export const BUILDER_FEE_RATE = "0.01%";
/** The same fee in an order's builder field: tenths of a basis point. */
export const BUILDER_FEE_TENTHS_BP = 10;

const TAGS: Record<ChainSigAction["kind"], number> = { approveAgent: 0, usdClassTransfer: 1, sendAsset: 2, withdraw: 3, spotSend: 4, usdSend: 5, approveBuilderFee: 6 };

// ------------------------------------------------------------ piece keys

/** The ed25519 key of chain-signature piece n. Same 12 words, same key, forever. */
export function chainSigPieceKey(key: PiecesKey, n: number): PiecesKey {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("piece number must be a whole number from 0");
  return keyFromSecret(hmac(sha256, key.secret, utf8ToBytes(`chainsig:piece:${n}`)));
}

export function publicKeyHex(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new Error("piece key must be 32 bytes");
  return bytesToHex(publicKey);
}

/** "ed25519:<base58>" or 64 hex characters → the 32 key bytes. */
export function pieceKeyBytes(k: string): Uint8Array {
  if (/^[0-9a-f]{64}$/.test(k)) return hexToBytes(k);
  const m = /^ed25519:([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(k);
  if (!m) throw new Error("piece key must be ed25519:<base58> or 64 hex characters");
  const b = base58.decode(m[1]);
  if (b.length !== 32) throw new Error("piece key must be 32 bytes");
  return b;
}

/** The MPC path the contract uses for a piece key. */
export function mpcPath(publicKey: Uint8Array): string {
  return PATH_PREFIX + publicKeyHex(publicKey);
}

// ------------------------------------------------------------ checks (the contract makes the same ones)

const ADDRESS = /^0x[0-9a-f]{40}$/;
const AMOUNT = /^\d+(\.\d+)?$/;
const printable = (s: string) => /^[\x20-\x7e]*$/.test(s);

export function checkAction(a: ChainSigAction): void {
  const addr = (s: string) => {
    if (!ADDRESS.test(s)) throw new Error("address must be 0x and 40 lowercase hex characters");
  };
  const amount = (s: string) => {
    if (s.length > 24 || !AMOUNT.test(s)) throw new Error("amount must be a plain decimal like 12.5");
  };
  const u64 = (n: number) => {
    if (!Number.isSafeInteger(n) || n < 0) throw new Error("nonce or time must be a whole number");
  };
  switch (a.kind) {
    case "approveAgent":
      addr(a.agentAddress);
      if (a.agentName.length > 64 || !printable(a.agentName)) throw new Error("agent name must be at most 64 printable characters");
      return u64(a.nonce);
    case "usdClassTransfer":
      amount(a.amount);
      return u64(a.nonce);
    case "sendAsset":
      addr(a.destination);
      for (const d of [a.sourceDex, a.destinationDex]) if (!/^[0-9a-z]{0,16}$/.test(d)) throw new Error("market list name must be empty or up to 16 lowercase letters and digits");
      if (!a.token || a.token.length > 80 || !printable(a.token)) throw new Error("token must be 1 to 80 printable characters");
      amount(a.amount);
      return u64(a.nonce);
    case "withdraw":
    case "usdSend":
      addr(a.destination);
      amount(a.amount);
      return u64(a.time);
    case "spotSend":
      addr(a.destination);
      if (!a.token || a.token.length > 80 || !printable(a.token)) throw new Error("token must be 1 to 80 printable characters");
      amount(a.amount);
      return u64(a.time);
    case "approveBuilderFee":
      addr(a.builder);
      if (a.maxFeeRate !== BUILDER_FEE_RATE) throw new Error("the builder fee must be exactly 0.01%");
      return u64(a.nonce);
  }
}

// ------------------------------------------------------------ borsh

function cat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function u64(n: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return b;
}

function str(s: string): Uint8Array {
  const b = utf8ToBytes(s);
  return cat([u32(b.length), b]);
}

function bytes(b: Uint8Array): Uint8Array {
  return cat([u32(b.length), b]);
}

/** near_sdk::PublicKey in borsh: a Vec<u8> of 33 bytes (curve 0 = ed25519, then the key). */
export function borshPieceKey(publicKey: Uint8Array): Uint8Array {
  if (publicKey.length !== 32) throw new Error("piece key must be 32 bytes");
  return bytes(cat([new Uint8Array([0]), publicKey]));
}

export function borshAction(a: ChainSigAction): Uint8Array {
  checkAction(a);
  const tag = new Uint8Array([TAGS[a.kind]]);
  switch (a.kind) {
    case "approveAgent":
      return cat([tag, str(a.agentAddress), str(a.agentName), u64(a.nonce)]);
    case "usdClassTransfer":
      return cat([tag, str(a.amount), new Uint8Array([a.toPerp ? 1 : 0]), u64(a.nonce)]);
    case "sendAsset":
      return cat([tag, str(a.destination), str(a.sourceDex), str(a.destinationDex), str(a.token), str(a.amount), u64(a.nonce)]);
    case "withdraw":
    case "usdSend":
      return cat([tag, str(a.destination), str(a.amount), u64(a.time)]);
    case "spotSend":
      return cat([tag, str(a.destination), str(a.token), str(a.amount), u64(a.time)]);
    case "approveBuilderFee":
      return cat([tag, str(a.maxFeeRate), str(a.builder), u64(a.nonce)]);
  }
}

/** Arguments of `add_piece`, `counter` and `path`. */
export function pieceKeyArgs(publicKey: Uint8Array): Uint8Array {
  return borshPieceKey(publicKey);
}

/** Arguments of `message(piece_key, action)`. */
export function messageArgs(publicKey: Uint8Array, a: ChainSigAction): Uint8Array {
  return cat([borshPieceKey(publicKey), borshAction(a)]);
}

/** Arguments of `sign(piece_key, action, signature)`. */
export function signArgs(publicKey: Uint8Array, a: ChainSigAction, signature: Uint8Array): Uint8Array {
  if (signature.length !== 64) throw new Error("signature must be 64 bytes");
  return cat([borshPieceKey(publicKey), borshAction(a), bytes(signature)]);
}

/** A borsh Option<u64> answer (from `counter`): null when the piece is not registered. */
export function readCounter(answer: Uint8Array): number | null {
  if (answer.length === 1 && answer[0] === 0) return null;
  if (answer.length !== 9 || answer[0] !== 1) throw new Error("counter answer is not a borsh Option<u64>");
  const n = new DataView(answer.buffer, answer.byteOffset + 1, 8).getBigUint64(0, true);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("counter is too large");
  return Number(n);
}

/** The signer contract's `builder` answer, a borsh Option<(String, String)>: the builder address and rate, or null when fees are off. */
export function readBuilder(answer: Uint8Array): { builder: string; rate: string } | null {
  if (answer.length === 1 && answer[0] === 0) return null;
  if (answer[0] !== 1) throw new Error("answer is not a borsh Option");
  const dv = new DataView(answer.buffer, answer.byteOffset, answer.byteLength);
  const read = (at: number): [string, number] => {
    if (at + 4 > answer.length) throw new Error("answer is not a builder pair");
    const n = dv.getUint32(at, true);
    if (at + 4 + n > answer.length) throw new Error("answer is not a builder pair");
    return [new TextDecoder().decode(answer.subarray(at + 4, at + 4 + n)), at + 4 + n];
  };
  const [builder, next] = read(1);
  const [rate, end] = read(next);
  if (end !== answer.length || !ADDRESS.test(builder)) throw new Error("answer is not a builder pair");
  return { builder, rate };
}

/** A borsh String answer (from `path` and `message`). */
export function readString(answer: Uint8Array): string {
  if (answer.length < 4) throw new Error("answer is not a borsh string");
  const n = new DataView(answer.buffer, answer.byteOffset, 4).getUint32(0, true);
  if (answer.length !== 4 + n) throw new Error("answer is not a borsh string");
  return new TextDecoder().decode(answer.subarray(4));
}

// ------------------------------------------------------------ hashes, messages and signatures

function typedFor(a: ChainSigAction, chain: HlChain): TypedData {
  const f = (name: string, type: TypedField["type"]): TypedField => ({ name, type });
  const t = (name: string, fields: TypedField[], message: Record<string, string | number | boolean>): TypedData => ({
    domain: { name: "HyperliquidSignTransaction", version: "1", chainId: SIGNATURE_CHAIN_ID, verifyingContract: ZERO_ADDRESS },
    types: { [`HyperliquidTransaction:${name}`]: fields },
    primaryType: `HyperliquidTransaction:${name}`,
    message,
  });
  const c = f("hyperliquidChain", "string");
  switch (a.kind) {
    case "approveAgent":
      return t("ApproveAgent", [c, f("agentAddress", "address"), f("agentName", "string"), f("nonce", "uint64")], {
        hyperliquidChain: chain,
        agentAddress: a.agentAddress,
        agentName: a.agentName,
        nonce: a.nonce,
      });
    case "usdClassTransfer":
      return t("UsdClassTransfer", [c, f("amount", "string"), f("toPerp", "bool"), f("nonce", "uint64")], { hyperliquidChain: chain, amount: a.amount, toPerp: a.toPerp, nonce: a.nonce });
    case "sendAsset":
      return t(
        "SendAsset",
        [c, f("destination", "string"), f("sourceDex", "string"), f("destinationDex", "string"), f("token", "string"), f("amount", "string"), f("fromSubAccount", "string"), f("nonce", "uint64")],
        {
          hyperliquidChain: chain,
          destination: a.destination,
          sourceDex: a.sourceDex,
          destinationDex: a.destinationDex,
          token: a.token,
          amount: a.amount,
          fromSubAccount: "",
          nonce: a.nonce,
        },
      );
    case "withdraw":
      return t("Withdraw", [c, f("destination", "string"), f("amount", "string"), f("time", "uint64")], { hyperliquidChain: chain, destination: a.destination, amount: a.amount, time: a.time });
    case "spotSend":
      return t("SpotSend", [c, f("destination", "string"), f("token", "string"), f("amount", "string"), f("time", "uint64")], {
        hyperliquidChain: chain,
        destination: a.destination,
        token: a.token,
        amount: a.amount,
        time: a.time,
      });
    case "usdSend":
      return t("UsdSend", [c, f("destination", "string"), f("amount", "string"), f("time", "uint64")], { hyperliquidChain: chain, destination: a.destination, amount: a.amount, time: a.time });
    case "approveBuilderFee":
      return t("ApproveBuilderFee", [c, f("maxFeeRate", "string"), f("builder", "address"), f("nonce", "uint64")], {
        hyperliquidChain: chain,
        maxFeeRate: a.maxFeeRate,
        builder: a.builder,
        nonce: a.nonce,
      });
  }
}

/** The EIP-712 digest Hyperliquid recovers the signer from; the contract computes the same. */
export function actionDigest(a: ChainSigAction, chain: HlChain = "Mainnet"): Uint8Array {
  checkAction(a);
  return typedDataDigest(typedFor(a, chain));
}

/** The exact text the piece key signs: `unhuntable-hl-v1:<contract>:<key hex>:<counter>:<digest hex>`. */
export function chainSigMessage(contract: string, publicKey: Uint8Array, counter: number, a: ChainSigAction, chain: HlChain = "Mainnet"): string {
  if (!Number.isSafeInteger(counter) || counter < 0) throw new Error("counter must be a whole number");
  return `${MESSAGE_PREFIX}:${contract}:${publicKeyHex(publicKey)}:${counter}:${bytesToHex(actionDigest(a, chain))}`;
}

/** The piece key's ed25519 signature over that text (64 bytes). The secret never leaves this call. */
export function signPieceAction(piece: PiecesKey, contract: string, counter: number, a: ChainSigAction, chain: HlChain = "Mainnet"): Uint8Array {
  return ed25519.sign(utf8ToBytes(chainSigMessage(contract, piece.publicKey, counter, a, chain)), piece.secret);
}

export function verifyPieceAction(publicKey: Uint8Array, contract: string, counter: number, a: ChainSigAction, signature: Uint8Array, chain: HlChain = "Mainnet"): boolean {
  try {
    return ed25519.verify(signature, utf8ToBytes(chainSigMessage(contract, publicKey, counter, a, chain)), publicKey);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------ Hyperliquid side

/** The action object posted to Hyperliquid's /exchange, in the SDK's field order, and its nonce. */
export function hlAction(a: ChainSigAction, chain: HlChain = "Mainnet"): { action: Record<string, string | number | boolean>; nonce: number } {
  checkAction(a);
  const head = { hyperliquidChain: chain, signatureChainId: SIGNATURE_CHAIN_HEX };
  switch (a.kind) {
    case "approveAgent":
      return { action: { type: "approveAgent", ...head, agentAddress: a.agentAddress, agentName: a.agentName, nonce: a.nonce }, nonce: a.nonce };
    case "usdClassTransfer":
      return { action: { type: "usdClassTransfer", ...head, amount: a.amount, toPerp: a.toPerp, nonce: a.nonce }, nonce: a.nonce };
    case "sendAsset":
      return {
        action: {
          type: "sendAsset",
          ...head,
          destination: a.destination,
          sourceDex: a.sourceDex,
          destinationDex: a.destinationDex,
          token: a.token,
          amount: a.amount,
          fromSubAccount: "",
          nonce: a.nonce,
        },
        nonce: a.nonce,
      };
    case "withdraw":
      return { action: { type: "withdraw3", ...head, destination: a.destination, amount: a.amount, time: a.time }, nonce: a.time };
    case "spotSend":
      return { action: { type: "spotSend", ...head, destination: a.destination, token: a.token, amount: a.amount, time: a.time }, nonce: a.time };
    case "usdSend":
      return { action: { type: "usdSend", ...head, destination: a.destination, amount: a.amount, time: a.time }, nonce: a.time };
    case "approveBuilderFee":
      return { action: { type: "approveBuilderFee", ...head, maxFeeRate: a.maxFeeRate, builder: a.builder, nonce: a.nonce }, nonce: a.nonce };
  }
}

/** What v1.signer answers (the `sign` call's result). */
export interface MpcAnswer {
  scheme?: string;
  big_r: { affine_point: string };
  s: { scalar: string };
  recovery_id: number;
}

/** The MPC answer as a Hyperliquid signature { r, s, v }. */
export function mpcToHl(m: MpcAnswer): HlSignature {
  const R = m?.big_r?.affine_point;
  const S = m?.s?.scalar;
  if (typeof R !== "string" || !/^0[23][0-9a-fA-F]{64}$/.test(R)) throw new Error("MPC answer has no compressed R point");
  if (typeof S !== "string" || !/^[0-9a-fA-F]{64}$/.test(S)) throw new Error("MPC answer has no s scalar");
  if (m.recovery_id !== 0 && m.recovery_id !== 1) throw new Error("MPC recovery id must be 0 or 1");
  return { r: "0x" + R.slice(2).toLowerCase(), s: "0x" + S.toLowerCase(), v: 27 + m.recovery_id };
}

/** The Ethereum address of an uncompressed or compressed secp256k1 public key. */
export function ethAddress(publicKey: Uint8Array): string {
  const full = secp256k1.ProjectivePoint.fromHex(publicKey).toRawBytes(false);
  return "0x" + bytesToHex(keccak_256(full.subarray(1)).subarray(12));
}

/** v1.signer's derived_public_key answer ("secp256k1:<base58 of 64 bytes>") → the piece's Hyperliquid account. */
export function addressFromDerivedKey(derived: string): string {
  const m = /^secp256k1:([1-9A-HJ-NP-Za-km-z]+)$/.exec(derived);
  if (!m) throw new Error("derived key must be secp256k1:<base58>");
  const raw = base58.decode(m[1]);
  if (raw.length !== 64) throw new Error("derived key must be 64 bytes");
  return ethAddress(cat([new Uint8Array([4]), raw]));
}

/** The address that signed a digest. */
export function recoverSigner(digest: Uint8Array, sig: HlSignature): string {
  const s = secp256k1.Signature.fromCompact(sig.r.slice(2) + sig.s.slice(2)).addRecoveryBit(sig.v - 27);
  return ethAddress(s.recoverPublicKey(digest).toRawBytes(false));
}

/** The /exchange body for a chain-signature action, after checking the signature recovers to the piece's account. */
export function chainSigExchangeBody(a: ChainSigAction, m: MpcAnswer, account: string, chain: HlChain = "Mainnet") {
  const sig = mpcToHl(m);
  const who = recoverSigner(actionDigest(a, chain), sig);
  if (who !== account.toLowerCase()) throw new Error(`the signature is from ${who}, not the piece's account ${account.toLowerCase()}`);
  const { action, nonce } = hlAction(a, chain);
  return { action, nonce, signature: sig };
}
