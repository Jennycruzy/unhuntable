// NEAR AI Cloud: an OpenAI-style chat API whose models run inside TEEs (Intel TDX + NVIDIA
// confidential GPUs). For every answer the model's enclave signs
//   "<model>:<sha256 of the request body>:<sha256 of the response body>"
// with a key that appears in the model's hardware attestation. We keep the exact bytes we
// sent and got back, so anyone holding them can redo the check: hash both, recover the
// signer from the signature, and find that signer in NEAR AI's attestation report.
import { createHash } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";

export const NEARAI_URL = "https://cloud-api.near.ai/v1";
/** Runs on NEAR AI's own TEE hosts (its signer is in the hardware attestation), answers a
 * hunt in about 20 seconds, and is cheap enough for many hunts on $10 of credit. */
export const NEARAI_MODEL = "Qwen/Qwen3.6-35B-A3B-FP8";

/** A hunt's answer, reasoning included, comes back well inside this. */
export const CHAT_TIMEOUT_MS = 240_000;

export class NearAiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NearAiError";
  }
}

export interface Signed {
  /** "<model>:<sha256 request>:<sha256 response>" as the enclave signed it. */
  text: string;
  signature: string;
  signingAddress: string;
}

export interface Proof {
  model: string;
  chatId: string;
  requestSha256: string;
  responseSha256: string;
  signed: Signed | null;
  /** Each check on its own, so the page can say exactly what held. */
  checks: {
    /** The signed text names our model and the hashes of our own request and response bytes. */
    hashesMatch: boolean;
    /** The signature recovers to the address the enclave claims. */
    signatureValid: boolean;
    /** That address is a signing key in the model's current hardware attestation. */
    inAttestation: boolean;
  };
}

export interface Answer {
  content: string;
  /** The exact request and response bodies, kept for anyone who wants to redo the check. */
  request: string;
  response: string;
  proof: Proof;
}

export const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

/** The Ethereum address that signed `text` (EIP-191 personal message), or null. */
export function recoverSigner(text: string, signature: string): string | null {
  try {
    const sig = Buffer.from(signature.replace(/^0x/, ""), "hex");
    if (sig.length !== 65) return null;
    let v = sig[64]!;
    if (v >= 27) v -= 27;
    if (v !== 0 && v !== 1) return null;
    const msg = Buffer.from(text, "utf8");
    const digest = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${msg.length}`), msg]));
    const pub = secp256k1.Signature.fromCompact(sig.subarray(0, 64)).addRecoveryBit(v).recoverPublicKey(digest).toRawBytes(false);
    return "0x" + Buffer.from(keccak_256(pub.subarray(1)).slice(-20)).toString("hex");
  } catch {
    return null;
  }
}

/** Check a signed answer against the bytes we hold and the signing keys in the attestation. */
export function checkProof(model: string, request: string, response: string, signed: Signed | null, attested: string[]): Proof["checks"] {
  if (!signed) return { hashesMatch: false, signatureValid: false, inAttestation: false };
  const addr = signed.signingAddress.toLowerCase();
  return {
    hashesMatch: signed.text === `${model}:${sha256Hex(request)}:${sha256Hex(response)}`,
    signatureValid: recoverSigner(signed.text, signed.signature) === addr,
    inAttestation: attested.map((a) => a.toLowerCase()).includes(addr),
  };
}

export class NearAi {
  private readonly f: typeof fetch;
  constructor(
    private readonly key: string,
    private readonly base = NEARAI_URL,
    f?: typeof fetch,
    readonly model = NEARAI_MODEL,
  ) {
    this.f = f ?? ((...a) => fetch(...a));
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" };
  }

  private async getJson(path: string): Promise<any> {
    let res: Response;
    try {
      res = await this.f(`${this.base}${path}`, { headers: this.headers(), signal: AbortSignal.timeout(60_000) });
    } catch {
      throw new NearAiError("NEAR AI Cloud did not answer.");
    }
    if (!res.ok) throw new NearAiError(`NEAR AI Cloud answered HTTP ${res.status}.`);
    return res.json();
  }

  /** One chat completion asking for a JSON object, with its TEE signature checked. */
  async chatJson(system: string, user: string, maxTokens = 8_000): Promise<Answer> {
    const request = JSON.stringify({
      model: this.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
    });
    let res: Response;
    try {
      res = await this.f(`${this.base}/chat/completions`, { method: "POST", headers: this.headers(), body: request, signal: AbortSignal.timeout(CHAT_TIMEOUT_MS) });
    } catch (e) {
      throw new NearAiError(e instanceof Error && e.name === "TimeoutError" ? "NEAR AI Cloud took too long to answer." : "NEAR AI Cloud did not answer.");
    }
    const response = await res.text();
    if (!res.ok) throw new NearAiError(`NEAR AI Cloud answered HTTP ${res.status}.`);
    let j: any;
    try {
      j = JSON.parse(response);
    } catch {
      throw new NearAiError("NEAR AI Cloud answered with a body that is not JSON.");
    }
    const content = j?.choices?.[0]?.message?.content;
    const chatId = j?.id;
    if (typeof content !== "string" || typeof chatId !== "string") throw new NearAiError("NEAR AI Cloud's answer has no message.");

    let signed: Signed | null = null;
    let attested: string[] = [];
    try {
      const s = await this.getJson(`/signature/${encodeURIComponent(chatId)}?model=${encodeURIComponent(this.model)}&signing_algo=ecdsa`);
      if (typeof s?.text === "string" && typeof s?.signature === "string" && typeof s?.signing_address === "string") {
        signed = { text: s.text, signature: s.signature, signingAddress: s.signing_address };
      }
      const att = await this.getJson(`/attestation/report?model=${encodeURIComponent(this.model)}&signing_algo=ecdsa`);
      attested = (Array.isArray(att?.model_attestations) ? att.model_attestations : [])
        .map((m: any) => m?.signing_address)
        .filter((a: unknown): a is string => typeof a === "string");
    } catch {
      // the answer stands; the page shows which checks could not be made
    }
    return {
      content,
      request,
      response,
      proof: {
        model: this.model,
        chatId,
        requestSha256: sha256Hex(request),
        responseSha256: sha256Hex(response),
        signed,
        checks: checkProof(this.model, request, response, signed, attested),
      },
    };
  }
}
