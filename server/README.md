# unhuntable server

The backend: an HTTP API, a SQLite store, a job runner, NEAR sign-in, a client
for the OutLayer wallet API, and the money flows (deposits, pieces, positions,
going home, refills). Node 20+, TypeScript, ESM.

It never holds stop levels (they live only inside the guard) and never logs
secrets.

## Run it

The server uses the client library in `../client`, so build that first.

```bash
cd client && npm ci && npm run build
```

```bash
cd server && npm ci && npm run build
```

```bash
SECRETS_FILE=/path/to/secrets.json WALLET_KEYS_FILE=/path/to/wallet-keys.json \
  DB_PATH=/var/lib/unhuntable/db.sqlite GUARD_OWNER=guard.near GUARD_PROJECT=guard \
  APP_FEE_ACCOUNT=fees.near node dist/index.js
```

Settings come from the environment:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `HOST` | `127.0.0.1` | Address to listen on |
| `DB_PATH` | `unhuntable.sqlite` | SQLite file |
| `OUTLAYER_URL` | `https://api.outlayer.ai` | OutLayer API |
| `NETWORK` | `mainnet` | `mainnet` or `testnet`; every row is tagged with it |
| `NEAR_RPC_URL` | `https://rpc.<network>.near.org` | Used to check sign-in keys |
| `APP_NAME` | `unhuntable` | The NEP-413 recipient sign-ins must name |
| `CORS_ORIGINS` | none | Comma-separated origins allowed to call the API |
| `GIT_SHA` | `dev` | Shown by `/api/health` |
| `SECRETS_FILE` | required | Path of the secrets file |
| `WALLET_KEYS_FILE` | required | Path of the wallet key file the server writes (mode 600) |
| `HYPERLIQUID_URL` | `https://api.hyperliquid.xyz` | Hyperliquid API |
| `ONECLICK_URL` | `https://1click.chaindefuser.com` | Aurora Swap API (1Click) |
| `GUARD_OWNER` | none | NEAR account that owns the guard project on OutLayer |
| `GUARD_PROJECT` | none | Name of the guard project |
| `POLICY_CONTRACT` | `outlayer.near` | Contract that stores wallet policies |
| `APP_FEE_ACCOUNT` | none | Account in INTENTS that receives our fee on Aurora deposits |
| `HUNTMAP_DB` | none | Path of the Hunt Map collector's SQLite file; without it `/api/hunt-map` answers `{ "map": null }` |

Secrets are read only from `SECRETS_FILE`, never from the environment or
anywhere else:

```json
{ "paymentKey": "...", "walletKeys": { "<wallet id>": "<wallet API key>" },
  "keystoreKey": "<32 bytes as 64 hex characters>", "auroraKey": "..." }
```

`keystoreKey` encrypts the wallet key file. `auroraKey` is the Aurora Swap API
key; without it the aurora deposit route answers `route_unavailable`.

The server refuses to start if group or others can read the secrets file or the
wallet key file. Run `chmod 600` on both.

## What is in it

- `config.ts` reads the settings and the secrets file. A secrets object prints
  as `[redacted]` if it is ever logged.
- `log.ts` is pino with redaction. Fields named apiKey, paymentKey,
  authorization, key, secret, signature, stop, trigger or box are replaced, at
  any depth. So are values that look like a wallet API key (`wk_` and hex) or a
  64-hex key. Scrubbing runs on each finished log line, so it also covers
  messages and what fastify adds.
- `db.ts` opens SQLite and runs `src/migrations/*.sql` in name order, each once,
  recording them in the `migrations` table.
- `auth.ts` is sign-in with a NEP-413 signed message (see below).
- `refusals.ts` maps every refusal code to one plain sentence. Errors go out as
  `{ "error": code, "message": sentence }` with a fitting HTTP status.
- `jobs.ts` runs jobs from the `jobs` table: one job per idempotency key,
  at-least-once, backoff from 5 s doubling to 10 min, failed after 8 tries. A
  job left running by a crash runs again after restart, so handlers must be safe
  to run twice.
- `outlayer.ts` is a typed client for the OutLayer wallet API. Each call sends
  the wallet's API key as `Authorization: Bearer` and nothing else, and each
  POST sends a fresh `X-Idempotency-Key`. Error replies become
  `OutLayerWalletError` with OutLayer's code; `policy_denied` also carries our
  `policy_denied` refusal. It reads wallet keys from the secrets file and from
  the wallet key store.
- `keystore.ts` makes wallet API keys (`wk_` and 64 random hex characters) and
  keeps them in `WALLET_KEYS_FILE`, each encrypted with AES-256-GCM under
  `keystoreKey`. Only a key's hash leaves the store. Keys never appear in logs,
  errors or API answers.
- `guard.ts` is the one way the server calls the guard. Every op except
  `box_pub` goes as one sealed box. Each call writes a `guard_calls` row; ticks
  write `ticks` rows and orders write `piece_orders` rows. A box's contents are
  never logged or stored.
- `hl.ts` reads Hyperliquid (mids, meta, perp and spot balances) and posts
  actions that a piece's own key signed through OutLayer.
- `near.ts` reads NEAR RPC: access keys and view calls such as
  `get_wallet_policy`.
- `oneclick.ts` asks Aurora Swap (1Click) for quotes and status.
- `policy.ts` builds wallet policies and the batch the user signs, and reads
  policies back.
- `whale.ts` keeps the largest public position on Hyperliquid for the start
  page, read from the leaderboard and the public account state.
- `huntmap.ts` is the Hunt Map collector and `huntmap-run.ts` runs it as its own
  process (`HUNTMAP_DB=/path/huntmap.sqlite node dist/huntmap-run.js`). Every 5
  minutes it reads the 2,000 largest leaderboard accounts in turn, stores each
  position of $250,000 or more with its liquidation price, reads the resting
  stops of 40 holders, and stores one-minute candles for 12 markets. It needs no
  secrets, paces itself under Hyperliquid's request limit, and skips a round
  when the disk has under 400 MB free.
- `huntview.ts` turns that store into the map the site shows: money per percent
  from the price, the nearest accounts, and the count of visible levels the
  price went on to reach, beside the same distance on the other side.
- `hunter.ts` is Hunter's View: for one of the user's own positions it asks
  Hyperliquid's public API what it shows for each piece (account state and
  resting orders) and passes that on unchanged, kept for 15 seconds.
- `wallets.ts`, `deposits.ts`, `positions.ts`, `home.ts` and `watch.ts` are the
  money flows below; `routes.ts` puts them on the HTTP API and registers their
  jobs.

## Money flows

Every wallet a user has with us is an OutLayer deterministic wallet registered
by the user's browser with their pieces key. The private balance is the wallet
labelled `balance`; each piece is a wallet labelled `piece:<n>`, and its EVM
address is its own Hyperliquid account. For each wallet the server makes an API
key, keeps it encrypted, and gives the browser only its hash to add as a
delegate key.

### Money in

- **near**: OutLayer gives a cross-chain confidential deposit address for the
  private balance. The smallest deposit is 2 USDC. OutLayer's routing fee (about
  0.32 USDC) is shown as `feeUsd`. The deposit is done when the private balance
  grows.
- **aurora**: Aurora Swap (1Click) quotes any token it carries into USDC in the
  private balance account in INTENTS, with `confidentiality` "advanced". Refunds
  go to `refundTo`. Our fee is 6 bps; the route's own fee is in `feeUsd`. The
  token is the 1Click asset id.

A job checks each deposit every 15 s until it is done, refunded or expired. A
quote that runs out before anything arrives ends as `expired`
(`quote_expired`). Below the route's minimum, the quote is refused with
`deposit_below_min` and the minimum.

### Pieces: made, funded and locked

1. `/api/plan` shows the plan: pieces, sizes, funding per piece, fees, and the
   world as trackers see it (Account 1..N).
2. `/api/positions` draws the real VRF bytes from the guard and stores them with
   their proof. Locked pieces with no open position are used first; the rest
   are new wallets the browser must make (`needWallets`).
3. Funding: at each piece's VRF offset, the server withdraws the plan's
   `fundingUsd` from the private balance to that piece's own address (chain
   hypercore). A piece is never funded from another piece. It arrives in under 3
   minutes; the flat fee is about 0.32 USDC.
4. When it lands, the piece's own key approves the guard's agent for that shard
   on Hyperliquid, and the guard registers the piece's account.
5. The user signs one batch: one `store_wallet_policy` call per new piece on
   `outlayer.near`, plus the private balance update. A piece may send only to
   its own Hyperliquid account and to its owner, and cannot sign Hyperliquid
   actions (`evm_sign` off). The private balance may send only to the owner's
   pieces and the owner's own addresses. Each row costs about 0.0108 NEAR of
   storage; the call attaches 0.1 NEAR and the rest comes back.
6. `/api/policy/confirm` reads every policy back: on chain the owner must be the
   user, and at OutLayer `evm_sign` must be off. Only then are pieces `locked`.
   A piece that is not locked is never opened (`policy_not_set`).

If the private balance is already locked and new pieces are not on its list,
`/api/positions/:id/continue` first asks for a one-call batch that adds them,
before any funding.

### Open and close

At each piece's VRF slot the guard sets leverage and opens the piece's size.
Each fill is stored. A guard refusal becomes `stale_price`, `prices_disagree`,
`too_few_sources`, `over_cap` or `venue_rejected`, and the open is tried again.
If the guard does not answer after retries, the position keeps its state and
the API shows `"guard": "unreachable"`. Closing asks the guard to close each
piece, at VRF-staggered times inside 0-90 s, or at once with `now`.

Guard calls cost about $0.001 each.

### Watching and refills

Every open piece is ticked through the guard once per coin every 120 s, and at
once when the public mid (read every 5 s) leaves a piece's band. The server
knows only the band the guard gives back, never a stop.

When the guard cuts or closes a piece, the user gets a plain alert. With
`auto_refill` on and today's total under `refill_cap_usd_per_day`, a refill goes
from the private balance to that same piece: the smallest ladder amount that
covers the piece's planned reserve. One refill at a time per piece.

### Going home

`/api/home` builds an unlock batch (the same piece policies with `evm_sign` on)
and shows the fee: about 1.20 USDC per piece, because each deposit address is a
new Hyperliquid account (1 USDC) plus about 0.20 routing. After the unlock is
read back, for each piece: perp to spot, a fresh deposit address on the private
balance (chain hypercore, exact amount), send spot total minus 1 USDC, and wait
until the private balance grows. Pieces under 3 USDC stay where they are. Then
the user signs the relock batch; it is asked for even when a step failed. Every
step is listed by `/api/home/:id`.

### What needs the user's wallet

- Registering each wallet and adding our key's hash (browser, pieces key).
- One policy batch per new set of pieces (and the private balance update).
- Going home: one unlock batch and one relock batch.

## HTTP API

All JSON. Amounts are decimal strings in USDC, times are unix milliseconds.
Every route except health, session, logout, whale and hunt-map needs the `sid`
cookie.

- `GET /api/health` → `{ "ok": true, "version": "<git sha or dev>" }`
- `POST /api/session` signs in (below) and sets the session cookie.
- `POST /api/logout` ends the session.
- `GET /api/evidence` → `{ "counts": { "<kind>": n } }` from the evidence table.
- `GET /api/whale` → `{ whale }`: the largest public position right now, or
  `null`. No session needed.
- `GET /api/hunt-map` → `{ map }`: the Hunt Map, or `null` when no collector
  store is set. No session needed.
- `GET /api/me` → the account, whether the pieces key is on it, and its wallets.
- `POST /api/pieces-key` `{ publicKey }` stores the pieces key's public key once
  NEAR shows it on the account.
- `POST /api/wallets/key` `{ label }` → `{ requestId, keyHash }`.
- `POST /api/wallets/confirm` `{ requestId, label, seed }` proves our key works
  and saves the wallet → `{ ok, label, address }`.
- `GET /api/balance` → the private balance and each piece's perp and spot USD.
- `POST /api/deposit/quote` `{ route, chain, token, amount, refundTo }` → a
  deposit address and quote.
- `GET /api/deposit/:id` → `waiting`, `seen`, `done`, `refunded` or `expired`.
- `POST /api/plan` → a preview plan with fees and the world trackers see.
- `POST /api/positions` → `{ positionId, state, needWallets, policyBatch }`.
- `POST /api/positions/:id/continue` → the same, once wallets exist.
- `POST /api/policy/confirm` `{ positionId | homeId, txHashes }` reads the
  policies back → `{ ok, locked, unlocked }`.
- `GET /api/positions` → every position with its pieces and alerts.
- `GET /api/positions/:id/hunter` → `{ asOfMs, coin, markPx, accounts }`: each
  piece as Hyperliquid's public API shows it (address, side, size, value,
  liquidation price, resting orders, trigger prices). Owner only.
- `GET /api/guard/box-pub` → `{ boxPub }`.
- `POST /api/positions/:id/stop` `{ boxes: [{ shard, box }] }` forwards each
  box sealed in the browser to the guard, unchanged, with the shard outside.
- `POST /api/positions/:id/close` `{ now? }` → `{ ok, state }`.
- `POST /api/home` `{ labels? }` → `{ homeId, feeUsd, unlockBatch }`.
- `GET /api/home/:id` → state, steps, relock batch and USDC arrived.
- `GET /api/alerts` → the newest alerts.
- Anything else is 404 with a plain sentence.

Every answer has `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and
a CSP of `default-src 'none'`; the API serves no HTML. CORS headers are sent
only for origins in `CORS_ORIGINS`.

## Sign-in

The wallet signs a NEP-413 message and the app posts:

```json
{ "accountId": "alice.near", "publicKey": "ed25519:<base58>", "signature": "<base64>",
  "message": "Sign in to Unhuntable\n<ISO time>", "nonce": "<base64 of 32 bytes>",
  "recipient": "unhuntable" }
```

The server checks, in order: the recipient is `APP_NAME`; the time in the
message is within 5 minutes; the ed25519 signature is good over
`sha256(borsh(u32 2147484061) ‖ borsh({ message, nonce, recipient, callbackUrl }))`;
the nonce was not used in the last 10 minutes; and NEAR RPC `view_access_key`
says the key is a full-access key of the account. Each failure has its own code:
`wrong_recipient`, `stale_message`, `bad_signature`, `nonce_reused`,
`key_not_on_account`, or `near_unreachable`.

On success the server sets `sid` as an HttpOnly, Secure, SameSite=Strict cookie
for 12 hours. Only the cookie's sha256 is stored.

## Test

```bash
cd server
npm ci
npm run typecheck
npm test
```

The tests use no network. Every outside service gets an injected fetch, the job
runner gets a fake clock, and the replies of OutLayer, NEAR RPC, Hyperliquid,
Aurora and the guard are JSON files in `test/fixtures/` with made-up values.
Each newer fixture names the page it came from in its `source` field. Keys are
throwaway bytes, accounts are alice.near and bob.near.
