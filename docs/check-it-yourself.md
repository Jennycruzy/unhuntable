# Check it yourself

Every claim in the README, checked on your own machine.

No keys, no wallet, no money, no network. Each step is "do this → you see that".

**1. The guard's decisions** (Rust, needs `rustup`):

```bash
cd guard && cargo test --lib --test guard_tests
```

→ `test result: ok. 41 passed`. These include `moving_the_xyz_book_alone_cannot_fire_a_stock_stop`, `stocks_need_two_outside_sources`, `trade_xyz_leverage_and_open_match_reference_sdk`, `one_bad_feed_cannot_fire`, `real_crash_fires_once`, `stop_level_never_in_output`, `guard_has_no_transfer_path`, `defence_ladder_steps`, and signature tests that match Hyperliquid's official Python SDK byte for byte (`order_signatures_match_reference_sdk`, `usd_send_digest_matches_reference_sdk`) and EAS's official SDK (`eas_offchain_attestation_matches_sdk`).

**2. The client library, the planner and the exit tool** (Node 20+):

```bash
cd client && npm ci && npm test
```

→ `174 passed`. The sealed-box tests open a box made by the Rust guard's reference and make one the guard opens (`sealed_call_from_ts_client_opens` on the Rust side). The planner's property tests check hundreds of random positions: sizes add up exactly, every piece is above Hyperliquid's $10 minimum, and no piece needs money from another. The exit tests check that the 12 words and the private key are never sent anywhere. The Chain Signatures tests (`chainsig.test.ts`) match the signer contract's hashes, rebuild the exact message piece C signed on mainnet, and recover NEAR's real MPC signature for it to piece C's Hyperliquid account.

**3. The server and its money flows:**

```bash
cd client && npm run build && cd ../server && npm ci && npm test
```

→ `223 passed`. Sign-in with a NEP-413 signature, encrypted wallet keys, deposits, funding, policy batches and read-back, ticks, refills and going home, with fake clocks and recorded replies. `chainsig.test.ts` runs a position and a trip home on NEAR-controlled pieces against a fake contract and MPC network that check signatures the way the real ones do; it refuses another key's signature, a wrong counter, a send back to perps and any token but USDC, and its relay transactions match near-api-js byte for byte.

**4. The signer contract** (Rust, needs `rustup`):

```bash
cd signer && cargo test
```

→ `test result: ok. 16 passed`. These include `typed_data_hash_matches_hyperliquid_sdk` (every action type against Hyperliquid's Python SDK), `signs_only_what_the_piece_key_signed`, `server_cannot_change_the_action`, `replay_refused` and `other_piece_key_refused`.

**5. The web app** (phone and desktop):

```bash
cd web && npm ci && npm test && npm run build && npx playwright test
```

→ 55 unit tests, then every screen in headless Chromium at 360×780 and 1280×800, with all outside requests blocked. Screenshots land in `web/screenshots/`.

**6. The MCP server for AI agents:**

```bash
cd client && npm run build && cd ../agent && npm ci && npm test
```

→ `6 passed`. Stops sealed on the agent's machine open only with the guard's key; a full MCP session opens, seals, reads status and closes; no tool answer and no request ever carries the stop price.

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
curl -s https://main.fastfs.io/4399fffd59abe3f29284d29936bf83d41e1344e82c971394660217cf6e8046f7/outlayer.near/9fcd15a786ae017bc180e1d968f3ddaa8aee81627c532ce7ca04a89a5c2687ce.wasm | sha256sum
```

→ both print `9fcd15a786ae017bc180e1d968f3ddaa8aee81627c532ce7ca04a89a5c2687ce`. `list_versions` with the same argument lists every guard build we have published, each with its hash and file address. The active build is [`guard/`](../guard/) at commit `045d307`.

[Back to the README](../README.md)
