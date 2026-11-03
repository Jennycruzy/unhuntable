import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chacha20poly1305 } from "@noble/ciphers/chacha";
import { x25519 } from "@noble/curves/ed25519";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import { describe, expect, it } from "vitest";
import { boxOpen, sealedBox, type Box } from "../src/box.js";
import { CALL_AAD, boxKey, boxSeal, sealCall } from "../src/box-browser.js";
import { GUARD_PUB, GUARD_SECRET, fixedRandom } from "./helpers.js";

const vector = JSON.parse(readFileSync(fileURLToPath(new URL("../../guard/tests/ref_ts_box.json", import.meta.url)), "utf8"));

/** Opens a box with the browser primitives, the way the guard does. Test only. */
function browserOpen(secret: Uint8Array, box: Box, aad: string): string {
  const epk = hexToBytes(box.epk);
  const gpk = x25519.getPublicKey(secret);
  const shared = x25519.getSharedSecret(secret, epk);
  const pt = chacha20poly1305(boxKey(shared, epk, gpk), hexToBytes(box.nonce), utf8ToBytes(aad)).decrypt(hexToBytes(box.ct));
  return new TextDecoder().decode(pt);
}

describe("browser sealed box", () => {
  it("makes the guard's reference box from the same random bytes", () => {
    const random = fixedRandom([Buffer.alloc(32, 0x11), Buffer.alloc(32, 0x22), Buffer.alloc(12, 0x11)]);
    const out = sealCall(vector.gpk, { op: "seal", shard: vector.shard, stop: vector.stop }, random);
    expect(Object.keys(out)).toEqual(["box"]);
    expect(out.box).toEqual({ epk: vector.epk, nonce: vector.nonce, ct: vector.ct });
  });

  it("is opened by box.ts", () => {
    const { box } = sealCall(GUARD_PUB, { op: "seal_tp", shard: "alpha", tp: { coin: "BTC", side: "short", trigger: 90000, size: 0.001 } });
    const inner = JSON.parse(boxOpen(GUARD_SECRET, box, CALL_AAD).toString());
    expect(inner.op).toBe("seal_tp");
    expect(inner.tp.trigger).toBe(90000);
    expect(inner.salt).toMatch(/^[0-9a-f]{64}$/);
  });

  it("opens a box made by box.ts", () => {
    const { box } = sealedBox(GUARD_PUB, { op: "seal", shard: "beta" });
    const inner = JSON.parse(browserOpen(GUARD_SECRET, box, CALL_AAD));
    expect(inner.op).toBe("seal");
    expect(inner.shard).toBe("beta");
  });

  it("uses a fresh key, nonce and salt each time", () => {
    const a = sealCall(GUARD_PUB, { op: "seal" });
    const b = sealCall(GUARD_PUB, { op: "seal" });
    expect(a.box.epk).not.toBe(b.box.epk);
    expect(a.box.nonce).toMatch(/^[0-9a-f]{24}$/);
    expect(JSON.parse(browserOpen(GUARD_SECRET, a.box, CALL_AAD)).salt).not.toBe(JSON.parse(browserOpen(GUARD_SECRET, b.box, CALL_AAD)).salt);
  });

  it("does not open with another aad and refuses a bad key", () => {
    const box = boxSeal(GUARD_PUB, utf8ToBytes("x"), "a");
    expect(() => boxOpen(GUARD_SECRET, box, CALL_AAD)).toThrow();
    expect(bytesToHex(utf8ToBytes(browserOpen(GUARD_SECRET, box, "a")))).toBe("78");
    expect(() => sealCall("abcd", { op: "seal" })).toThrow("32 bytes of hex");
  });
});
