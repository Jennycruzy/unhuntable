import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as sdk from "@nearai/inference-sdk";
import { askStop, checkSignature, isCiphertext, readAdvice, stopPrompt, verifiedModel, type Candle } from "../lib/privateai";

// the receipt of the mainnet run in docs/private-ai.md: real bytes, NEAR AI's real signature
const receipt = JSON.parse(readFileSync(new URL("../../docs/proof/private-ai-mainnet.json", import.meta.url), "utf8")) as {
  request: string;
  response: string;
  proof: { signed: { text: string; signature: string; signingAddress: string } };
};
const enclave = { signer: { signingAlgo: "ecdsa" as const, signingAddress: receipt.proof.signed.signingAddress } };

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

  it("accepts NEAR AI's real signature over the exact bytes from the enclave that signed them", () => {
    expect(() => checkSignature(sdk, receipt.request, receipt.response, receipt.proof.signed, enclave)).not.toThrow();
  });

  it("refuses the answer when one byte of the response differs from what was signed", () => {
    const changed = receipt.response.replace(/"id":"(.)/, (_m, c: string) => `"id":"${c === "a" ? "b" : "a"}`);
    expect(changed).not.toBe(receipt.response);
    expect(() => checkSignature(sdk, receipt.request, changed, receipt.proof.signed, enclave)).toThrow("did not check out");
  });

  it("refuses the answer when one byte of the request differs from what was signed", () => {
    const changed = receipt.request.replace(/"content":"(..)/, (_m, c: string) => `"content":"${c === "04" ? "05" : "04"}`);
    expect(changed).not.toBe(receipt.request);
    expect(() => checkSignature(sdk, changed, receipt.response, receipt.proof.signed, enclave)).toThrow("did not check out");
  });

  it("refuses the answer when the signature is from a key other than the verified enclave's", () => {
    const other = { signer: { signingAlgo: "ecdsa" as const, signingAddress: "0x" + "11".repeat(20) } };
    expect(() => checkSignature(sdk, receipt.request, receipt.response, receipt.proof.signed, other)).toThrow("did not check out");
  });

  it("refuses the answer when the signature itself is altered", () => {
    const sig = receipt.proof.signed.signature;
    const bad = { ...receipt.proof.signed, signature: sig.slice(0, 10) + (sig[10] === "a" ? "b" : "a") + sig.slice(11) };
    expect(() => checkSignature(sdk, receipt.request, receipt.response, bad, enclave)).toThrow("did not check out");
  });

  it("refuses the answer when NEAR AI sent no signature", () => {
    expect(() => checkSignature(sdk, receipt.request, receipt.response, null, enclave)).toThrow("no signature");
  });

  it("sends nothing when the enclave's attestation does not verify", async () => {
    const asked: string[] = [];
    const f = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      asked.push(url);
      if (url.includes("/attestation/report")) {
        // a report whose quote and GPU evidence prove nothing
        return new Response(JSON.stringify({ model_attestations: [{ signing_algo: "ecdsa", signing_address: "0x" + "22".repeat(20), signing_public_key: "04" + "cd".repeat(64), intel_quote: "00", nvidia_payload: "{}", event_log: "[]", info: {} }] }), { headers: { "Content-Type": "application/json" } });
      }
      return new Response("{}", { status: 500 });
    }) as unknown as typeof fetch;
    await expect(verifiedModel(sdk, f)).rejects.toThrow(/nothing was sent/);
    const q = { coin: "ETH", side: "long" as const, sizeUsd: 15, leverage: 2, choices: [0.01, 0.02, 0.03] as const, candles: [] };
    await expect(askStop(q, "https://relay.test/api/private-ai", f)).rejects.toThrow(/nothing was sent/);
    expect(asked.some((u) => u.startsWith("https://relay.test"))).toBe(false);
  });
});
