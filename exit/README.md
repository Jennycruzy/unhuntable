# Exit without us

This tool brings your money home from unhuntable using only your 12 words. It
works even if our servers, our domain and our team are gone.

## Who it is for

Anyone with money in unhuntable who cannot use our app, or does not want to.

## What it needs

- Your 12 words: the pieces key phrase you wrote down when you set up
  unhuntable.
- Your NEAR account, for example `alice.near`.
- An address to send the money to, on NEAR, Base or Arbitrum.
- OutLayer (`api.outlayer.ai`) and Hyperliquid (`api.hyperliquid.xyz`) being
  up. Your wallets live on OutLayer, and your positions live on Hyperliquid.

Your words never leave your computer. The tool signs with the key made from
them and sends only those signatures. It talks to three places only:
`api.outlayer.ai`, `api.hyperliquid.xyz` and a NEAR RPC
(`rpc.mainnet.near.org`). It has no analytics and loads no third-party scripts.

## What it does

1. Checks that your words belong to your NEAR account.
2. Finds your wallets on OutLayer: your private-balance wallet and one wallet
   per position piece. Every wallet comes from your account and your words,
   so nothing else is needed to find them.
3. For each piece wallet, reads its Hyperliquid account.
4. Closes any open position with a reduce-only order 3% through the market
   price.
   Stock positions on trade.xyz are closed the same way, and their USDC is
   moved back from trade.xyz to the main balance first.
5. Moves all USDC from perps to spot.
6. Sends the spot USDC to a deposit address that lands in your private
   balance, and waits until it arrives.
7. Sends your private balance to the address you named. It shows you what will
   arrive first and only sends after you type `yes`.
8. If you give it our server key hash, offers to remove our server's access to
   all your wallets.

Each step says in plain words what it is doing. If a step cannot go on, the
tool stops and says why. It never skips a step quietly.

Two things may need your hand on the way:

- **EVM signing is off for a wallet.** Open app.outlayer.ai, go to Wallets,
  choose that wallet and switch EVM signing on in its policy. Then press Enter
  and the tool tries again.
- **Your destination is not on the wallet's whitelist.** Add it to your
  private-balance wallet's address whitelist on app.outlayer.ai, then press
  Enter.

## What it costs

About $1.20 per piece leaving Hyperliquid: Hyperliquid's 1 USDC fee for
sending to a new address, plus routing. If a piece holds less than 3 USDC,
under 2 USDC would arrive after the fee. The tool leaves that piece alone and
tells you so.

## Run it from the page

Open `index.html` in a browser, from disk or from any static host. It needs
`exit.js` next to it. Enter your words, account and destination, then press
Start.

`exit.js` is built from `page.ts` and the client library. To check that it
matches the source, rebuild it and compare:

```bash
cd client && npm ci
```

```bash
cd exit && npm ci && npm run build && git diff --exit-code exit.js
```

## Run it from a terminal

You need Node 20 or newer.

```bash
cd client && npm ci
```

```bash
cd .. && npx tsx exit/cli.ts
```

The tool asks for your words, which are not shown as you type, then your
account and destination. You can also pass
`--account alice.near --chain near --to alice.near` and
`--server-key-hash <hash>`.
