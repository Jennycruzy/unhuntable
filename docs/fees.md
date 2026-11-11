# Fees and revenue

How Unhuntable earns, with every fee shown to the user before it is paid.

## Aurora Intents integrator fee

Our Aurora key carries an integrator fee of 6 basis points on deposits through Aurora, shown in every quote. On mainnet, 2 USDC from Arbitrum arrived as 1.6827 USDC on a piece's Hyperliquid account with the fee applied.

## x402 agent calls

Each AI agent call costs 0.002 USDC on NEAR by default, paid with x402 to `unhuntable.near` and settled before the call runs. See [AI agents](ai-agents.md).

## Hyperliquid builder fee

The second revenue line is Hyperliquid's builder fee: a fee a front end may add to the orders it sends, once the account has approved it. Unhuntable's is **0.01% of the size, on opening orders only**, and the rules sit in code nobody at Unhuntable can change:

- **The NEAR contract caps it.** The signer contract signs a builder fee approval only for the one builder address it was built with, and only at exactly 0.01%. Hyperliquid would allow up to 0.1%; the contract refuses anything above 0.01% and any other builder, so a higher fee can never be approved for your pieces, by us or by anyone with the server.
- **Your pieces key approves it, once per piece.** It is one more action the browser signs when it sets up a new NEAR-controlled piece, after checking the builder and the rate against the contract itself through a public NEAR RPC. The review screen shows the fee and its most in dollars before you confirm.
- **It never touches a stop.** The guard adds the fee only when it opens a position on Hyperliquid's own market list. Stops, take-profits, defence cuts and closes never carry it, so a fee can never stand between a stop and its fill. trade.xyz stock orders do not carry it.
- **It never blocks a trade.** If Hyperliquid does not take the approval, the piece trades without the fee.

The server uses it only when `BUILDER_FEE=on` and the signer contract and the guard both report the same builder address. Hyperliquid accepts a builder only while that account holds at least 100 USDC in perps, so switching it on is: hold 100 USDC on the builder account, build the guard and the signer contract with `UNHUNTABLE_BUILDER=<that address>`, publish both, and set `BUILDER_FEE=on`. The whole path is tested end to end against Hyperliquid's own SDK hashes (`approve_builder_fee` vectors in `signer/src/hl_vectors.json`, and `the builder fee` tests in `server/test/chainsig.test.ts` and `web/test/chainsig.test.ts`).

[Back to the README](../README.md)
