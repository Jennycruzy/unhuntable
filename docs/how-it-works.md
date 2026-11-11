# How it works

Every step of a position, the parts that run it, and why they are built this way.

## The life of one position

1. **Sign in** with a NEAR wallet (Meteor, HOT or MyNearWallet). The wallet signs a NEP-413 message; the server checks the signature and that the key is a full-access key of the account.
2. **Make your pieces key.** The browser makes 12 words and a key from them, and your wallet adds that key to your NEAR account as a limited key that can only call `outlayer.near`. Every wallet you have with us is an OutLayer deterministic wallet made from your account and this key, so the same 12 words always find them again.
3. **Deposit** from any chain. NEAR or Aurora Swap (1Click) sends the money into your confidential balance on NEAR Intents.
4. **Trade.** Pick market, side, size, leverage and hiding level. *Normal* is one piece. *Whale* is 2 to 12 pieces. Review shows each piece, every fee, and the accounts as the world will see them. The plan comes from VRF bytes drawn by the guard, so anyone can check it was not chosen by hand.
5. **Lock.** New pieces are NEAR-controlled: your browser makes each piece key from your 12 words, registers it on `unhuntable.near`, checks the piece's account with NEAR's MPC network, and signs the guard's agent approval. The contract is their lock. Your wallet signs one `store_wallet_policy` call on `outlayer.near` for your private balance, so it can send only to your pieces and to you; the server reads it back from chain before use.
6. **Fund and open.** At each piece's VRF time, the private balance funds that piece directly (never from another piece), NEAR's MPC network signs the agent approval your piece key made, and the guard opens the piece's size.
7. **Seal stops.** Your stop and take-profit are sealed in the browser, one box per piece, and forwarded unopened to the guard. The server never sees a level.
8. **Watch and defend.** The guard is ticked per coin every 2 minutes, and at once when the price leaves a piece's wake band. It fires stops and take-profits, and runs the defence ladder.
9. **Go home.** Your browser asks OutLayer for a deposit address of your own private balance and signs each piece's moves to it with the piece key; our server relays them through `unhuntable.near` and Hyperliquid gets them signed by NEAR. Pieces made as OutLayer wallets take one wallet approval to unlock and a second to lock again.

## Architecture

```
  Phone or desktop browser (web/)
   ├─ NEAR wallet: sign-in, pieces key, policy batches
   ├─ pieces key (12 words) kept encrypted in this browser
   └─ stops sealed here ───────────────┐ (boxes only the guard can open)
            │ HTTPS                    │
            ▼                          │
  Server (server/)                     │   NEAR mainnet
   ├─ plans, jobs, ticks               │    ├─ outlayer.near: wallet policies (owner = you)
   ├─ wallet API keys, encrypted       │    └─ unhuntable.near: Chain Signatures for piece accounts (v1.signer)
   └─ never holds a stop level         │
            │                          ▼
            ├──────────▶ OutLayer enclave: guard (guard/)
            │             ├─ one Hyperliquid agent key per piece, sealed
            │             ├─ sealed stops, VRF, up to 7 price sources
            │             └─ signs orders and the EAS track record
            │                          │
            ├──────────▶ OutLayer custody wallets ──▶ NEAR Intents confidential balance
            │                          │
            └──────────▶ Aurora Swap / 1Click (any-chain deposits)
                                       ▼
                         Hyperliquid: one account per piece
```

## Prices and stops

Each price round asks up to seven public sources (seven for crypto; for stocks, see [trade.xyz](us-stocks.md)). A price counts only when at least three agree within 0.5% of their median. With no agreement nothing fires, nothing is cut and nothing is closed, so one bad or bribed feed cannot fire a stop. A fire is marked in sealed storage with compare-and-swap before the order is sent, so a stop fires at most once even when two runs race. Every order the guard sends to make a position smaller is reduce-only and immediate-or-cancel, 3% through the agreed price.

## The defence ladder

| Distance to liquidation | Step |
| --- | --- |
| under 12% | cut 25% of the size |
| under 8% | cut another 25% |
| under 5% | close the piece |
| back to 15% or more | the ladder resets |

Each rung is saved before the order goes out and fires once, so a cut is not repeated while the price hovers. A cut that would be under Hyperliquid's $10 minimum, or leave less than $10, closes the piece instead.

## Engineering decisions

- **Seal the whole call, not just the stop.** After we recovered inputs from public hashes, every op except `addr` and `box_pub` became one sealed box: X25519, a SHA-256 key step and ChaCha20-Poly1305 with aad `unhuntable-call-v1`, plus a 32-byte salt. The op name is inside too.
- **One agent per piece.** Hyperliquid publishes which account an agent trades for. A shared agent would tie every piece together in one lookup.
- **The guard never touches money.** Funding and going home run through OutLayer custody wallets under your on-chain policy. The guard only trades.
- **Deterministic wallets.** Wallets come from your account and your 12 words, so the exit tool can always find them.
- **VRF for every random choice.** Piece sizes, entry times, stop jitter and wake-band edges come from OutLayer VRF, with the proof kept, so a plan can be checked later.
- **Hyperliquid's $10 minimum applies to closes too.** Every piece starts at $12 or more, and a defence cut that would go under $10 closes the piece instead of leaving dust nobody can close.
- **Exits cost about $1.20 per piece.** Hyperliquid charges 1 USDC to send to a new address, and each deposit address is new. The app shows this before you go home, and pieces under 3 USDC are left in place.

[Back to the README](../README.md)
