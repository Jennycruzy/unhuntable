// Sealed box, the same construction the guard opens (guard/src/lib.rs box_open):
// ephemeral X25519 key, key = sha256("unhuntable-box-v1" || shared || epk || gpk),
// ChaCha20-Poly1305 with a random 12-byte nonce. The ciphertext carries the 16-byte tag at the end.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  randomBytes,
  type KeyObject,
} from "node:crypto";

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

const PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");

function hex32(name: string, h: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new TypeError(`${name} must be 32 bytes of hex`);
  return Buffer.from(h, "hex");
}

function privKey(raw: Uint8Array): KeyObject {
  return createPrivateKey({ key: Buffer.concat([PKCS8_X25519, raw]), format: "der", type: "pkcs8" });
}

function pubKey(raw: Uint8Array): KeyObject {
  return createPublicKey({ key: Buffer.concat([SPKI_X25519, raw]), format: "der", type: "spki" });
}

function rawPublic(k: KeyObject): Buffer {
  return k.export({ format: "der", type: "spki" }).subarray(SPKI_X25519.length);
}

/** X25519 public key (hex) for a 32-byte secret. */
export function boxPublic(secret: Uint8Array): string {
  return rawPublic(createPublicKey(privKey(secret))).toString("hex");
}

function boxKey(shared: Buffer, epk: Buffer, gpk: Buffer): Buffer {
  return createHash("sha256").update(BOX_TAG).update(shared).update(epk).update(gpk).digest();
}

/** Encrypt bytes to a box public key with the given aad. */
export function boxSeal(gpkHex: string, plaintext: Uint8Array, aad: string, random: RandomSource = randomBytes): Box {
  const gpk = hex32("box public key", gpkHex);
  const eskRaw = Buffer.from(random(32));
  const esk = privKey(eskRaw);
  const epk = rawPublic(createPublicKey(esk));
  const shared = diffieHellman({ privateKey: esk, publicKey: pubKey(gpk) });
  const nonce = Buffer.from(random(12));
  if (nonce.length !== 12) throw new Error("nonce length");
  const c = createCipheriv("chacha20-poly1305", boxKey(shared, epk, gpk), nonce, { authTagLength: 16 });
  c.setAAD(Buffer.from(aad), { plaintextLength: plaintext.length });
  const ct = Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
  return { epk: epk.toString("hex"), nonce: nonce.toString("hex"), ct: ct.toString("hex") };
}

/** Open a box with the guard-side secret. Throws if the aad or any byte is wrong. */
export function boxOpen(secret: Uint8Array, box: Box, aad: string): Buffer {
  const epk = hex32("epk", box.epk);
  const nonce = Buffer.from(box.nonce, "hex");
  if (nonce.length !== 12) throw new Error("nonce length");
  const ct = Buffer.from(box.ct, "hex");
  if (ct.length < 16) throw new Error("box does not open");
  const sk = privKey(secret);
  const gpk = rawPublic(createPublicKey(sk));
  const shared = diffieHellman({ privateKey: sk, publicKey: pubKey(epk) });
  const d = createDecipheriv("chacha20-poly1305", boxKey(shared, epk, gpk), nonce, { authTagLength: 16 });
  d.setAAD(Buffer.from(aad), { plaintextLength: ct.length - 16 });
  d.setAuthTag(ct.subarray(ct.length - 16));
  try {
    return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  } catch {
    throw new Error("box does not open");
  }
}

/**
 * Wrap one guard call: adds a random 32-byte hex "salt" to the inner JSON and seals it
 * with aad "unhuntable-call-v1". The result is the whole guard input.
 */
export function sealedBox(
  guardBoxPubHex: string,
  inner: Record<string, unknown>,
  random: RandomSource = randomBytes,
): { box: Box } {
  const gpk = hex32("box public key", guardBoxPubHex).toString("hex");
  const salt = Buffer.from(random(32)).toString("hex");
  const pt = Buffer.from(JSON.stringify({ ...inner, salt }));
  return { box: boxSeal(gpk, pt, CALL_AAD, random) };
}
