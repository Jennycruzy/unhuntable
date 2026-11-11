# Unhuntable web app

The phone-first web app. You sign in with a NEAR wallet, set up your pieces key,
deposit, trade, set invisible stops, close, and send your money home.

It is a static site: plain HTML and JavaScript, built once and served from one
origin. There is no server code in `web/`. Everything it shows comes from our
HTTP API, or is a plain sentence the API sent back.

## Words used on the screens

- **Pieces**: your position is split over separate small Hyperliquid accounts.
  Each one is a piece.
- **Pieces key**: a key made from 12 words. It signs for your pieces and your
  private balance.
- **Private balance**: the account your money waits in between trades.
- **Guard**: the program that watches prices for you and fires your stops.
- **Invisible stop**: a stop that doesn't exist until it fires. No order sits on
  the exchange for anyone to see.
- **As the world sees it**: what anyone looking at Hyperliquid sees: separate
  small accounts with nothing linking them.
- **Send home**: close your pieces and bring their money back to your private
  balance.

## Screens

- `/` Start. Who is signed in, the private balance, and the next thing to do.
- `/signin` Sign in with Meteor, HOT or MyNearWallet. The wallet signs a short
  message (NEP-413) and the app sends it to `POST /api/session`. If you have no
  NEAR wallet, it points you to deposit from MetaMask or Phantom first.
- `/setup` Your pieces key. It makes 12 words, shows them once and asks for 3 of
  them back. Then your wallet adds the key to your account as a limited key (it
  can only call `outlayer.near` and cannot spend NEAR), and the app makes your
  private balance wallet. You can forget the key on this device and restore it
  from your 12 words.
- `/deposit` Pick where the money comes from, get a quote, and send to the
  deposit address (with a copy button and a QR code drawn in the page). It
  checks every 5 seconds and tells you when the money is in your private
  balance.
- `/trade` Market, side, size, leverage and hiding level (Normal: 1 piece,
  Whale: several). Markets are Crypto or US stocks (trade.xyz); for stocks the
  review shows the isolated-margin leverage and says when stops can fire. When
  the builder fee is on, the review shows it ("0.01% when opening") and the most
  it can be. Review shows every piece, the fees, the exit fee and the
  accounts as the world sees them. Confirm makes any new piece wallets in your
  browser, asks your wallet once to approve the new pieces' policies, and seals
  your stop and take-profit if you gave them.
- `/positions` Your positions, checked every 10 seconds: each piece's size,
  entry, liquidation distance, guard status and whether a stop or take-profit is
  set. Move a stop or take-profit, close, close now, or send home. If the guard
  is not answering, it says so and offers Close now. Each open position
  also shows Hunter's view: what you see beside what Hyperliquid's public API
  shows for each piece (address, side, size, liquidation price, resting orders),
  read again every 15 seconds. Below the positions, Auto-refill: switch it on and
  set a daily limit, and a piece the guard cuts is topped back up from your
  private balance.
- `/hunt-map` The Hunt Map, open to everyone: the visible liquidation prices of
  Hyperliquid's largest accounts by market, the accounts nearest the price, and
  how often the price went on to reach a level everyone could read.
- `/agents` AI agents: make a key with limits (largest size, markets, opens per
  day), see it once with ready-to-paste MCP settings, see each call and its x402
  payment, revoke a key. Linked from the Start screen.
- `/home` Send home. It tells you the exit fee first, then asks your wallet
  twice: once to unlock the pieces and once to lock them again. A banner, "Lock
  your pieces again", stays on every screen until the second approval is
  confirmed. "Leave without us" opens the exit tool (`/exit/index.html`), which
  needs only your 12 words.

## What never leaves your browser

- **The 12 words and the pieces key's secret.** No API call, log or error
  carries them. The key is kept in this browser's IndexedDB, encrypted with
  AES-GCM under a WebCrypto key that is made non-extractable, so it can be used
  here but not read out. The server gets only the public key, and for each
  wallet its seed and a request to let our key act for it.
- **Your stop and take-profit levels.** Each level is sealed in the browser into
  a box only the guard can open (`client/src/box-browser.ts`), one box per
  piece. The server forwards the boxes and never sees a level. The levels you
  see on Positions come from this browser's own encrypted record; the API never
  returns them. On another device you see that a stop is set, not where.

## Run it

```bash
cd client && npm ci && npm run build
```

```bash
cd web && npm ci
```

```bash
NEXT_PUBLIC_API_URL=https://api.example.com npm run build
```

The site is in `web/out/`. Serve it from any static host. Settings, all read at
build time:

- `NEXT_PUBLIC_API_URL`: where our HTTP API is. Leave it empty when the API is
  on the same origin as the site. The API must allow this site's origin with
  credentials (its `CORS_ORIGINS`).
- `NEXT_PUBLIC_NEAR_NETWORK`: `mainnet` (the default) or `testnet`.
- `NEXT_PUBLIC_APP_NAME`: the sign-in recipient, the same as the server's
  `APP_NAME` (default `unhuntable`).

`npm run dev` runs it locally for development (without the CSP).

## Test it

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npm run build && npx playwright test
```

`npm test` runs the unit tests (vitest). They drive the flows with an injected
wallet and a recording `fetch`, and use no network.

The Playwright tests run headless Chromium at 360x780 and 1280x800 against the
static export, served with a small test server (`test/server.mjs`) that answers
our own API with fixed replies. Each test picks its replies with a `scenario`
cookie. A test wallet is put into wallet-selector as one more wallet module,
the same way the real wallets plug in. Every request to anywhere else is
blocked, so no test touches the real network. The tests save phone-size
screenshots of each screen in `web/screenshots/`.

The test wallet appears only when `window.__unhuntableTestWallet` is set before
the page loads, which only the Playwright tests do. Our pages run no inline
scripts except Next.js's own (allowed by hash) and load scripts only from our
origin, so a page can't set it.

## Content Security Policy

`npm run build` runs `scripts/csp.mjs` after `next build`. It fails the build
if any page loads a script from another origin, and adds this policy as a
`<meta>` tag at the top of every page:

- `default-src 'self'`
- `script-src 'self'` plus a sha256 hash of each inline script Next.js writes
  into that page. No `unsafe-inline`, no `unsafe-eval`.
- `style-src 'self'`, `font-src 'self'`, `img-src 'self' data:`. There are no
  outside fonts; the app uses the system font.
- `object-src 'none'`, `base-uri 'none'`, `form-action 'self'`.

`connect-src` is `'self'` plus:

| Origin | Why |
| --- | --- |
| the API origin from `NEXT_PUBLIC_API_URL` | our HTTP API |
| `https://rpc.mainnet.near.org` (`rpc.testnet.near.org` on testnet) | the NEAR RPC wallet-selector and the wallets use to read accounts and keys |
| `https://free.rpc.fastnear.com` (`test.rpc.fastnear.com` on testnet) | wallet-selector's built-in fallback NEAR RPC |
| `https://mw.rpc.fastnear.com` | the NEAR RPC the Meteor wallet module calls |
| `https://h4n.app` | the HOT wallet relay: HOT passes sign requests and answers through it |
| `https://api.outlayer.ai` | OutLayer: the browser registers your wallets and adds our key to them, signed with your pieces key |

`frame-src https://hot-labs.org`: HOT opens its sign-in widget in a frame from
there.

MyNearWallet and Meteor open their own pages in a new window, which the policy
does not need to allow. "Check it yourself" links open Hyperliquid's public
account page (`app.hyperliquid.xyz`) in a new tab; the app never calls
Hyperliquid itself.

A `<meta>` policy can't set `frame-ancestors`. Have the static host also send
`Content-Security-Policy: frame-ancestors 'none'` and `Referrer-Policy:
no-referrer`.
