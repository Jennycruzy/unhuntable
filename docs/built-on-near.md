# Built on NEAR

Every NEAR part below does a job the product cannot do without.

## NEAR Chain Signatures: Hyperliquid accounts with no private key

`unhuntable.near` ([`signer/`](../signer/)) controls a piece's Hyperliquid account. NEAR's MPC network (`v1.signer`) derives the piece's Hyperliquid account from this contract and the piece's own ed25519 key, so the account has no private key anywhere: not on our server, not in an enclave, not in a wallet.

The contract builds each Hyperliquid action's EIP-712 hash itself from typed fields and asks the MPC network to sign it only when the piece key signed that exact action with its current counter. It can sign six account actions (approve an agent, move USDC between spot and perp, move between market lists, withdraw, and two kinds of send), plus a builder fee approval only for the builder it was built with and only at 0.01% (see [the builder fee](fees.md#hyperliquid-builder-fee)), and nothing else: no orders, no account changes. Anyone may relay the call; a relay cannot get a signature without the piece key, change an amount or a destination, or replay an old request. The contract has no owner and no admin methods.

- Live: [`unhuntable.near`](https://nearblocks.io/address/unhuntable.near) runs on `v1.signer` with Hyperliquid mainnet.
- Approve the guard's agent for a piece through Chain Signatures: [NEAR tx `86qJbTWk…`](https://nearblocks.io/txns/86qJbTWkiXwXsKfCCWqK63yLanzvkbxikMj1R4HfufVd), signed by NEAR in 6.5 seconds for 0.0086 NEAR; Hyperliquid answered `ok`.
- The hashes match Hyperliquid's Python SDK for all seven action types (`signer/src/hl_vectors.json`).

How the app uses it, end to end:

- **Your 12 words make every piece key.** The browser derives piece *n*'s ed25519 key from your pieces key, registers it on `unhuntable.near`, and asks NEAR's MPC network (`v1.signer`) directly, not our server, which Hyperliquid account it controls. It signs only for `unhuntable.near` and only for the account NEAR derived.
- **The guard's agent is approved through NEAR.** The piece key signs the approval in your browser; when the piece's funding lands, our server relays it to `unhuntable.near`, NEAR's MPC network signs it, and the server checks the signature recovers to the piece's account before posting it to Hyperliquid.
- **No lock to sign, nothing to unlock.** The contract is the lock: a piece's money can move only on its own key's signature. Going home, your browser asks OutLayer for a deposit address of your own private balance and signs the moves to it; our server only relays them.
- **Leave without us.** The exit tool finds these pieces from your 12 words alone, closes an open position with a one-time agent key it makes and approves through the contract, and brings the money home. Any NEAR account can pay the gas; it cannot change what it relays.

## OutLayer TEE: the guard, the wallets and your rules

The guard ([`guard/`](../guard/)) is a Rust program that runs inside OutLayer's trusted execution environment (TEE: Intel TDX, attested). It holds one Hyperliquid agent key per piece, keeps your stops in sealed storage, draws every random choice from OutLayer's VRF, checks up to seven price sources, fires stops and runs the defence ladder. OutLayer custody wallets hold your private balance, under a policy stored on chain with **you** as owner: where money may go, and that Hyperliquid signing stays off. Our server cannot change it.

- A sealed-stop trade on a Chain Signatures piece: the public order list stayed empty (`[]`) while the position was open, and the stop fired as a reduce-only close.
- Policy changes approved by the owner's NEAR wallet and read back from chain before any money moved.
- We found and reported a privacy flaw in OutLayer's public call record ([out-layer/outlayer#35](https://github.com/out-layer/outlayer/issues/35)).
- **Followers' track records.** Every piece is registered with the guard under its owner's tag the first time it trades, and a tag is never added later. The guard sums every piece under a trader's tag from Hyperliquid inside the TEE and signs the totals as an EAS attestation, so a trader's record cannot leave out a losing piece and never shows an address. On mainnet the active guard signed a trader record that the official EAS SDK verifies, recovering the guard's key as signer. [Followers](followers.md)

## NEAR Intents and Confidential Intents: money in, between pieces and home, with no trail

Your private balance lives in NEAR Intents' confidential mode. Deposits arrive from any chain through 1Click; private transfers, private swaps and private withdrawals to each piece's own Hyperliquid account leave no public link between pieces. On Hyperliquid every piece is funded by 1Click's shared payer, the same sender as thousands of unrelated accounts a day.

- 15 USDT from BNB Chain in; 2.5 USDC swapped privately to NEAR; 2.5 USDC sent privately to a piece's Hyperliquid account, arriving as 2.178894 USDC.
- **Followers pay traders privately.** A key to a trader is paid day by day by a private transfer on the confidential shard (`/wallet/v1/confidential/transfer`), from the follower's private balance to the trader's. The follower's balance lock lists the trader, so the server's key can pay that trader and no one else. On mainnet, 0.05 USDC moved from one confidential balance to another, locked one in about 10 seconds, with no public NEAR transaction and both public Intents balances at zero. [Followers](followers.md)

## Aurora Intents: a second private door, and our revenue

Aurora's Swap API takes a deposit on any chain and lands it straight on a piece's Hyperliquid account in confidential mode. Our Aurora key carries an integrator fee of 6 basis points to `jennycruzy.near`, shown in every quote.

- 2 USDC from Arbitrum arrived as 1.6827 USDC on a piece's Hyperliquid account, under our Aurora key with the fee applied.

## NEAR accounts and wallets

Your NEAR account owns every wallet policy on `outlayer.near`, and only its signature can change one: on mainnet the owner's Meteor wallet stored and changed piece policies, and each was read back from chain before money moved. You sign in to the app with the same wallet (a NEP-413 message the server checks against your account's full-access keys). The 12 words that make your piece keys are yours; the exit tool uses them to bring money home with our servers off.

[Back to the README](../README.md)
