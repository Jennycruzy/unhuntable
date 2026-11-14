import { describe, expect, it } from "vitest";
import { PASS_HEADERS, PRIVATE_AI_PER_IP_PER_HOUR, PrivateAi, checkEncrypted } from "../src/privateai.js";
import { ApiError } from "../src/refusals.js";

const MODEL = "Qwen/Qwen3.6-35B-A3B-FP8";
const CIPHER = "04" + "ab".repeat(200);
const HEADERS = {
  "x-signing-algo": "ecdsa",
  "x-client-pub-key": "cd".repeat(64),
  "x-model-pub-key": "ef".repeat(64),
  "x-encryption-version": "3",
  "x-encrypt-all-fields": "true",
};
const body = (over: Record<string, unknown> = {}) => JSON.stringify({ model: MODEL, messages: [{ role: "system", content: CIPHER }, { role: "user", content: CIPHER }], max_tokens: 2000, ...over });
const refused = (input: unknown) => {
  try {
    checkEncrypted(input, MODEL);
  } catch (e) {
    if (e instanceof ApiError) return e.code;
    throw e;
  }
  return "passed";
};

describe("the private AI relay only forwards ciphertext", () => {
  it("passes an encrypted request and only the E2EE headers", () => {
    const r = checkEncrypted({ body: body(), headers: { ...HEADERS, cookie: "s=1", authorization: "Bearer theirs", "x-forwarded-for": "1.2.3.4" } }, MODEL);
    expect(r.body).toBe(body());
    expect(Object.keys(r.headers).sort()).toEqual(Object.keys(HEADERS).sort());
    for (const k of Object.keys(r.headers)) expect(PASS_HEADERS as readonly string[]).toContain(k);
  });

  it("refuses a question in plain words", () => {
    expect(refused({ body: body({ messages: [{ role: "user", content: "Long ETH at 2011, my stop is 1890. Is that good?" }] }), headers: HEADERS })).toBe("private_ai_refused");
  });

  it("refuses short or non-hex content, other fields, other roles and other models", () => {
    expect(refused({ body: body({ messages: [{ role: "user", content: "ab".repeat(20) }] }), headers: HEADERS })).toBe("private_ai_refused");
    expect(refused({ body: body({ messages: [{ role: "user", content: CIPHER, name: "x" }] }), headers: HEADERS })).toBe("private_ai_refused");
    expect(refused({ body: body({ messages: [{ role: "assistant", content: CIPHER }] }), headers: HEADERS })).toBe("private_ai_refused");
    expect(refused({ body: body({ tools: [] }), headers: HEADERS })).toBe("private_ai_refused");
    expect(refused({ body: body({ model: "openai/gpt-5" }), headers: HEADERS })).toBe("private_ai_refused");
    expect(refused({ body: body({ max_tokens: 100_000 }), headers: HEADERS })).toBe("private_ai_refused");
  });

  it("refuses a request without E2EE v3 headers", () => {
    expect(refused({ body: body(), headers: { ...HEADERS, "x-encryption-version": "2" } })).toBe("private_ai_refused");
    expect(refused({ body: body(), headers: { ...HEADERS, "x-signing-algo": "ed25519" } })).toBe("private_ai_refused");
    const { "x-model-pub-key": _, ...noKey } = HEADERS;
    expect(refused({ body: body(), headers: noKey })).toBe("private_ai_refused");
  });

  it("refuses a body that is too large or not JSON", () => {
    expect(refused({ body: "x".repeat(70_000), headers: HEADERS })).toBe("private_ai_refused");
    expect(refused({ body: "not json", headers: HEADERS })).toBe("private_ai_refused");
    expect(refused(null)).toBe("private_ai_refused");
  });
});

describe("relaying to NEAR AI", () => {
  const answer = JSON.stringify({ id: "chat-1", choices: [{ message: { role: "assistant", content: CIPHER } }] });
  function fake() {
    const calls: { url: string; init?: RequestInit }[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/chat/completions")) return new Response(answer, { status: 200 });
      if (url.includes("/signature/")) return new Response(JSON.stringify({ text: "t", signature: "0x00", signing_address: "0xabc" }));
      return new Response(JSON.stringify({ model_attestations: [{ signing_address: "0xabc" }] }));
    }) as unknown as typeof fetch;
    return { calls, f };
  }

  it("forwards the exact bytes with our key and returns the answer unchanged", async () => {
    const { calls, f } = fake();
    const ai = new PrivateAi("our-key", "https://nearai.test/v1", MODEL, () => 1_000, f);
    const out = await ai.relay("1.1.1.1", { body: body(), headers: { ...HEADERS, cookie: "s=1" } });
    expect(out.response).toBe(answer);
    expect(out.proof.chatId).toBe("chat-1");
    const chat = calls.find((c) => c.url.endsWith("/chat/completions"))!;
    expect(chat.init!.body).toBe(body());
    const sent = chat.init!.headers as Record<string, string>;
    expect(sent.Authorization).toBe("Bearer our-key");
    expect(sent.cookie).toBeUndefined();
    expect(sent["x-client-pub-key"]).toBe(HEADERS["x-client-pub-key"]);
    expect(calls.some((c) => c.url.includes("/signature/chat-1") && c.url.includes("signing_algo=ecdsa"))).toBe(true);
  });

  it("never calls NEAR AI for a refused request", async () => {
    const { calls, f } = fake();
    const ai = new PrivateAi("our-key", "https://nearai.test/v1", MODEL, () => 1_000, f);
    await expect(ai.relay("1.1.1.1", { body: body({ messages: [{ role: "user", content: "plain" }] }), headers: HEADERS })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("limits each visitor per hour", async () => {
    const { f } = fake();
    let t = 1_000;
    const ai = new PrivateAi("our-key", "https://nearai.test/v1", MODEL, () => t, f);
    for (let i = 0; i < PRIVATE_AI_PER_IP_PER_HOUR; i++) await ai.relay("2.2.2.2", { body: body(), headers: HEADERS });
    await expect(ai.relay("2.2.2.2", { body: body(), headers: HEADERS })).rejects.toMatchObject({ code: "private_ai_limit" });
    await ai.relay("3.3.3.3", { body: body(), headers: HEADERS });
    t += 61 * 60_000;
    await ai.relay("2.2.2.2", { body: body(), headers: HEADERS });
  });
});
