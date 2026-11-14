import { describe, expect, it } from "vitest";
import { isCiphertext, modelKey, readAdvice, stopPrompt, type Candle } from "../lib/privateai";

const candles: Candle[] = Array.from({ length: 24 }, (_, i) => ({ t: i * 300_000, o: 3000 + i, h: 3010 + i, l: 2990 + i, c: 3001 + i }));
const CHOICES = [0.01, 0.02, 0.03] as const;

describe("private AI stop adviser", () => {
  it("asks about the position with the browser's own prices and the offered choices", () => {
    const { system, user } = stopPrompt({ coin: "ETH", side: "long", sizeUsd: 15, leverage: 2, choices: CHOICES, candles });
    expect(system).toContain("Pick exactly one of the stop distances offered");
    expect(user).toContain("long ETH, about $15.00 at 2x leverage, opening now near 3024");
    expect(user).toContain("0.01 (1%), 0.02 (2%), 0.03 (3%)");
    expect(user).toContain("high 3033, low 2990");
  });

  it("refuses to ask with too few prices", () => {
    expect(() => stopPrompt({ coin: "ETH", side: "long", sizeUsd: 15, leverage: 2, choices: CHOICES, candles: candles.slice(0, 3) })).toThrow();
  });

  it("keeps only an offered distance from the answer", () => {
    expect(readAdvice('{"distance": 0.02, "why": "Two percent clears the usual swings."}', CHOICES)).toEqual({ distance: 0.02, why: "Two percent clears the usual swings." });
    expect(readAdvice('Here you go: {"distance":0.03,"why":"wide"} done', CHOICES).distance).toBe(0.03);
    expect(() => readAdvice('{"distance": 0.05, "why": "x"}', CHOICES)).toThrow("not offered");
    expect(() => readAdvice("no json here", CHOICES)).toThrow();
  });

  it("only sends a body whose every message is hex ciphertext", () => {
    const hex = "04" + "ab".repeat(120);
    expect(isCiphertext(JSON.stringify({ model: "m", messages: [{ role: "system", content: hex }, { role: "user", content: hex }] }))).toBe(true);
    expect(isCiphertext(JSON.stringify({ model: "m", messages: [{ role: "user", content: "long ETH, my stop is 2950" }] }))).toBe(false);
    expect(isCiphertext(JSON.stringify({ model: "m", messages: [{ role: "user", content: hex }, { role: "user", content: "plain" }] }))).toBe(false);
    expect(isCiphertext("not json")).toBe(false);
  });

  it("reads the ECDSA model key from NEAR AI's attestation report", async () => {
    const f = (async (url: string) => {
      expect(url).toBe("https://cloud-api.near.ai/v1/attestation/report?model=Qwen%2FQwen3.6-35B-A3B-FP8&signing_algo=ecdsa");
      return new Response(JSON.stringify({ model_attestations: [{ signing_algo: "ed25519", signing_public_key: "aa" }, { signing_algo: "ecdsa", signing_public_key: "04" + "cd".repeat(64) }] }));
    }) as unknown as typeof fetch;
    expect(await modelKey(f)).toEqual({ signingAlgo: "ecdsa", publicKey: "04" + "cd".repeat(64) });
  });
});
