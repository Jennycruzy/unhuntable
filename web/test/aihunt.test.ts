import { describe, expect, it } from "vitest";
import { againstChance, guessLine, headline, proofLine } from "../lib/aihunt";
import type { AiHunt, AiHuntProof, AiHuntScore } from "../lib/types";

const score = (over: Partial<AiHuntScore> = {}): AiHuntScore => ({ verdict: "held", found: 0, pieces: 2, wrong: 0, lineup: 15, chanceHits: 0, ...over });
const proof = (checks: Partial<AiHuntProof["checks"]> = {}, signed = true): AiHuntProof => ({
  model: "m",
  chatId: "c",
  requestSha256: "a",
  responseSha256: "b",
  signed: signed ? { text: "t", signature: "s", signingAddress: "0x1" } : null,
  checks: { hashesMatch: true, signatureValid: true, inAttestation: true, ...checks },
});

describe("NEAR AI hunter words", () => {
  it("says held, partly found or caught from the score alone", () => {
    expect(headline(score())).toBe("Held. It did not find your 2 other pieces.");
    expect(headline(score({ found: 1, wrong: 3 }))).toBe("Held. It named 1 of your pieces, but more strangers than pieces.");
    expect(headline(score({ verdict: "partly", found: 1 }))).toBe("Partly found. It named 1 of your 2 other pieces.");
    expect(headline(score({ verdict: "caught", found: 1, pieces: 1 }))).toBe("Caught. It named all 1 other piece of this position.");
  });

  it("compares the names with a random pick of the same size", () => {
    expect(againstChance(score())).toBe("It named none of the 15 accounts.");
    expect(againstChance(score({ found: 2, wrong: 1, chanceHits: 0.4 }))).toBe("It named 3 of 15 accounts and 2 were yours. Naming 3 at random would find 0.4 on average.");
  });

  it("says which part of the enclave check did not hold", () => {
    expect(proofLine(proof())).toBe("Signed inside NEAR AI's TEE: the question and answer are exactly what the model saw and said.");
    expect(proofLine(proof({ hashesMatch: false, inAttestation: false }))).toBe("The signature check did not hold for the hashes, the attestation.");
    expect(proofLine(proof({ signatureValid: false }, false))).toBe("NEAR AI did not return a signature for this answer.");
  });

  it("names the fresh-nonce enclave check when it held, and its reason when it did not", () => {
    const enclave = { nonce: "ab", verified: true, tcbStatus: "UpToDate", gpu: "verified", signingAddress: "0x1", checkedMs: 1 };
    expect(proofLine({ ...proof(), enclave })).toBe(
      "Signed inside NEAR AI's TEE: the question and answer are exactly what the model saw and said. Its enclave was verified for this answer with a fresh nonce: Intel TDX quote up to date, NVIDIA GPU evidence verified, signing key bound in the quote.",
    );
    const failed = { ...enclave, verified: false, tcbStatus: null, gpu: null, signingAddress: null, reason: "tdx.tcb_out_of_date" };
    expect(proofLine({ ...proof({ inAttestation: false }), enclave: failed })).toBe("The signature check did not hold for the attestation. The enclave check said: tdx.tcb_out_of_date");
  });

  it("reads the hunter's guess of the whole position", () => {
    const h = (combined: { side: string | null; usd: number | null }) => ({ answer: { combined } }) as unknown as AiHunt;
    expect(guessLine(h({ side: "long", usd: 301.4 }))).toBe("Long, about $301.");
    expect(guessLine(h({ side: "short", usd: null }))).toBe("Short, size unknown.");
    expect(guessLine(h({ side: null, usd: 0 }))).toBe("It could not say what the whole position is.");
  });
});
