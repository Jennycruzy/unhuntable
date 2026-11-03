import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CALL_AAD, boxOpen, boxSeal, sealedBox } from "../src/box.js";
import { GuardClient } from "../src/client.js";
import { GUARD_PUB, GUARD_SECRET, PAYMENT_KEY, fakeFetch, fixedRandom } from "./helpers.js";

const guardTests = (name: string) => fileURLToPath(new URL(`../../guard/tests/${name}`, import.meta.url));

function flip(h: string, i: number): string {
  const b = Buffer.from(h, "hex");
  b[i] ^= 1;
  return b.toString("hex");
}

describe("box from the Python reference", () => {
  const ref = JSON.parse(readFileSync(guardTests("ref3.json"), "utf8")).box;

  it("uses the same guard key", () => {
    expect(GUARD_PUB).toBe(ref.gpk);
  });

  it("opens with aad a", () => {
    expect(boxOpen(GUARD_SECRET, ref, "a").toString()).toBe(ref.pt);
  });

  it("refuses a wrong aad", () => {
    expect(() => boxOpen(GUARD_SECRET, ref, "b")).toThrow("box does not open");
    expect(() => boxOpen(GUARD_SECRET, ref, CALL_AAD)).toThrow("box does not open");
  });

  it("refuses one flipped byte anywhere", () => {
    expect(() => boxOpen(GUARD_SECRET, { ...ref, ct: flip(ref.ct, 0) }, "a")).toThrow();
    expect(() => boxOpen(GUARD_SECRET, { ...ref, ct: flip(ref.ct, ref.ct.length / 2 - 1) }, "a")).toThrow();
    expect(() => boxOpen(GUARD_SECRET, { ...ref, nonce: flip(ref.nonce, 0) }, "a")).toThrow();
    expect(() => boxOpen(GUARD_SECRET, { ...ref, epk: flip(ref.epk, 0) }, "a")).toThrow();
  });
});

describe("sealedBox", () => {
  it("round-trips and adds a fresh 32-byte salt each time", () => {
    const a = sealedBox(GUARD_PUB, { op: "agent", shard: "alpha" });
    const b = sealedBox(GUARD_PUB, { op: "agent", shard: "alpha" });
    expect(Object.keys(a)).toEqual(["box"]);
    expect(Object.keys(a.box).sort()).toEqual(["ct", "epk", "nonce"]);
    const ia = JSON.parse(boxOpen(GUARD_SECRET, a.box, CALL_AAD).toString());
    const ib = JSON.parse(boxOpen(GUARD_SECRET, b.box, CALL_AAD).toString());
    expect(ia.op).toBe("agent");
    expect(ia.shard).toBe("alpha");
    expect(ia.salt).toMatch(/^[0-9a-f]{64}$/);
    expect(ia.salt).not.toBe(ib.salt);
    expect(a.box.epk).not.toBe(b.box.epk);
    expect(a.box.nonce).toMatch(/^[0-9a-f]{24}$/);
  });

  it("does not open with the shard as aad", () => {
    const { box } = sealedBox(GUARD_PUB, { op: "agent", shard: "alpha" });
    expect(() => boxOpen(GUARD_SECRET, box, "alpha")).toThrow();
  });

  it("refuses a bad box public key", () => {
    expect(() => sealedBox("abcd", { op: "agent" })).toThrow("32 bytes of hex");
    expect(() => boxSeal("zz".repeat(32), Buffer.from("x"), CALL_AAD)).toThrow();
  });
});

describe("vector for the guard's Rust test", () => {
  // Set WRITE_VECTOR=1 to rewrite guard/tests/ref_ts_box.json; otherwise the file must match.
  it("matches guard/tests/ref_ts_box.json", async () => {
    const stop = { coin: "ETH", side: "long", trigger: 2100.5, size: 0.0045 } as const;
    const { fetch, sent } = fakeFetch([{ body: { output: { sealed: true } } }]);
    const random = fixedRandom([Buffer.alloc(32, 0x11), Buffer.alloc(32, 0x22), Buffer.alloc(12, 0x11)]);
    const c = new GuardClient({ owner: "o", project: "guard", paymentKey: PAYMENT_KEY, boxPub: GUARD_PUB, fetch, random });
    await c.seal({ shard: "alpha", stop });
    const box = sent[0].body.input.box;
    const pt = boxOpen(GUARD_SECRET, box, CALL_AAD).toString();
    const vector = { gpk: GUARD_PUB, ...box, aad: CALL_AAD, pt, shard: "alpha", stop };
    const path = guardTests("ref_ts_box.json");
    const text = JSON.stringify(vector, null, 1) + "\n";
    if (process.env.WRITE_VECTOR) writeFileSync(path, text);
    expect(readFileSync(path, "utf8")).toBe(text);
  });
});
