# Treasury mode: pieces that move only on a DAO vote

A team, a fund or a DAO can trade through Unhuntable and still require a vote before money moves. A piece's own key hands the piece to a DAO; from then on [`unhuntable.near`](https://nearblocks.io/address/unhuntable.near) signs for that piece only when the DAO itself asks, which for a Sputnik DAO means a proposal that passed.

## How it works

1. **The piece key hands the piece over, once.** It signs `unhuntable-controller-v1:<contract>:<piece key hex>:<counter>:<DAO account>` and anyone relays `set_controller`. The signature uses up one counter, so it cannot be used again.
2. **The piece key alone can no longer get anything signed.** `sign` with the piece key is refused: "this piece is controlled by another account; only that account can have it signed". No one member holding the 12 words can move a treasury's money.
3. **The DAO votes.** A proposal calls `sign_as_controller(piece_key, action)` on `unhuntable.near`. When it passes, the DAO makes the call, the contract checks the caller is the controller, builds the Hyperliquid action's hash itself and asks NEAR's MPC network to sign it. The same rules as always hold: only the account actions in [`signer/`](../signer/), only a builder fee at exactly 0.01%, never an order.
4. **The DAO can hand it on,** to another account, or back to the piece key, with `change_controller`. Only the controller can.

Trading itself does not wait for votes: the guard still opens, defends and closes with its agent key, which Hyperliquid forbids from moving money. What needs the vote is everything that moves money or changes who trades: going home, moving between market lists, approving an agent.

The client library builds every part of it: `signControllerHandover`, `setControllerArgs`, and `daoSignProposal`, which returns a ready Sputnik DAO `add_proposal` argument.

## Proof

On NEAR testnet, with a Sputnik DAO and NEAR's testnet MPC network (`v1.signer-prod.testnet`):

| Step | Result |
| --- | --- |
| A DAO was made with `sputnikv2.testnet` | `unhuntable-treasury.sputnikv2.testnet` |
| A piece key handed its piece to the DAO | `set_controller` logged the DAO as its controller |
| The piece key alone asked for a signature | Refused: "this piece is controlled by another account; only that account can have it signed" |
| The DAO proposed and passed "sign this Hyperliquid action for the piece" | Proposal #0 approved; NEAR's MPC network signed; the signature recovers to the piece's own Hyperliquid account `0xe3a8…1ee2` |

The same contract code runs on mainnet as `unhuntable.near`: its state carried over unchanged, and every piece made before keeps working as it did. The contract tests (`treasury_mode_*` in `signer/src/tests.rs`) cover the hand-over, the refusals and handing control back.

[Back to the README](../README.md)
