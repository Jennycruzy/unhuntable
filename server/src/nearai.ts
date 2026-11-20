// NEAR AI Cloud: an OpenAI-style chat API whose models run inside TEEs (Intel TDX + NVIDIA
// confidential GPUs). For every answer the model's enclave signs
//   "<model>:<sha256 of the request body>:<sha256 of the response body>"
// with a key bound into the model's hardware attestation. After each answer we fetch that
// signer's attestation with a fresh random nonce and verify it here: the Intel TDX quote
// (it must carry our nonce and be up to date), NVIDIA's verdict on the GPU evidence, and the
// signing key bound in the quote. Then the signature over our exact bytes is checked against
// that verified key. We keep the bytes, so anyone can redo the signature check later.
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

/** The enclave check made for one answer, with a nonce fresh for that answer. */
export interface Enclave {
  /** The random nonce we sent; the verified quote carries it, so it was made for this check. */
  nonce: string | null;
  /** The TDX quote, the GPU evidence and the key bound in the quote all verified, and the answer's signer is that key. */
  verified: boolean;
  tcbStatus: string | null;
  gpu: string | null;
  signingAddress: string | null;
  checkedMs: number;
  /** Why it did not verify, in plain words. */
  reason?: string;
}

/** Verify the enclave that signed `signed`, and the signature over these exact bytes. */
export type EnclaveVerifier = (model: string, request: string, response: string, signed: Signed) => Promise<Omit<Enclave, "checkedMs">>;

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
    /** That address is the key bound in a hardware attestation we verified with a fresh nonce. */
    inAttestation: boolean;
  };
  /** The fresh-nonce enclave check behind `inAttestation`. Absent on hunts made before it existed. */
  enclave?: Enclave;
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

const plainReason = (e: unknown): string => {
  const code = (e as { code?: unknown })?.code;
  return typeof code === "string" ? code : e instanceof Error ? e.message.slice(0, 160) : "unknown";
};

/**
 * The check NEAR AI documents, made with its own SDK: fetch the signer's attestation with a fresh
 * nonce, verify the TDX quote (nonce bound, TCB UpToDate), require NVIDIA's verdict on the GPU
 * evidence, take the key bound in the quote, then verify the signature over our exact bytes.
 */
export function sdkVerifier(base = NEARAI_URL): EnclaveVerifier {
  return async (model, request, response, signed) => {
    const sdk = await import("@nearai/inference-sdk/node");
    const client = new sdk.AttestationClient({ baseUrl: base });
    const fetched = await client.fetchModelAttestations({ model, signingAlgo: "ecdsa", signingAddress: signed.signingAddress });
    const nonce = fetched.clientBinding.nonce;
    const verifiers = { tdxQuote: sdk.createTdxQuoteVerifier(), gpuEvidence: sdk.createGpuEvidenceVerifier() };
    const enc = new TextEncoder();
    let reason = "NEAR AI returned no attestation for this signer.";
    for (const attestation of fetched.attestations) {
      try {
        const v = await sdk.verifyModelAttestation({ attestation, clientBinding: fetched.clientBinding, verifiers, policy: { gpuEvidence: "required", acceptedTcbStatuses: ["UpToDate"] } });
        if (v.signer.signingAddress.toLowerCase() !== signed.signingAddress.toLowerCase()) {
          reason = "The verified enclave's key is not the answer's signer.";
          continue;
        }
        sdk.verifyModelResponse({
          requestBody: enc.encode(request),
          responseBody: enc.encode(response),
          signature: { kind: "provider_tee", signer: v.signer, signedText: signed.text, signature: signed.signature },
          attestation: v,
        });
        return { nonce, verified: true, tcbStatus: String(v.tcbStatus), gpu: String(v.gpuEvidence), signingAddress: v.signer.signingAddress };
      } catch (e) {
        reason = plainReason(e);
      }
    }
    return { nonce, verified: false, tcbStatus: null, gpu: null, signingAddress: null, reason };
  };
}

export class NearAi {
  private readonly f: typeof fetch;
  private readonly verify: EnclaveVerifier;
  constructor(
    private readonly key: string,
    private readonly base = NEARAI_URL,
    f?: typeof fetch,
    readonly model = NEARAI_MODEL,
    verify?: EnclaveVerifier,
    private readonly now: () => number = Date.now,
  ) {
    this.f = f ?? ((...a) => fetch(...a));
    this.verify = verify ?? sdkVerifier(base);
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
    try {
      const s = await this.getJson(`/signature/${encodeURIComponent(chatId)}?model=${encodeURIComponent(this.model)}&signing_algo=ecdsa`);
      if (typeof s?.text === "string" && typeof s?.signature === "string" && typeof s?.signing_address === "string") {
        signed = { text: s.text, signature: s.signature, signingAddress: s.signing_address };
      }
    } catch {
      // the answer stands; the page shows which checks could not be made
    }
    let enclave: Enclave | undefined;
    if (signed) {
      try {
        enclave = { ...(await this.verify(this.model, request, response, signed)), checkedMs: this.now() };
      } catch (e) {
        enclave = { nonce: null, verified: false, tcbStatus: null, gpu: null, signingAddress: null, checkedMs: this.now(), reason: `NEAR AI's attestation could not be checked: ${plainReason(e)}` };
      }
    }
    const attested = enclave?.verified && enclave.signingAddress ? [enclave.signingAddress] : [];
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
        ...(enclave ? { enclave } : {}),
      },
    };
  }
}
