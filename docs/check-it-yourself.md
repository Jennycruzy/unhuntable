# Check it yourself

Every claim in the README, checked on your own machine.

No keys, no wallet, no money, no network. Each step is "do this → you see that".

**1. The guard's decisions** (Rust, needs `rustup`):

```bash
cd guard && cargo test --lib --test guard_tests
```

→ `test result: ok. 44 passed`. These include `moving_the_xyz_book_alone_cannot_fire_a_stock_stop`, `stocks_need_two_outside_sources`, `trade_xyz_leverage_and_open_match_reference_sdk`, `one_bad_feed_cannot_fire`, `real_crash_fires_once`, `stop_level_never_in_output`, `guard_has_no_transfer_path`, `defence_ladder_steps`, and signature tests that match Hyperliquid's official Python SDK byte for byte (`order_signatures_match_reference_sdk`, `usd_send_digest_matches_reference_sdk`) and EAS's official SDK (`eas_offchain_attestation_matches_sdk`, and `trader_record_matches_sdk` for one trader's record).

**2. The client library, the planner and the exit tool** (Node 20+):

```bash
cd client && npm ci && npm test
```

→ `181 passed`. The sealed-box tests open a box made by the Rust guard's reference and make one the guard opens (`sealed_call_from_ts_client_opens` on the Rust side). The planner's property tests check hundreds of random positions: sizes add up exactly, every piece is above Hyperliquid's $10 minimum, and no piece needs money from another. The exit tests check that the 12 words and the private key are never sent anywhere. The Chain Signatures tests (`chainsig.test.ts`) match the signer contract's hashes, rebuild the exact message piece C signed on mainnet, and recover NEAR's real MPC signature for it to piece C's Hyperliquid account.

**3. The server and its money flows:**

```bash
cd client && npm run build && cd ../server && npm ci && npm test
```

→ `267 passed`. Sign-in with a NEP-413 signature, encrypted wallet keys, deposits, funding, policy batches and read-back, ticks, refills and going home, with fake clocks and recorded replies. `chainsig.test.ts` runs a position and a trip home on NEAR-controlled pieces against a fake contract and MPC network that check signatures the way the real ones do; it refuses another key's signature, a wrong counter, a send back to perps and any token but USDC, and its relay transactions match near-api-js byte for byte. `followers.test.ts` buys keys with one wallet approval that lists the trader in the balance lock, pays each day by private transfer to the trader's private balance only, pauses on a refused payment, copies a trader's crypto position into the follower's own pieces after a random delay and closes it with the trader's, never copies stocks or for a key that is off, shows closed trades only to key holders, and reads results from Hyperliquid's fills. `judge.test.ts` opens a try-a-trade run on a ready piece that already holds its money and checks nothing is sent from the private balance, refuses any field but market and side, keeps one run at a time and a daily limit, seals a stop, and closes the run by itself after three minutes, or 90 seconds after it opens with no stop, and says up front when the demo piece holds too little.

**4. The signer contract** (Rust, needs `rustup`):

```bash
cd signer && cargo test
```

→ `test result: ok. 16 passed`. These include `typed_data_hash_matches_hyperliquid_sdk` (every action type against Hyperliquid's Python SDK), `signs_only_what_the_piece_key_signed`, `server_cannot_change_the_action`, `replay_refused` and `other_piece_key_refused`.

**4b. The records contract** (Rust, needs `rustup` and [cargo-near](https://github.com/near/cargo-near): `cargo install cargo-near --locked --no-default-features`):

```bash
cd contract && cargo test
```

→ `18 passed` in all, unit tests plus sandbox tests that build the contract and call it on a local NEAR sandbox node (the first run downloads the sandbox binary; nothing talks to a public network).

**5. The web app** (phone and desktop):

```bash
cd client && npm ci && npm run build && cd ../web && npm ci && npx playwright install chromium && npm test && npm run build && npx playwright test
```

→ 65 unit tests, then every screen in headless Chromium at 360×780 and 1280×800, with all outside requests blocked. Screenshots land in `web/screenshots/`.

**6. The MCP server for AI agents:**

```bash
cd client && npm run build && cd ../agent && npm ci && npm test
```

→ `13 passed`. Stops sealed on the agent's machine open only with the guard's key; a full MCP session opens, seals, reads status and closes; no tool answer and no request ever carries the stop price; the PingPay payer quotes, deposits once and retries while NEAR Intents settles; the follower tools read traders for free, closed trades as a paid call, and ask the owner for a key.

**7. The exit tool is exactly its source:**

```bash
cd exit && npm ci && npm run build && git diff --exit-code exit.js
```

→ no diff. The page you would open to leave without us is the code you can read.

**8. Attack any Hyperliquid account with public data** (network, read-only, at most 5 requests a second):

```bash
python3 attacks/linking_attacks.py 0x<any Hyperliquid address>
```

→ for each attack, `LINKED`, `NOT LINKED` or `PARTIAL`, with the evidence, written to `linking-report.json`.

**9. The guard build OutLayer runs** (network, read-only):

```bash
# the build our guard project runs now, as recorded on outlayer.near
curl -s https://free.rpc.fastnear.com -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"outlayer.near","method_name":"get_project","args_base64":"'$(printf '{"project_id":"4399fffd59abe3f29284d29936bf83d41e1344e82c971394660217cf6e8046f7/guard"}' | base64 -w0)'"}}' \
  | python3 -c "import sys,json; print(json.loads(bytes(json.load(sys.stdin)['result']['result']))['active_version'])"

# the exact file OutLayer runs, and its hash
curl -s https://main.fastfs.io/4399fffd59abe3f29284d29936bf83d41e1344e82c971394660217cf6e8046f7/outlayer.near/3dd11f022d41d4c1cc344057b660a51a5af47d95d9faa60f1992ddea428f18e9.wasm | sha256sum
```

→ both print `3dd11f022d41d4c1cc344057b660a51a5af47d95d9faa60f1992ddea428f18e9`. `list_versions` with the same argument lists every guard build we have published, each with its hash and file address. The active build is [`guard/`](../guard/) at commit `f4cebd4`.

**10. The NEAR AI Hunter's answer came from NEAR AI's TEE** (network, read-only, no account):

```bash
cd tools && npm install --no-package-lock && cd ..
node tools/check-ai-hunt.cjs docs/proof/ai-hunt-mainnet.json
```

→ three `yes` lines: the signed text holds the hashes of the exact request and response bytes, the signature recovers to the enclave's address, and that address is a signing key in NEAR AI's public attestation report for the model. Then it prints what the hunter answered. The same check works on any receipt downloaded from a hunt in the app.

[Back to the README](../README.md)
