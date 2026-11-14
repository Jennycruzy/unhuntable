// Private AI stop adviser: the relay.
//
// The browser encrypts its question to the attested key of NEAR AI's model (NEAR AI E2EE v3,
// ECDSA) and sends us only the encrypted request. We add our NEAR AI key and forward it,
// byte for byte. The answer comes back encrypted to a key only the browser holds.
//
// This route refuses anything that is not ciphertext, so it can never read a question and
// can never be used as a plain proxy for our key. It stores nothing and logs only sizes.
import { checkProof, sha256Hex, type Proof } from "./nearai.js";
import { ApiError } from "./refusals.js";

export const PRIVATE_AI_MAX_BODY = 64_000;
export const PRIVATE_AI_MAX_TOKENS = 4_000;
export const PRIVATE_AI_PER_IP_PER_HOUR = 20;
export const PRIVATE_AI_PER_DAY = 300;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const CHAT_TIMEOUT_MS = 90_000;

/** E2EE headers passed on to NEAR AI unchanged; nothing else from the browser is. */
export const PASS_HEADERS = ["x-signing-algo", "x-client-pub-key", "x-model-pub-key", "x-encryption-version", "x-encrypt-all-fields", "x-no-aliasing"] as const;
const BODY_KEYS = new Set(["model", "messages", "max_tokens"]);
const HEX = /^[0-9a-f]+$/i;
// one ECDSA envelope: 65-byte ephemeral key, 12-byte nonce, 16-byte tag, at least one byte
const MIN_CIPHER_HEX = 2 * (65 + 12 + 16 + 1);

export interface RelayIn {
  body: string;
  headers: Record<string, string>;
}

/** The checks a request must pass before it is forwarded. Returns the headers to pass on. */
export function checkEncrypted(input: unknown, model: string): { body: string; headers: Record<string, string> } {
  const bad = (why: string): never => {
    throw new ApiError("private_ai_refused", { why });
  };
  if (!input || typeof input !== "object") bad("no request");
  const { body, headers } = input as Partial<RelayIn>;
  if (typeof body !== "string" || body.length === 0) bad("no body");
  if (body!.length > PRIVATE_AI_MAX_BODY) bad("body too large");
  if (!headers || typeof headers !== "object") bad("no headers");
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers!)) {
    const name = k.toLowerCase();
    if (typeof v !== "string") bad(`header ${name} is not text`);
    if ((PASS_HEADERS as readonly string[]).includes(name)) h[name] = v;
  }
  if (h["x-encryption-version"] !== "3") bad("not E2EE version 3");
  if (h["x-signing-algo"] !== "ecdsa") bad("not ECDSA");
  if (!HEX.test(h["x-client-pub-key"] ?? "") || !HEX.test(h["x-model-pub-key"] ?? "")) bad("missing E2EE keys");
  let j: any;
  try {
    j = JSON.parse(body!);
  } catch {
    bad("body is not JSON");
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) bad("body is not an object");
  for (const k of Object.keys(j)) if (!BODY_KEYS.has(k)) bad(`field ${k} is not allowed`);
  if (j.model !== model) bad("wrong model");
  if (j.max_tokens !== undefined && !(Number.isInteger(j.max_tokens) && j.max_tokens > 0 && j.max_tokens <= PRIVATE_AI_MAX_TOKENS)) bad("max_tokens out of range");
  if (!Array.isArray(j.messages) || j.messages.length < 1 || j.messages.length > 4) bad("one to four messages");
  for (const m of j.messages) {
    if (!m || typeof m !== "object" || Array.isArray(m)) bad("message is not an object");
    for (const k of Object.keys(m)) if (k !== "role" && k !== "content") bad(`message field ${k} is not allowed`);
    if (m.role !== "system" && m.role !== "user") bad("role must be system or user");
    if (typeof m.content !== "string" || m.content.length < MIN_CIPHER_HEX || !HEX.test(m.content)) bad("message content is not ciphertext");
  }
  return { body: body!, headers: h };
}

export interface RelayOut {
  /** NEAR AI's answer, byte for byte, still encrypted to the browser's key. */
  response: string;
  /** The enclave's signature over the exact request and response bytes, and its checks. */
  proof: Proof;
}

/** Forwards encrypted questions to NEAR AI Cloud, within per-visitor and daily limits. */
export class PrivateAi {
  private readonly byIp = new Map<string, number[]>();
  private day: number[] = [];

  constructor(
    private readonly key: string,
    private readonly base: string,
    readonly model: string,
    private readonly now: () => number = Date.now,
    private readonly f: typeof fetch = (...a) => fetch(...a),
  ) {}

  private take(ip: string): void {
    const t = this.now();
    this.day = this.day.filter((x) => x > t - DAY_MS);
    const mine = (this.byIp.get(ip) ?? []).filter((x) => x > t - HOUR_MS);
    if (mine.length >= PRIVATE_AI_PER_IP_PER_HOUR || this.day.length >= PRIVATE_AI_PER_DAY) throw new ApiError("private_ai_limit");
    mine.push(t);
    this.byIp.set(ip, mine);
    this.day.push(t);
  }

  async relay(ip: string, input: unknown): Promise<RelayOut> {
    const { body, headers } = checkEncrypted(input, this.model);
    this.take(ip);
    let res: Response;
    try {
      res = await this.f(`${this.base}/chat/completions`, {
        method: "POST",
        headers: { ...headers, Authorization: `Bearer ${this.key}`, "Content-Type": "application/json", "Accept-Encoding": "identity" },
        body,
        signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
      });
    } catch {
      throw new ApiError("private_ai_unavailable");
    }
    const response = await res.text();
    if (!res.ok) throw new ApiError("private_ai_unavailable");
    let chatId: unknown;
    try {
      chatId = JSON.parse(response)?.id;
    } catch {
      throw new ApiError("private_ai_unavailable");
    }
    if (typeof chatId !== "string") throw new ApiError("private_ai_unavailable");
    let signed: Proof["signed"] = null;
    let attested: string[] = [];
    try {
      const auth = { headers: { Authorization: `Bearer ${this.key}` }, signal: AbortSignal.timeout(30_000) };
      const s = (await (await this.f(`${this.base}/signature/${encodeURIComponent(chatId)}?model=${encodeURIComponent(this.model)}&signing_algo=ecdsa`, auth)).json()) as any;
      if (typeof s?.text === "string" && typeof s?.signature === "string" && typeof s?.signing_address === "string") {
        signed = { text: s.text, signature: s.signature, signingAddress: s.signing_address };
      }
      const att = (await (await this.f(`${this.base}/attestation/report?model=${encodeURIComponent(this.model)}&signing_algo=ecdsa`, auth)).json()) as any;
      attested = (Array.isArray(att?.model_attestations) ? att.model_attestations : []).map((m: any) => m?.signing_address).filter((a: unknown): a is string => typeof a === "string");
    } catch {
      // the answer stands; the page shows which checks could not be made
    }
    return {
      response,
      proof: {
        model: this.model,
        chatId,
        requestSha256: sha256Hex(body),
        responseSha256: sha256Hex(response),
        signed,
        checks: checkProof(this.model, body, response, signed, attested),
      },
    };
  }
}
