# US stocks on trade.xyz

The same pieces and the same sealed stop, for US stocks and indexes.

[trade.xyz](https://trade.xyz) is a market list on Hyperliquid for US stocks and indexes. A position there is as public as any other: the account, the size, the liquidation price and every resting stop. Unhuntable trades it the same way it trades crypto, with three things done differently because stocks are different.

**Markets.** NVDA, TSLA, AAPL, MSFT, GOOGL, AMZN, META, AMD, MU, INTC, and the indexes XYZ100 and SP500. Pick "US stocks" on the Trade screen.

**Money moves by Chain Signatures.** trade.xyz keeps its own balance, apart from Hyperliquid's main one. A piece's USDC is moved onto trade.xyz with a `sendAsset` action from the piece to itself, and moved back the same way before going home. The piece key approves that exact action, `unhuntable.near` builds the Hyperliquid message itself, and NEAR's MPC network signs. The app only ever builds this action from a piece to itself, and nothing can be signed that the piece key did not approve. This is why stocks are traded only from NEAR-controlled pieces.

**Stops need prices from outside the book.** A stock stop fires only when at least 3 sources agree within 0.5%, and at least 2 of those are not the trade.xyz order book: trade.xyz's oracle, Yahoo Finance and Nasdaq. Outside prices count only when they are under 5 minutes old. So pushing the trade.xyz book alone can never fire your stop, and when US prices are not live (outside 04:00 to 20:00 New York time on trading days) the guard holds instead of guessing.

**Isolated margin.** trade.xyz markets use isolated margin, so each piece's risk is its own. The planner picks the leverage that keeps liquidation at least 18% away and tells you before you confirm.

**Leaving.** Going home and the [exit tool](leave-without-us.md) both close stock positions and move the money back from trade.xyz first.

**Proof on mainnet** (one piece, about $10.70 of NVDA, total cost under one cent):

| Step | Result |
| --- | --- |
| Piece moved 2.16 USDC onto trade.xyz | [NEAR signed in 8.8 s](https://nearblocks.io/txns/8LzpGyN9kKpDwMmYKihG1MXXbgHFbs9H3E9Ci7w1jL6Z); Hyperliquid answered `ok` |
| Guard set 6x isolated leverage and opened a short of 0.06 NVDA | [guard run](https://nearblocks.io/txns/HofQYerGRb1BgdThuEAgzyVfA7LwEA9pzAv4mj6oixLj): 4 of 4 price sources agreed; [filled at 178.10](https://app.hyperliquid.xyz/explorer/tx/0xdfdd58cd4df862ffe15704488de26802050700b2e8fb81d183a604200cfc3cea) |
| Stop sealed at 190, then one guard tick | Hyperliquid's public order list for the account was `[]` on both market lists; the [tick](https://nearblocks.io/txns/9vnaLswaPtZB6kfWt88jvwakxgScCPZ8FBU2964kuPV6) fired nothing |
| Stop sealed again at a price already crossed, then one guard tick | [The stop fired](https://nearblocks.io/txns/6ewnHXXtwTjBvqdEqYdDkoVc3oE3ew2b6prZ5MAVCz4c): a [reduce-only close at 178.22](https://app.hyperliquid.xyz/explorer/tx/0xe3658df9d0c075c3e4df04488de8bc02021800df6bc39495872e394c8fc44fae). A [second tick](https://nearblocks.io/txns/FxAXyJ5hnt15Xc5ukxH8GT4DebBEvALSYiDLtGyU3hMc) fired nothing |
| Piece moved its 2.150877 USDC back to the main balance | [NEAR signed in 8.7 s](https://nearblocks.io/txns/CALA24Gya1fLd8No2wzukUSM8cQ29eaBAUActpFLVGvc); Hyperliquid answered `ok` |

The account is [`0x35c9…b02a`](https://app.hyperliquid.xyz/explorer/address/0x35c99eff31255e9ac3fc2a3c6e4dd70cb026b02a): no private key for it exists, and both fills are on its public page.

[Back to the README](../README.md)
