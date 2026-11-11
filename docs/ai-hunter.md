# NEAR AI Hunter

Hunters will use AI. So Unhuntable sends one at your own position first.

On any position split across two or more pieces, the owner can press **Send the hunter**. An attacker AI, running inside a NEAR AI Cloud TEE, starts from one of the pieces and tries to find the others using only what Hyperliquid shows the public. The owner sees what it named, the truth beside it, and how that compares with a random guess. NEAR AI's enclave signs the exact question and answer, and anyone can check that signature without an account.

## What the hunter is given

It starts where a real hunter starts: one piece's Hyperliquid address, called **T**.

It then gets a lineup of 15 accounts, built the way a hunter would build one:

- For each of the owner's pieces, the server asks Hyperliquid who first paid it and when.
- It reads that payer's other sends within 20 minutes of each piece's funding. For 1Click's shared payer that is often hundreds of accounts.
- It prefers accounts that hold the same market, so the strangers look as much like the pieces as possible.
- **The owner's other pieces are always in the lineup, and the hunter is told that at least one account is T's owner's.** That is an easier job than real life, where the hunter does not know the pieces are there at all.

For T and every lineup account, the hunter gets the public facts, with labels instead of addresses:

| Fact | Read from Hyperliquid with |
| --- | --- |
| Who paid it first, how much, minutes after T was funded | `userNonFundingLedgerUpdates` |
| How many accounts T's payer funded in the same window | `userNonFundingLedgerUpdates` of the payer |
| Open positions: market, side, size, entry, leverage, margin mode, liquidation price | `clearinghouseState` |
| Resting orders and trigger prices in the market | `frontendOpenOrders` |
| Fills in the last 14 days, markets traded, the latest fills in the market | `userFillsByTime` |
| Money sent between any two accounts in the hunt | `userNonFundingLedgerUpdates` |

These are keyless, public questions; anyone can ask them. The model never sees an address, and never sees which accounts are the owner's.

## What it must answer

The accounts it believes share an owner with T, each with a confidence and a reason; its guess of the whole position; and where it thinks the stop sits. Wrong names count against it.

## How it is scored

| Verdict | Meaning |
| --- | --- |
| **Caught** | It named every one of the owner's other pieces, and at least half of its names were right. |
| **Partly found** | It named some of them, and at least half of its names were right. |
| **Held** | It named none of them, or more strangers than pieces (naming everyone does not count as finding anyone). |

The page also says how many a random pick of the same number of names would find, so a lucky guess is easy to spot. The stop guess is shown beside the stop the owner set in this browser; the real stop is sealed in the guard, so only the owner can compare.

## The model and its proof

The hunter runs on `Qwen/Qwen3.6-35B-A3B-FP8`, served by NEAR AI Cloud inside Intel TDX with NVIDIA confidential GPUs. A hunt's answer takes about 20 seconds; reading Hyperliquid for 16 accounts takes about 3 minutes, paced to stay well inside Hyperliquid's request limits.

For every answer, the model's enclave signs `<model>:<sha256 of the request>:<sha256 of the response>`. The server keeps the exact bytes it sent and got back, and checks three things:

1. The signed text holds the hashes of **our** request and response bytes.
2. The signature recovers to the address the enclave claims.
3. That address is a signing key in NEAR AI's hardware attestation for the model.

The owner can download the signed question and answer from the result, and check it alone:

```bash
cd tools && npm install --no-package-lock && cd ..
node tools/check-ai-hunt.cjs docs/proof/ai-hunt-mainnet.json
```

The attestation report it reads is public (`https://cloud-api.near.ai/v1/attestation/report?model=...`); no NEAR AI account is needed.

## Proof run on mainnet

We sent the hunter after three of our own real mainnet pieces: [`0xb02b…e4ac`](https://app.hyperliquid.xyz/explorer/address/0xb02b2df810929fdeb582ec21703002596dbae4ac) as T, with [`0x20e7…86b6`](https://app.hyperliquid.xyz/explorer/address/0x20e76149f42c4c69af5afddd22b553bcec8886b6) and [`0x35c9…b02a`](https://app.hyperliquid.xyz/explorer/address/0x35c99eff31255e9ac3fc2a3c6e4dd70cb026b02a) hidden in the lineup. All three were paid by 1Click's shared payer, which funded 992 accounts within 20 minutes of T.

| | |
| --- | --- |
| Lineup | 15 accounts, 2 of them ours |
| Hyperliquid questions | 144, all public |
| Model time | 23 seconds |
| It named | 1 account, ours: the piece that ran the same $10 ETH open-and-close test loops as T, days earlier |
| It missed | The NEAR-controlled piece |
| Strangers named | 0 |
| A random pick of 1 name would find | 0.13 |
| Verdict | **Partly found** |
| TEE checks | hashes, signature and attestation all hold ([receipt](proof/ai-hunt-mainnet.json), chat `87d076fef7ef497c962261e3ca59e77d`) |

The lesson is the one the hunter exists to teach: payer and timing hid the pieces among 992 accounts, but two pieces that **behave** the same, with the same sizes on the same loop, are linkable. Positions opened in the app avoid this by design: each piece's size and entry time are drawn by OutLayer VRF, and stops are never on the book. The hunter is how each owner checks that on their own position, with a signed answer.

## Limits

One hunt runs at a time, three per owner per day and sixty per day in all. Each costs under one cent of NEAR AI credit (the proof run used 8,048 tokens, about $0.006). A hunt reads only public data and changes nothing: no order, no transfer, no key. Results are shown only to the position's owner, because the lineup names which accounts are theirs.

## Code

- `server/src/aihunt.ts`: the lineup, the facts, the prompt, the scoring, the runner.
- `server/src/nearai.ts`: the NEAR AI Cloud client and the signature check.
- `web/components/AiHunter.tsx`: the card on each position.
- `tools/check-ai-hunt.cjs`: the stand-alone check.
- Tests: `server/test/aihunt.test.ts` (20), `web/test/aihunt.test.ts`, `web/e2e/aihunt.e2e.ts`.
