// Private AI stop adviser, the browser half.
//
// The question (market, side, size, price and the stop choices) is put together here, from
// prices this browser reads from Hyperliquid itself, and encrypted here to the attested key of
// NEAR AI's model, which this browser fetches from NEAR AI's own attestation endpoint. Our
// server only forwards the ciphertext with our NEAR AI key (server/src/privateai.ts). The
// answer comes back encrypted to a key made in this browser for this one question.
import type { Side } from "./types";

export const PRIVATE_AI_MODEL = "Qwen/Qwen3.6-35B-A3B-FP8";
export const NEARAI_URL = "https://cloud-api.near.ai/v1";
const HL_INFO = "https://api.hyperliquid.xyz/info";

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface StopQuestion {
  coin: string;
  side: Side;
  sizeUsd: number;
  leverage: number;
  /** Stop distances the trader can pick, as fractions of the entry price. */
  choices: readonly number[];
  candles: Candle[];
}

export interface StopAdvice {
  distance: number;
  why: string;
}

export interface Receipt {
  what: string;
  request: string;
  response: string;
  proof: {
    model: string;
    chatId: string;
    requestSha256: string;
    responseSha256: string;
    signed: { text: string; signature: string; signingAddress: string } | null;
    checks: { hashesMatch: boolean; signatureValid: boolean; inAttestation: boolean };
  };
}

export interface AdviceResult {
  advice: StopAdvice;
  receipt: Receipt;
  /** What our server was sent, to show that it is ciphertext. */
  sentPreview: string;
}

/** The last two hours of five-minute candles, read by this browser from Hyperliquid's public API. */
export async function recentCandles(coin: string, now = Date.now(), f: typeof fetch = fetch): Promise<Candle[]> {
  const res = await f(HL_INFO, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "candleSnapshot", req: { coin, interval: "5m", startTime: now - 2 * 60 * 60_000, endTime: now } }),
  });
  if (!res.ok) throw new Error("Hyperliquid did not answer. Try again in a moment.");
  const rows = (await res.json()) as { t: number; o: string; h: string; l: string; c: string }[];
  return rows.map((k) => ({ t: k.t, o: Number(k.o), h: Number(k.h), l: Number(k.l), c: Number(k.c) })).filter((k) => k.c > 0);
}

const pct = (d: number) => `${Math.round(d * 1000) / 10}%`;

/** The system prompt and the question, in plain words. Only this browser and the enclave read them. */
export function stopPrompt(q: StopQuestion): { system: string; user: string } {
  if (q.candles.length < 6) throw new Error("Not enough recent prices to ask about.");
  const last = q.candles[q.candles.length - 1];
  const hi = Math.max(...q.candles.map((k) => k.h));
  const lo = Math.min(...q.candles.map((k) => k.l));
  const ranges = q.candles.map((k) => (k.h - k.l) / k.c);
  const avgRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;
  const system = [
    "You advise one trader on where to place a stop-loss for one perpetual futures position.",
    "Pick exactly one of the stop distances offered. Weigh normal price noise (a stop too close is hit by noise) against the loss if it is hit.",
    'Answer with JSON only: {"distance": <one of the offered numbers>, "why": "<one or two plain sentences>"}.',
  ].join(" ");
  const user = [
    `Position: ${q.side} ${q.coin}, about $${q.sizeUsd.toFixed(2)} at ${q.leverage}x leverage, opening now near ${last.c}.`,
    `Stop distances offered: ${q.choices.map((d) => `${d} (${pct(d)})`).join(", ")}.`,
    `Last 2 hours, 5-minute candles: high ${hi}, low ${lo}, average candle range ${pct(avgRange)}.`,
    `Closes, oldest first: ${q.candles.map((k) => k.c).join(", ")}.`,
  ].join("\n");
  return { system, user };
}

/** Reads the model's JSON answer and keeps only an offered distance. */
export function readAdvice(content: string, choices: readonly number[]): StopAdvice {
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("The private AI did not give a clear answer. Ask again.");
  let j: any;
  try {
    j = JSON.parse(m[0]);
  } catch {
    throw new Error("The private AI did not give a clear answer. Ask again.");
  }
  const d = Number(j?.distance);
  const pick = choices.find((c) => Math.abs(c - d) < 1e-9);
  if (pick === undefined) throw new Error("The private AI picked a distance that is not offered. Ask again.");
  const why = typeof j?.why === "string" ? j.why.trim().slice(0, 400) : "";
  return { distance: pick, why };
}

/** The model's ECDSA E2EE key, fetched by this browser from NEAR AI's attestation endpoint. */
export async function modelKey(f: typeof fetch = fetch): Promise<{ signingAlgo: "ecdsa"; publicKey: string }> {
  const res = await f(`${NEARAI_URL}/attestation/report?model=${encodeURIComponent(PRIVATE_AI_MODEL)}&signing_algo=ecdsa`);
  if (!res.ok) throw new Error("NEAR AI's attestation did not answer. Try again in a moment.");
  const r = (await res.json()) as { model_attestations?: { signing_algo?: string; signing_public_key?: string }[] };
  const a = (r.model_attestations ?? []).find((x) => x.signing_algo === "ecdsa" && typeof x.signing_public_key === "string");
  if (!a?.signing_public_key || !/^[0-9a-f]+$/i.test(a.signing_public_key)) throw new Error("NEAR AI's attestation has no model key.");
  return { signingAlgo: "ecdsa", publicKey: a.signing_public_key };
}

/** True when every message in a chat request body is hex ciphertext, as the relay requires. */
export function isCiphertext(body: string): boolean {
  try {
    const j = JSON.parse(body) as { messages?: { content?: unknown }[] };
    return Array.isArray(j.messages) && j.messages.length > 0 && j.messages.every((m) => typeof m.content === "string" && m.content.length >= 188 && /^[0-9a-f]+$/i.test(m.content));
  } catch {
    return false;
  }
}

/** Ask the private AI. `relay` is our server's URL for /api/private-ai. */
export async function askStop(q: StopQuestion, relay: string, f: typeof fetch = fetch): Promise<AdviceResult> {
  const { prepareE2eeChatRequest } = await import("@nearai/inference-sdk");
  const key = await modelKey(f);
  const { system, user } = stopPrompt(q);
  const plain = new Request(`${NEARAI_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: PRIVATE_AI_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: 3000,
    }),
  });
  const prepared = await prepareE2eeChatRequest({ request: plain, modelKey: key });
  const body = await prepared.request.clone().text();
  const headers: Record<string, string> = {};
  prepared.request.headers.forEach((v, k) => {
    if (k.startsWith("x-")) headers[k] = v;
  });
  if (!isCiphertext(body)) throw new Error("The question was not encrypted. Nothing was sent.");
  const res = await f(relay, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body, headers }), credentials: "include" });
  const out = (await res.json()) as { response?: string; proof?: Receipt["proof"]; message?: string };
  if (!res.ok || typeof out.response !== "string" || !out.proof) throw new Error(out.message ?? "The private AI did not answer. Try again in a minute.");
  const decrypted = await prepared.decryptResponse(new Response(out.response, { status: 200, headers: { "Content-Type": "application/json" } }));
  const j = (await decrypted.json()) as { choices?: { message?: { content?: string } }[] };
  const content = j.choices?.[0]?.message?.content ?? "";
  const advice = readAdvice(content, q.choices);
  return {
    advice,
    sentPreview: body.slice(0, 160),
    receipt: {
      what: "Private AI stop adviser: the exact encrypted request and response bytes our server forwarded, and NEAR AI Cloud's signature over them. Only the trader's browser and the model's enclave could read the question and the answer.",
      request: body,
      response: out.response,
      proof: out.proof,
    },
  };
}
