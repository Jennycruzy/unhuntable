# Private AI stop adviser

Where to put a stop is the one thing a stop hunter wants to know. Asking a chatbot hands it to whoever runs the chatbot. Here you can ask an AI, and nobody but you sees the question or the answer: not us, not NEAR AI's operators.

## Try it

**Open [tryunhuntable.site/judge](https://tryunhuntable.site/judge/) → pick a market and a side → press Ask the private AI.** In a few seconds:

- "It suggests a stop 2% away." (or 1% or 3%) with one or two sentences why, and a **Use this stop** button that picks it for the trade.
- "All our server saw of your question:" followed by the start of the ciphertext our server forwarded, such as `{"model":"Qwen/Qwen3.6-35B-A3B-FP8","messages":[{"role":"system","content":"04a1…`.
- "Checked in this browser before showing it:" the enclave's Intel TDX quote, NVIDIA's verdict on its GPU, the key, and NEAR AI's signature, then **Download the signed receipt**. If any check fails, the page shows why and no advice.

No sign-in, no wallet, no money.

## How it stays private

1. **Your browser reads the prices.** It asks Hyperliquid's public API for the last two hours of five-minute candles in that market. Our server is not asked, so it does not learn which market you looked at.
2. **Your browser verifies the model's enclave itself.** It fetches the attestation of `Qwen/Qwen3.6-35B-A3B-FP8` from NEAR AI Cloud (`cloud-api.near.ai/v1/attestation/report`) with a fresh random nonce, and checks it with NEAR AI's own SDK (`verifyModelAttestation`): the Intel TDX quote and its certificate chain (Intel's collateral comes through NEAR AI's PCCS proxy), the nonce bound in the quote, and NVIDIA's signed verdict on the GPU evidence (through NEAR AI's proxy, checked against NVIDIA's own keys). The encryption key is taken from that verified quote. If any of it fails, nothing is sent.
3. **Your browser encrypts the question.** With NEAR AI's own SDK (`@nearai/inference-sdk`, `prepareE2eeChatRequest`), NEAR AI's end-to-end encryption, version 3: each message is encrypted to the model's key, and the answer will be encrypted to a key made in your browser for this one question.
4. **Our server only forwards ciphertext.** `POST /api/private-ai` adds our NEAR AI key and sends the bytes on unchanged. It refuses any message that is not hex ciphertext, any other field, model or header, so it cannot be used to read a question or as a plain proxy for our key. It stores nothing and logs no content (`server/src/privateai.ts`).
5. **Only your browser can read the answer.** It decrypts it and keeps only one of the offered distances.
6. **Your browser checks the signature before it shows anything.** NEAR AI's model signs `<model>:<sha256 of the request>:<sha256 of the response>`, the encrypted bytes our server forwarded. The browser rebuilds that text from the bytes it sent and received, recovers the signer, and requires it to be the enclave it verified in step 2 (`verifyModelResponse`). If it is not, the answer is not decrypted or shown, so there is no **Use this stop** to press. Our server's word is never taken for any of this. The receipt holds the bytes and the signature; anyone can check it again.

## Check a receipt

```bash
cd tools && npm install --no-package-lock && cd ..
node tools/check-ai-hunt.cjs docs/proof/private-ai-mainnet.json
```

Three lines end in `yes`: the signed text holds the hashes of the exact request and response bytes, the signature recovers to the enclave's address, and that address is a signing key in NEAR AI's public attestation report for the model. The last line shows the answer as our server saw it: ciphertext.

## Proof run on mainnet

Asked from the page's own browser code against the live site, for an ETH short at 2x with stops 1%, 2% and 3% away. Receipt: [`docs/proof/private-ai-mainnet.json`](proof/private-ai-mainnet.json).

| | |
| --- | --- |
| Model | `Qwen/Qwen3.6-35B-A3B-FP8`, NEAR AI Cloud |
| Time from asking to the answer on screen | 8.6 seconds |
| What our server forwarded | every message hex ciphertext; the word `ETH` nowhere in it |
| What our server got back | the answer as ciphertext |
| Answer, read only in the browser | 2% away: "A 1% stop sits within one average candle range and risks being triggered by normal market noise, while 3% exposes the 2x leveraged position to an excessive drawdown." |
| Request / response sha256 | `47832db3…f668` / `2545b822…d766` |
| Signed by | `0xfdbd7952498b333206f360d71d97a1e0961e8ddf` |
| `check-ai-hunt.cjs` | hashes match: yes · signature valid: yes · signer in the TEE attestation: yes |

## Limits

- **The answer is advice, not a guarantee.** It picks one of the offered distances from recent price swings; the trade, and its risk, are yours.
- **Our server sees that a question was asked, when, and its size,** and the model name. Not the market, side, size, prices or answer.
- **Twenty questions per visitor per hour, three hundred a day in all,** to keep the cost to us at a few cents a day.

## Code

- `web/lib/privateai.ts`: candles, the question, verifying the enclave and the signature in the browser, encryption, decryption, the answer.
- `web/components/PrivateAdvice.tsx`: the card on the try-a-trade page.
- `server/src/privateai.ts`: the relay and its checks.
- Tests: `server/test/privateai.test.ts` (8: refuses plain words, other fields, models and headers; forwards the exact bytes with only the E2EE headers; limits), `web/test/privateai.test.ts` (11, including our mainnet receipt accepted, and refused when one byte of the request or response changes, the signature is altered, the signer is not the verified enclave, there is no signature, or the attestation does not verify, in which case nothing reaches our server).

[Back to the README](../README.md)
