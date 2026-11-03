# unhuntable server

The backend base: an HTTP API, a SQLite store, a job runner, NEAR sign-in and a
client for the OutLayer wallet API. Node 20+, TypeScript, ESM.

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
SECRETS_FILE=/path/to/secrets.json DB_PATH=/var/lib/unhuntable/db.sqlite node dist/index.js
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

Secrets are read only from `SECRETS_FILE`, never from the environment or
anywhere else:

```json
{ "paymentKey": "...", "walletKeys": { "<wallet id>": "<wallet API key>" } }
```

The server refuses to start if group or others can read that file. Run
`chmod 600` on it.

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
  `policy_denied` refusal. Guard calls go through `GuardClient` from the client
  library, paid with the configured payment key.

## HTTP API

- `GET /api/health` → `{ "ok": true, "version": "<git sha or dev>" }`
- `POST /api/session` signs in (below) and sets the session cookie.
- `POST /api/logout` ends the session.
- `GET /api/evidence` → `{ "counts": { "<kind>": n } }` from the evidence table.
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

The tests use no network. HTTP goes through fakes, NEAR's key check is
injected, the job runner gets a fake clock, and the OutLayer replies are JSON
files in `test/fixtures/` with made-up values in the shapes seen on mainnet.
Keys are throwaway bytes.
