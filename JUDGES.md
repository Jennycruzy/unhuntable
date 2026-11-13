# For judges and automated reviewers

Every claim Unhuntable makes, where it lives in the code, the test that checks it, and the command that shows it. Commands run from a clone of this repo.

## One command for the live claims

```bash
node tools/check-live.mjs
```

Node 20 or newer, nothing to install, no account and no money. It reads NEAR's archival RPC, Hyperliquid's public explorer, OutLayer's public file store and the live site, then prints `PASS` or `FAIL` for 15 claims: the signer contract on mainnet, NEAR's MPC network signing for a piece, the NVDA short and its sealed stop firing, the guard build OutLayer runs, the x402 and PingPay agent payments, the live app, the try-a-trade page, the Hunt Map and the trader selling keys. Expected last line: `15 of 15 passed.`

## Every test suite

[docs/check-it-yourself.md](docs/check-it-yourself.md) runs all 606 tests, one command per folder, from a fresh clone.

## Claims, code, tests

| Claim | Code | Test | Show it |
| --- | --- | --- | --- |
| A trade is split into separate accounts, with sizes and timing drawn from a verifiable random draw | `client/src/planner.ts`, `client/src/vrf.ts` | `client/test/planner.property.test.ts`, `client/test/planner.test.ts` | `cd client && npm ci && npm test` |
| The stop is sealed in the browser and only the guard can open it; the level never leaves the guard | `client/src/box-browser.ts`, `web/lib/stops.ts`, `guard/src/lib.rs` | `client/test/box-browser.test.ts`; guard `stop_level_never_in_output` | `cd guard && cargo test --lib --test guard_tests` |
| The stop fires only when independent prices agree; one bad feed cannot fire it | `guard/src/lib.rs` | guard `one_bad_feed_cannot_fire`, `real_crash_fires_once`, `stocks_need_two_outside_sources` | same; live: check-live "A sealed stop fired" |
| The guard can trade but cannot move money | `guard/src/lib.rs` | guard `guard_has_no_transfer_path` | same; the refused mainnet transfer is in the README's mainnet table |
| The guard cuts size before liquidation | `guard/src/lib.rs` | guard `defence_ladder_steps` | same |
| Each piece's Hyperliquid account has no private key: NEAR's MPC network signs only what the piece key approved | `signer/src/lib.rs`, `client/src/chainsig.ts`, `server/src/chainsig.ts` | signer `signs_only_what_the_piece_key_signed`, `server_cannot_change_the_action`, `replay_refused`; `client/test/chainsig.test.ts`; `server/test/chainsig.test.ts` | `cd signer && cargo test`; live: check-live "MPC network signed" |
| Money moves privately: deposits into a private balance on NEAR Intents, each piece funded on its own | `server/src/deposits.ts`, `server/src/positions.ts`, `server/src/oneclick.ts` | `server/test/deposits.test.ts`, `server/test/positions.test.ts` | `cd client && npm run build && cd ../server && npm ci && npm test` |
| A reused piece trades on the money it still holds, so nothing is sent | `server/src/positions.ts` (`holdsEnough`, `heldNeed`) | `server/test/judge.test.ts` ("a reused piece that still holds money") | same |
| US stocks on trade.xyz, moved in and out by Chain Signatures | `server/src/chainsig.ts` (`moveToXyzNow`), `client/src/hyperliquid.ts` | `server/test/chainsig.test.ts`; guard `stocks_need_two_outside_sources` | live: check-live "NVDA short", "onto trade.xyz", "back from trade.xyz" |
| Copy keys and viewing keys: followers copy trades into their own pieces and never see an open position; paid day by day by private transfer | `server/src/followers.ts` | `server/test/followers.test.ts` | live: check-live "A trader sells copy and viewing keys"; [tryunhuntable.site/traders](https://tryunhuntable.site/traders/) |
| A trader's record is signed by the guard over every piece they used, totals only | `guard/src/lib.rs`, `tools/easverify.cjs` | guard `eas_offchain_attestation_matches_sdk`, `trader_record_matches_sdk` | `cd guard && cargo test --lib --test guard_tests` |
| AI agents trade with their own key and limits over MCP, and cannot move money or read a stop back | `agent/src/`, `server/src/agents.ts` | `agent/test/agent.test.ts`, `server/test/agents.test.ts` | `cd client && npm run build && cd ../agent && npm ci && npm test` |
| Agents pay per call in USDC on NEAR with x402, or from other chains through PingPay | `server/src/x402.ts`, `server/src/agents.ts` | `server/test/x402.test.ts`, `server/test/pingpay.test.ts`, `agent/test/pingpay.test.ts` | live: check-live "x402", "PingPay" |
| An attacker AI in a NEAR AI Cloud TEE hunts your own pieces and signs its answer | `server/src/aihunt.ts`, `server/src/nearai.ts`, `tools/check-ai-hunt.cjs` | `server/test/aihunt.test.ts` | `cd tools && npm install --no-package-lock && cd .. && node tools/check-ai-hunt.cjs docs/proof/ai-hunt-mainnet.json` |
| Anyone can open a real trade with no wallet, and nothing on that page can move money | `server/src/judge.ts`, `web/app/judge/page.tsx` | `server/test/judge.test.ts`, `web/e2e/judge.e2e.ts` | [tryunhuntable.site/judge](https://tryunhuntable.site/judge/); check-live "/judge" |
| The Hunt Map shows real liquidation prices and replays real liquidations | `server/src/huntmap.ts`, `server/src/huntmap-run.ts` | `server/test/huntmap.test.ts`, `server/test/huntreplay.test.ts` | [tryunhuntable.site/hunt-map](https://tryunhuntable.site/hunt-map/); check-live "Hunt Map" |
| A DAO's piece moves only on a passed vote | `signer/src/lib.rs`, `contract/src/lib.rs`, `client/src/chainsig.ts` | `signer/src/tests.rs`, `contract/src/tests.rs` | [docs/treasury.md](docs/treasury.md#proof) (NEAR testnet proof) |
| Your 12 words bring the money home with our servers off, and the exit page is exactly its source | `client/src/exit.ts`, `exit/` | `client/test/exit.test.ts` | `cd exit && npm ci && npm run build && git diff --exit-code exit.js` |
| Linking attacks that use public data only, run against our own pieces | `attacks/linking_attacks.py` | | `python3 attacks/linking_attacks.py 0x<any Hyperliquid address>` |

## What is on mainnet

Everything above runs on NEAR mainnet, NEAR Intents, OutLayer and Hyperliquid mainnet with small real amounts, except DAO treasury mode, whose proof ran on NEAR testnet; the same code is deployed on mainnet `unhuntable.near`.
