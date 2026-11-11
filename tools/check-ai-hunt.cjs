#!/usr/bin/env node
// Check a NEAR AI Hunter receipt by yourself: the file the app's "Download the signed
// question and answer" button saves, or docs/proof/ai-hunt-mainnet.json.
//
//   node tools/check-ai-hunt.cjs docs/proof/ai-hunt-mainnet.json
//
// 1. Hash the exact request and response bytes and rebuild the text the enclave signs:
//    "<model>:<sha256 request>:<sha256 response>".
// 2. Recover who signed that text (EIP-191 personal message).
// 3. Ask NEAR AI Cloud's public attestation report (no key needed) whether that signer is a
//    signing key of the model's TEE.
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
  const res = await fetch(`https://cloud-api.near.ai/v1/attestation/report?model=${encodeURIComponent(model)}&signing_algo=ecdsa`);
  const att = await res.json();
  const keys = (att.model_attestations || []).map((m) => String(m.signing_address).toLowerCase());
  const attested = keys.includes(signer);
  console.log(`signed text is our hashes:          ${ok(hashes)}`);
  console.log(`signature recovers ${signer}: ${ok(sigOk)}`);
  console.log(`signer is in the TEE attestation:   ${ok(attested)}${attested ? "" : ` (attested now: ${keys.join(", ") || "none"}; a restarted enclave gets a new key)`}`);
  const content = JSON.parse(r.response).choices[0].message.content;
  console.log(`\nThe hunter answered:\n${content}`);
  process.exit(hashes && sigOk && attested ? 0 : 1);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
