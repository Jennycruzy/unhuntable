#!/usr/bin/env node
// Check a NEAR AI Hunter or private AI stop adviser receipt by yourself: the file the app's
// "Download the signed" buttons save, or the files in docs/proof.
//
//   node tools/check-ai-hunt.cjs docs/proof/ai-hunt-mainnet.json
//
// 1. Hash the exact request and response bytes and rebuild the text the enclave signs:
//    "<model>:<sha256 request>:<sha256 response>".
// 2. Recover who signed that text (EIP-191 personal message).
// 3. Fetch that signer's hardware attestation from NEAR AI Cloud (no key needed) with a fresh
//    random nonce, and verify it here with NEAR AI's own SDK: the Intel TDX quote must carry
//    the nonce and be up to date, NVIDIA must verify the GPU evidence, and the signing key
//    must be the one bound in the quote. Then check the signature against that verified key.
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { verifyMessage } = require("ethers");

const file = process.argv[2];
if (!file) {
  console.error("usage: node tools/check-ai-hunt.cjs <receipt.json>");
  process.exit(2);
}
const r = JSON.parse(readFileSync(file, "utf8"));
const sha = (s) => createHash("sha256").update(s).digest("hex");
const model = r.proof.model;
const text = `${model}:${sha(r.request)}:${sha(r.response)}`;
const signed = r.proof.signed;
const ok = (b) => (b ? "yes" : "NO");

(async () => {
  console.log(`model:            ${model}`);
  console.log(`request sha256:   ${sha(r.request)}`);
  console.log(`response sha256:  ${sha(r.response)}`);
  if (!signed) {
    console.log("No signature in this receipt.");
    process.exit(1);
  }
  const hashes = signed.text === text;
  const signer = verifyMessage(signed.text, signed.signature).toLowerCase();
  const sigOk = signer === signed.signingAddress.toLowerCase();
  const sdk = await import("@nearai/inference-sdk/node");
  const client = new sdk.AttestationClient({ baseUrl: "https://cloud-api.near.ai/v1" });
  let fetched = { attestations: [], clientBinding: { nonce: null } };
  try {
    fetched = await client.fetchModelAttestations({ model, signingAlgo: "ecdsa", signingAddress: signer });
  } catch (e) {
    console.log(`attestation fetch failed: ${e.code || e.message}`);
  }
  const verifiers = { tdxQuote: sdk.createTdxQuoteVerifier(), gpuEvidence: sdk.createGpuEvidenceVerifier() };
  let v = null;
  let why = "NEAR AI returned no attestation for this signer (a restarted enclave gets a new key)";
  for (const attestation of fetched.attestations) {
    try {
      const got = await sdk.verifyModelAttestation({ attestation, clientBinding: fetched.clientBinding, verifiers, policy: { gpuEvidence: "required", acceptedTcbStatuses: ["UpToDate"] } });
      if (got.signer.signingAddress.toLowerCase() === signer) {
        v = got;
        break;
      }
      why = "the verified enclave's key is another address";
    } catch (e) {
      why = e.code || e.message;
    }
  }
  let bound = false;
  if (v) {
    try {
      const enc = new TextEncoder();
      sdk.verifyModelResponse({ requestBody: enc.encode(r.request), responseBody: enc.encode(r.response), signature: { kind: "provider_tee", signer: v.signer, signedText: signed.text, signature: signed.signature }, attestation: v });
      bound = true;
    } catch (e) {
      why = e.code || e.message;
    }
  }
  const attested = Boolean(v) && bound;
  console.log(`signed text is our hashes:          ${ok(hashes)}`);
  console.log(`signature recovers ${signer}: ${ok(sigOk)}`);
  if (fetched.clientBinding.nonce) console.log(`fresh nonce sent:                   ${fetched.clientBinding.nonce}`);
  console.log(`enclave verified, signer is its key: ${ok(attested)}${attested ? ` (Intel TDX ${v.tcbStatus}, NVIDIA GPU ${v.gpuEvidence})` : ` (${why})`}`);
  const content = JSON.parse(r.response).choices[0].message.content;
  if (/^[0-9a-f]+$/i.test(content)) console.log(`\nThe answer is encrypted to the asker's browser key (NEAR AI E2EE); only that browser could read it:\n${content.slice(0, 96)}…`);
  else console.log(`\nThe hunter answered:\n${content}`);
  process.exit(hashes && sigOk && attested ? 0 : 1);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
