// The sealed box of box.ts, for browsers: no Node modules, only @noble and crypto.getRandomValues.
// Same construction, so the guard opens it exactly like box.ts output:
// ephemeral X25519 key, key = sha256("unhuntable-box-v1" || shared || epk || gpk),
// ChaCha20-Poly1305 with a random 12-byte nonce, the 16-byte tag at the end of the ciphertext.
import { chacha20poly1305 } from "@noble/ciphers/chacha";
import { x25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";

export const BOX_TAG = "unhuntable-box-v1";
/** Additional data on every sealed guard call. */
export const CALL_AAD = "unhuntable-call-v1";

export interface Box {
  epk: string;
  nonce: string;
  ct: string;
}

/** Source of random bytes. Only tests replace it. */
export type RandomSource = (n: number) => Uint8Array;

export const browserRandom: RandomSource = (n) => crypto.getRandomValues(new Uint8Array(n));

function hex32(name: string, h: string): Uint8Array {
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new TypeError(`${name} must be 32 bytes of hex`);
  return hexToBytes(h.toLowerCase());
}

/** The ChaCha20-Poly1305 key both sides compute. */
export function boxKey(shared: Uint8Array, epk: Uint8Array, gpk: Uint8Array): Uint8Array {
  return sha256(concatBytes(utf8ToBytes(BOX_TAG), shared, epk, gpk));
}

/** Encrypt bytes to a box public key with the given aad. */
export function boxSeal(gpkHex: string, plaintext: Uint8Array, aad: string, random: RandomSource = browserRandom): Box {
  const gpk = hex32("box public key", gpkHex);
  const esk = random(32);
  if (esk.length !== 32) throw new Error("key length");
  const epk = x25519.getPublicKey(esk);
  const shared = x25519.getSharedSecret(esk, gpk);
  const nonce = random(12);
  if (nonce.length !== 12) throw new Error("nonce length");
  const ct = chacha20poly1305(boxKey(shared, epk, gpk), nonce, utf8ToBytes(aad)).encrypt(plaintext);
  return { epk: bytesToHex(epk), nonce: bytesToHex(nonce), ct: bytesToHex(ct) };
}

/**
 * Wrap one guard call: adds a random 32-byte hex "salt" to the inner JSON and seals it
 * with aad "unhuntable-call-v1". The result is the whole guard input.
 */
export function sealCall(boxPubHex: string, inner: Record<string, unknown>, random: RandomSource = browserRandom): { box: Box } {
  const gpk = bytesToHex(hex32("box public key", boxPubHex));
  const salt = bytesToHex(random(32));
  const pt = utf8ToBytes(JSON.stringify({ ...inner, salt }));
  return { box: boxSeal(gpk, pt, CALL_AAD, random) };
}
