import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sdkVerifier } from "../src/nearai.js";

// Talks to NEAR AI Cloud and NVIDIA's attestation service. Run with LIVE_NEARAI=1.
const live = process.env.LIVE_NEARAI === "1";

describe.skipIf(!live)("NEAR AI enclave check, live", () => {
  it("verifies the enclave behind a mainnet hunt receipt with a fresh nonce", async () => {
    const r = JSON.parse(readFileSync(new URL("../../docs/proof/ai-hunt-mainnet.json", import.meta.url), "utf8"));
    const out = await sdkVerifier()(r.proof.model, r.request, r.response, r.proof.signed);
    expect(out).toMatchObject({ verified: true, tcbStatus: "UpToDate", gpu: "verified" });
    expect(out.signingAddress?.toLowerCase()).toBe(r.proof.signed.signingAddress.toLowerCase());
    expect(out.nonce).toMatch(/^[0-9a-f]{64}$/);
  }, 60_000);

  it("refuses the same receipt once its answer is changed", async () => {
    const r = JSON.parse(readFileSync(new URL("../../docs/proof/ai-hunt-mainnet.json", import.meta.url), "utf8"));
    const out = await sdkVerifier()(r.proof.model, r.request, r.response + " ", r.proof.signed);
    expect(out.verified).toBe(false);
  }, 60_000);
});
