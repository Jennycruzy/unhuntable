# Followers

A trader sells keys to their trading. A follower buys one. Nobody, the follower included, ever sees the trader's open positions, stops or piece accounts.

## The two keys

| | What the holder gets | What the holder never gets |
| --- | --- | --- |
| **Copy key** | Each crypto trade the trader opens, copied into the holder's own pieces: same market, side and leverage, the holder's own size. It closes when the trader's closes. | The trader's position, size, stop, take-profit, liquidation price or accounts. The holder sees only their own copy. |
| **Viewing key** | The trader's closed trades: market, side, size, leverage, entry, exit and result. | Anything open. A trade appears only once it is over, so it cannot be hunted or front-run. |

Stocks on trade.xyz are not copied: moving a follower's money onto trade.xyz needs the follower's pieces key, which only their browser holds.

## How a copy runs

1. The trader's position opens, on its own pieces and at its own random times, like any position.
2. For each copy key that is on, the server waits a random 30 seconds to 5 minutes, separately for each follower.
3. It opens the copy for the follower: the trader's market, side and leverage (at most 10x), the follower's size. A copy of $30 or more is split across several of the follower's pieces, with sizes and entry times from the follower's own VRF draw. A copy is at least $15, so each piece stays at least $12 after its size is rounded.
4. The copy is funded from the follower's private balance into their own pieces, the same way as any position. A follower whose pieces are all set up is copied without doing anything. A follower who needs new pieces gets an alert, and **Start my copy** in Positions makes them and locks them with one wallet approval.
5. When the trader's position starts closing, or a sealed stop closes it, every copy closes too, each on its own spread. A copy that has not started yet is called off. A copy that opens after the trader's position closed closes at once.

The follower can also seal their own stop on a copy, like on any position.

## Paying for a key

- **One approval.** Buying a key builds the private balance's lock again, now with the trader's private balance on its list, and the follower's NEAR wallet signs it. The server reads the lock back from chain before the key switches on.
- **Day by day.** While the key is on, the server sends one day's price by `POST /wallet/v1/confidential/transfer`, a private transfer on NEAR Intents' confidential shard from the follower's private balance to the trader's, and reads it until it settles. The first day is paid at once.
- **Only to that trader.** The lock is enforced by OutLayer: a transfer to an address that is not on the list is refused ("Address … is not in whitelist"). The server's key can pay the traders the follower approved, and no one else.
- **Stop any time.** Stopping a key stops the payments and the copies. Copies already open still close when the trader's does. A day already paid is not refunded.
- **A refused payment pauses the key** and says so. After a top-up, **Switch back on** pays the day again.
- **The trader never learns who pays.** Their alert says a key paid them, not whose.

Proven on mainnet: 0.05 USDC sent by private transfer from one confidential balance to another, locked one, arrived in full in about 10 seconds, with no public NEAR transaction and both wallets' public NEAR Intents balances at zero.

## The trader's record

- Every piece is registered with the guard, the first time it trades, under its owner's tag: `sha256("unhuntable-trader-v1:" + user id)`. The guard keeps the tag sealed with the piece.
- A tag is taken only at a piece's first registration. A piece registered without one stays without one, so nothing can be added to a record, or left out of it, once its trades are known.
- `record` sums every piece under a trader's tag from Hyperliquid inside the guard's TEE: equity now (perps, trade.xyz and spot USDC) and net deposits from the ledger. Result = equity − net deposits.
- The totals are signed by the guard's key as an EAS off-chain attestation under the schema `uint64 asOf,bytes32 trader,uint32 shards,int64 equityMicroUsd,int64 netDepositsMicroUsd,int64 pnlMicroUsd,string outlayerCall`. Its encoding and signature match the official EAS SDK byte for byte (`trader_record_matches_sdk`).
- On a trader's card, **Download the signed record** saves it; `node tools/easverify.cjs <file>` checks it with the official EAS SDK and prints the signer.
- No address leaves the guard. The card also shows closed trades and wins, read from each piece's fills on Hyperliquid once a position is closed.
- Proven on mainnet: the active guard signed a trader record that the official EAS SDK verifies (`sdk_verify: true`), recovering the guard's key `0xf0bd1e2b04f11c880d59bb75fd5bc31ff8331ee4` as signer.

## For agents

| MCP tool | What it does | Cost |
| --- | --- | --- |
| `unhuntable_traders` | Traders, prices, counts, closed results and the guard-signed record | Free |
| `unhuntable_trader_trades` | Closed trades of a trader the owner holds a key to | One paid call |
| `unhuntable_follow` | Asks the owner for a copy key (within the agent's largest size) or a viewing key; it waits until the owner approves it in the app | One paid call |

An agent cannot approve a key itself: only the owner's wallet can let the private balance pay a trader.

## Who sees what

- **Our server runs the copies and the payments.** It sees which follower copies which trader, as it sees every position. The trader and the public do not.
- **NEAR Intents' confidential shard is private to the public, not to everyone.** As OutLayer's docs say, its solvers, the shard operator, and auditors or law enforcement with a warrant can see confidential state.
- **The record counts pieces from the guard version that tags them.** Pieces that traded before it are not in any trader's record.
- **A copy fills later than the trader's position**, by design, so its price differs.

[Back to the README](../README.md)
