# The Hunt Map and Hunter's View

Two screens show the same fact from both sides, and both read only what Hyperliquid gives to anyone.

## The Hunt Map: the levels everyone can read

**Open [tryunhuntable.site/hunt-map](https://tryunhuntable.site/hunt-map/)** (no sign-in). You see, for each market, how many dollars are closed out at each percent from the price, and under it the accounts themselves: address, side, leverage, size and the exact price that liquidates them. Every address opens its public page on Hyperliquid, so each row can be checked by hand.

Where it comes from: a collector (`server/src/huntmap.ts`) runs beside the app with its own SQLite file and no secrets. Every 5 minutes it reads the 2,000 largest accounts on Hyperliquid's leaderboard in turn, keeps every position of $250,000 or more with its liquidation price, reads the resting stop orders of 40 holders per round, and stores one-minute candles for the 12 markets with the most money on visible levels.

The page then asks one question of that data: **when a level sits within 5% of the price, does the price go and reach it?** Each such level is followed for 24 hours. The page counts how many were reached, how many times the price went the same distance the other way (the fair comparison: a level with nobody on it), and how often the price was halfway back within the hour after a touch. The counts are shown as they are, starting from zero, and grow as the collector runs.

## Hunter's View: your own position, as the public sees it

**Open a position → look at "Hunter's view" on the Positions screen.** On the left is what you know: one position, your stop, your take-profit. On the right is what Hyperliquid's public API answers for each of your pieces: a separate account, its side, its size, its own liquidation price and the number of orders it has resting on the book. Each address opens its public page.

The sentence under the public side is built from Hyperliquid's answer and nothing else. With a sealed stop it reads "Hyperliquid shows 3 separate accounts and no stop or take-profit on the book." If an order of yours ever rests on the book, the same sentence counts it and says anyone can read it. If Hyperliquid cannot be read, the panel says so and shows no rows.

The server reads the same two public endpoints a tracker would (`clearinghouseState` and `frontendOpenOrders`), once per piece, and only for the signed-in owner of the position (`server/src/hunter.ts`).

[Back to the README](../README.md)
