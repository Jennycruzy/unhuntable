# Unhuntable

**On Hyperliquid, anyone can see the price that wipes you out. near.com hides your name, not that price. Unhuntable hides the price.**

> Every Hyperliquid account is public: its size, its entry, the exact price that liquidates it, and every stop-loss resting on the book. NEAR's own near.com already makes perps confidential, so nobody can tie a position back to you. But hunters do not need your name. They push the price to the level they can read on the book, take the liquidation, and the market watches.

**Unhuntable removes the level itself.** Your position is split across separate Hyperliquid accounts ("pieces") that nobody can tie together, so there is no big position to find. Your stop-loss is sealed inside an attested enclave and is not on the book until the moment it fires. A guard watches every piece and cuts size before liquidation, and Hyperliquid itself refuses it when it tries to move money. A piece's Hyperliquid account can be controlled by **NEAR Chain Signatures**, under a contract that signs only what that piece's own key approved: no private key for the account exists anywhere, and our server cannot sign a thing.

Tracks: **Privacy & Private AI** · **Unstoppable DeFi** · **AI Security & Defense**

### The NEAR stack, all on mainnet

| | What it does in Unhuntable | Proof on mainnet |
| --- | --- | --- |
| **NEAR Chain Signatures** | `unhuntable.near` asks `v1.signer` to sign Hyperliquid actions for a piece, so the piece's Hyperliquid account has no private key anywhere | [`unhuntable.near`](https://nearblocks.io/address/unhuntable.near) · [approve-agent tx](https://nearblocks.io/txns/86qJbTWkiXwXsKfCCWqK63yLanzvkbxikMj1R4HfufVd) · [the account it controls](https://app.hyperliquid.xyz/explorer/address/0x35c99eff31255e9ac3fc2a3c6e4dd70cb026b02a) |
| **NEAR Intents (Confidential)** | Holds your private balance and funds each piece with no public link between pieces | 2.5 USDC sent privately to a piece, arriving as 2.178894 USDC |
| **1Click** | Deposits from any chain, and pays out to Hyperliquid through a shared payer used by thousands of accounts | [15 USDT in from BNB Chain](#what-ran-on-mainnet-with-real-money); ~2,000 shared-payer sends to 991 accounts in 12 hours |
| **Aurora Intents** | A second private way in, straight to a piece's Hyperliquid account, with our 6 basis point integrator fee | 2 USDC from Arbitrum landed as 1.6827 USDC, fee applied |
| **OutLayer enclave** | Runs the guard: sealed stops, one agent key per piece, seven price sources, the defence ladder | Sealed-stop trade: public order list `[]` while open, then a reduce-only close |
| **OutLayer VRF** | Draws piece sizes, entry times and stop jitter, with proofs anyone can check | Each plan stores its VRF output and proof |
| **OutLayer custody + on-chain policies** | Your wallets, under policies owned by **your** NEAR account that our server cannot change | Policies stored by the owner's Meteor wallet and read back from chain before money moved |
| **NEAR wallets (NEP-413)** | Sign-in, the pieces key, every policy approval | Meteor on mainnet; HOT and MyNearWallet supported |
| **EAS** | A signed track record from the guard, totals only | Verifies with the official EAS SDK |
| **Security work for OutLayer** | Found and reported a flaw that leaked call inputs from public records | [out-layer/outlayer#35](https://github.com/out-layer/outlayer/issues/35) |

[Built on NEAR](#built-on-near) · [What ran on mainnet](#what-ran-on-mainnet-with-real-money) · [Check it yourself](#check-it-yourself) · [How it works](#how-it-works) · [Who could cheat](#who-could-cheat-and-why-they-cannot) · [Privacy](#privacy-who-sees-what) · [Leave without us](#leave-without-us) · [Security finding for OutLayer](#work-for-outlayer)

---

## Built on NEAR

Every NEAR piece below does a job the product cannot do without, and each has run on NEAR mainnet.

### NEAR Chain Signatures: Hyperliquid accounts with no private key

`unhuntable.near` ([`signer/`](signer/)) controls a piece's Hyperliquid account. NEAR's MPC network (`v1.signer`) derives the piece's Hyperliquid account from this contract and the piece's own ed25519 key, so the account has no private key anywhere: not on our server, not in an enclave, not in a wallet.

The contract builds each Hyperliquid action's EIP-712 hash itself from typed fields and asks the MPC network to sign it only when the piece key signed that exact action with its current counter. It can sign six account actions (approve an agent, move USDC between spot and perp, move between market lists, withdraw, and two kinds of send) and nothing else: no orders, no builder fees, no account changes. Anyone may relay the call; a relay cannot get a signature without the piece key, change an amount or a destination, or replay an old request. The contract has no owner and no admin methods.

- Live: [`unhuntable.near`](https://nearblocks.io/address/unhuntable.near) runs on `v1.signer` with Hyperliquid mainnet.
- Approve the guard's agent for a piece through Chain Signatures: [NEAR tx `86qJbTWk…`](https://nearblocks.io/txns/86qJbTWkiXwXsKfCCWqK63yLanzvkbxikMj1R4HfufVd), signed by NEAR in 6.5 seconds for 0.0086 NEAR; Hyperliquid answered `ok`.
- The hashes match Hyperliquid's Python SDK for all six action types (`signer/src/hl_vectors.json`).

### OutLayer: the guard, the wallets and your rules

The guard ([`guard/`](guard/)) is a Rust program that runs inside OutLayer's attested enclave. It holds one Hyperliquid agent key per piece, keeps your stops in sealed storage, draws every random choice from OutLayer's VRF, checks seven price sources, fires stops and runs the defence ladder. OutLayer custody wallets hold your private balance, under a policy stored on chain with **you** as owner: where money may go, and that Hyperliquid signing stays off. Our server cannot change it.

- A sealed-stop trade on a Chain Signatures piece: the public order list stayed empty (`[]`) while the position was open, and the stop fired as a reduce-only close.
- Policy changes approved by the owner's NEAR wallet and read back from chain before any money moved.
- We found and reported a privacy flaw in OutLayer's public call record ([out-layer/outlayer#35](https://github.com/out-layer/outlayer/issues/35)).

### NEAR Intents and Confidential Intents: money in, between pieces and home, with no trail

Your private balance lives in NEAR Intents' confidential mode. Deposits arrive from any chain through 1Click; private transfers, private swaps and private withdrawals to each piece's own Hyperliquid account leave no public link between pieces. On Hyperliquid every piece is funded by 1Click's shared payer, the same sender as thousands of unrelated accounts a day.

- 15 USDT from BNB Chain in; 2.5 USDC swapped privately to NEAR; 2.5 USDC sent privately to a piece's Hyperliquid account, arriving as 2.178894 USDC.

### Aurora Intents: a second private door, and our revenue

Aurora's Swap API takes a deposit on any chain and lands it straight on a piece's Hyperliquid account in confidential mode. Our Aurora key carries an integrator fee of 6 basis points to `jennycruzy.near`, shown in every quote.

- 2 USDC from Arbitrum arrived as 1.6827 USDC on a piece's Hyperliquid account, under our Aurora key with the fee applied.

### NEAR accounts and wallets

Your NEAR account owns every wallet policy on `outlayer.near`, and only its signature can change one: on mainnet the owner's Meteor wallet stored and changed piece policies, and each was read back from chain before money moved. You sign in to the app with the same wallet (a NEP-413 message the server checks against your account's full-access keys). The 12 words that make your piece keys are yours; the exit tool uses them to bring money home with our servers off.

---

## The problem, the answer, the proof

**The problem.** Hyperliquid is the biggest onchain perps exchange, and it is fully transparent. A public account page shows a position, its liquidation price and its resting stop and take-profit orders to anyone. Stop hunting is not a theory there: big positions are tracked by bots and public dashboards, and the price is pushed to the levels everyone can see.

The same problem shows up across all public chains. In [NEP discussion #531](https://github.com/near/NEPs/issues/531), Illia Polosukhin notes that users end up spreading their activity over many separate accounts to keep it apart, and that the answer lives in the application layer. Unhuntable is that answer for perps: the separate accounts are made and funded for you, from your one NEAR account.

**The answer.** Three things a trader on Hyperliquid cannot get today, together:

1. **Pieces nobody can tie together.** A position is split into 2 to 12 accounts. Each is funded separately from a confidential balance on NEAR Intents and arrives through the same shared payer that funds thousands of other Hyperliquid accounts a day. Sizes are randomised and entries are spread over minutes, with the timing drawn from a VRF anyone can check.
2. **Stops that do not exist until they fire.** No stop order rests on Hyperliquid. The level is sealed in your browser into a box only the guard can open, and the guard runs inside an OutLayer enclave. When at least three of seven public price sources agree the level is crossed, the guard sends a reduce-only market order. Nobody can see where it is, including us.
3. **A guard that defends but cannot steal.** The guard holds one Hyperliquid *agent* key per piece. An agent key can place and cancel orders; Hyperliquid refuses any transfer it signs. The guard cuts size on a ladder as liquidation gets close, and it has no way to move money out.

**The proof.** We ran it on Hyperliquid mainnet with real money (table below), attacked our own pieces with only public data, and found and reported a privacy flaw in OutLayer's public call record that would have exposed sealed stops. Everything else in this repo is tested offline: about 370 tests across the guard, the signer, the client, the server, the records contract and the app, all in CI.

---

## What ran on mainnet with real money

All of these are observed results on NEAR, NEAR Intents, OutLayer and Hyperliquid mainnet with small amounts, except the one row marked testnet.

| What we did | What happened |
| --- | --- |
| Deployed the signer contract as `unhuntable.near` | Running on NEAR mainnet with `v1.signer` and Hyperliquid mainnet; no owner, no admin methods. |
| Registered a piece key and asked NEAR for its Hyperliquid account | `v1.signer` derived the account from `unhuntable.near` and the key; it was the same account we computed before the contract existed. |
| Funded that piece privately: 2.5 USDC from a confidential balance | Arrived as 2.178894 USDC on the piece's Hyperliquid account. |
| The piece key approved the guard's agent; the contract asked NEAR to sign | NEAR's MPC network signed in 6.5 seconds for 0.0086 NEAR. Hyperliquid answered `ok` and lists the guard's key as that account's agent. |
| The guard opened a 5x long of 0.0047 ETH on that piece and sealed a stop | Filled at 2244.0. Hyperliquid's public order list for the account was empty (`[]`) while the position was open. |
| The sealed stop was moved above the price and the guard ticked | The stop fired as a reduce-only close at 2243.6, with 7 of 7 price sources agreeing. A second tick fired nothing. The whole trade cost about one cent. |
| Asked the contract to sign the same request twice (NEAR testnet) | Refused: "the piece key did not sign this action". |
| Deposited 15 USDT from BNB Chain into an OutLayer wallet | Arrived as 14.978224 USDC in the wallet's NEAR Intents balance, then moved into its confidential balance. |
| Moved 3 USDC from a confidential balance to a piece's own Hyperliquid account | Arrived as 2.678831 USDC in the piece's perp account in under 3 minutes, sent by 1Click's shared payer, which made about 2,000 sends to 991 different accounts in the same 12 hours. |
| The piece's own wallet approved the guard's agent key | Hyperliquid answered `ok`. |
| The guard set leverage and opened a long of 0.0045 ETH | 7 of 7 price sources agreed; filled at 2266.7. |
| A sealed stop was set, then one guard tick ran | The stop fired once: a reduce-only close filled at 2266.6. A second tick reported nothing left to fire. No stop order ever sat on the book. |
| The guard's agent key tried to send 1 USDC out of the piece | Hyperliquid refused it: an agent's transfer counts as the agent's own empty account. The piece's balance did not change. |
| The guard signed a track-record proof | An EAS off-chain attestation with totals only (2 pieces, equity, net deposits, PnL). It verifies with the official EAS SDK and recovers the guard's key as signer. No address leaves the guard. |
| We attacked our own piece with public data only | Funding origin, amount fingerprint, agent reuse and the private withdraw's public status: **not linked**. Input recovery from OutLayer's public call record: **linked**, before we sealed every call. **Not linked** after. ([details](#attacks-we-ran-on-our-own-pieces)) |

---

## Check it yourself

No keys, no wallet, no money, no network. Each step is "do this → you see that".

**1. The guard's decisions** (Rust, needs `rustup`):

```bash
cd guard && cargo test --lib --test guard_tests
```

→ `test result: ok. 31 passed`. These include `one_bad_feed_cannot_fire`, `real_crash_fires_once`, `stop_level_never_in_output`, `guard_has_no_transfer_path`, `defence_ladder_steps`, and signature tests that match Hyperliquid's official Python SDK byte for byte (`order_signatures_match_reference_sdk`, `usd_send_digest_matches_reference_sdk`) and EAS's official SDK (`eas_offchain_attestation_matches_sdk`).

**2. The client library, the planner and the exit tool** (Node 20+):

```bash
cd client && npm ci && npm test
```

→ `137 passed`. The sealed-box tests open a box made by the Rust guard's reference and make one the guard opens (`sealed_call_from_ts_client_opens` on the Rust side). The planner's property tests check hundreds of random positions: sizes add up exactly, every piece is above Hyperliquid's $10 minimum, and no piece needs money from another. The exit tests check that the 12 words and the private key are never sent anywhere.

**3. The server and its money flows:**

```bash
cd client && npm run build && cd ../server && npm ci && npm test
```

→ `133 passed`. Sign-in with a NEP-413 signature, encrypted wallet keys, deposits, funding, policy batches and read-back, ticks, refills and going home, with fake clocks and recorded replies.

**4. The records contract** (needs `cargo-near`, see `contract/README.md`):

```bash
cd contract && cargo test
```

→ unit tests plus sandbox tests on a local NEAR node: owner-only and operator-only methods, the 64-hex hash rule, fee totals that add up, exact storage refunds, and NEP-297 events.

**5. The signer contract** (Rust, needs `rustup`):

```bash
cd signer && cargo test
```

→ `test result: ok. 12 passed`. These include `typed_data_hash_matches_hyperliquid_sdk` (every action type against Hyperliquid's Python SDK), `signs_only_what_the_piece_key_signed`, `server_cannot_change_the_action`, `replay_refused` and `other_piece_key_refused`.

**6. The web app** (phone and desktop):

```bash
cd web && npm ci && npm test && npm run build && npx playwright test
```

→ 25 unit tests, then every screen in headless Chromium at 360×780 and 1280×800, with all outside requests blocked. Screenshots land in `web/screenshots/`.

**7. The exit tool is exactly its source:**

```bash
cd exit && npm ci && npm run build && git diff --exit-code exit.js
```

→ no diff. The page you would open to leave without us is the code you can read.

**8. Attack any Hyperliquid account with public data** (network, read-only, at most 5 requests a second):

```bash
python3 attacks/linking_attacks.py 0x<any Hyperliquid address>
```

→ for each attack, `LINKED`, `NOT LINKED` or `PARTIAL`, with the evidence, written to `linking-report.json`.

---

## How it works

### The life of one position

1. **Sign in** with a NEAR wallet (Meteor, HOT or MyNearWallet). The wallet signs a NEP-413 message; the server checks the signature and that the key is a full-access key of the account.
2. **Make your pieces key.** The browser makes 12 words and a key from them, and your wallet adds that key to your NEAR account as a limited key that can only call `outlayer.near`. Every wallet you have with us is an OutLayer deterministic wallet made from your account and this key, so the same 12 words always find them again.
3. **Deposit** from any chain. NEAR or Aurora Swap (1Click) sends the money into your confidential balance on NEAR Intents.
4. **Trade.** Pick market, side, size, leverage and hiding level. *Normal* is one piece. *Whale* is 2 to 12 pieces. Review shows each piece, every fee, and the accounts as the world will see them. The plan comes from VRF bytes drawn by the guard, so anyone can check it was not chosen by hand.
5. **Lock.** Your wallet signs one batch of `store_wallet_policy` calls on `outlayer.near`. A piece may send only to its own Hyperliquid account and back to you, and cannot sign Hyperliquid actions. The server reads every policy back from chain before a piece is used.
6. **Fund and open.** At each piece's VRF time, the private balance funds that piece directly (never from another piece), the piece approves the guard's agent, and the guard opens the piece's size.
7. **Seal stops.** Your stop and take-profit are sealed in the browser, one box per piece, and forwarded unopened to the guard. The server never sees a level.
8. **Watch and defend.** The guard is ticked per coin every 2 minutes, and at once when the price leaves a piece's wake band. It fires stops and take-profits, and runs the defence ladder.
9. **Go home.** One wallet approval unlocks the pieces. Each piece closes, moves its USDC back to your private balance through a fresh deposit address, and a second approval locks the pieces again.

### Architecture

```
  Phone or desktop browser (web/)
   ├─ NEAR wallet: sign-in, pieces key, policy batches
   ├─ pieces key (12 words) kept encrypted in this browser
   └─ stops sealed here ───────────────┐ (boxes only the guard can open)
            │ HTTPS                    │
            ▼                          │
  Server (server/)                     │   NEAR mainnet
   ├─ plans, jobs, ticks, refills      │    ├─ outlayer.near: wallet policies (owner = you)
   ├─ wallet API keys, encrypted       │    ├─ unhuntable.near: Chain Signatures for piece accounts (v1.signer)
   │                                   │    └─ records contract: piece hashes, guard builds, fees
   └─ never holds a stop level         │
            │                          ▼
            ├──────────▶ OutLayer enclave: guard (guard/)
            │             ├─ one Hyperliquid agent key per piece, sealed
            │             ├─ sealed stops, VRF, 7 price sources
            │             └─ signs orders and the EAS track record
            │                          │
            ├──────────▶ OutLayer custody wallets ──▶ NEAR Intents confidential balance
            │                          │
            └──────────▶ Aurora Swap / 1Click (any-chain deposits)
                                       ▼
                         Hyperliquid: one account per piece
```

### Prices and stops

Each price round asks seven public sources. A price counts only when at least three agree within 0.5% of their median. With no agreement nothing fires, nothing is cut and nothing is closed, so one bad or bribed feed cannot fire a stop. A fire is marked in sealed storage with compare-and-swap before the order is sent, so a stop fires at most once even when two runs race. Every order the guard sends to make a position smaller is reduce-only and immediate-or-cancel, 3% through the agreed price.

### The defence ladder

| Distance to liquidation | Step |
| --- | --- |
| under 12% | cut 25% of the size |
| under 8% | cut another 25% |
| under 5% | close the piece |
| back to 15% or more | the ladder resets |

Each rung is saved before the order goes out and fires once, so a cut is not repeated while the price hovers. A cut that would be under Hyperliquid's $10 minimum, or leave less than $10, closes the piece instead. With auto-refill on, a cut or closed piece can be topped up from your private balance, up to a daily cap you set.

---

## Who could cheat, and why they cannot

| Who | What they might try | What stops them | Where to check |
| --- | --- | --- | --- |
| The guard (or whoever deploys it) | Move your money out | It only holds Hyperliquid agent keys, and Hyperliquid refuses transfers signed by an agent. Observed on mainnet. | `guard_has_no_transfer_path`; `withdraw_probe` op |
| Our server | Send a piece's money somewhere else | Each piece's on-chain policy, owned by you, allows sends only to its own Hyperliquid account and to you, with EVM signing off. The server reads each policy back from chain before using a piece. | `server/src/policy.ts`, `server/test/policy.test.ts` |
| Our server | Get a signature for a Chain Signatures piece | `unhuntable.near` signs only when the piece's own key signed that exact action; the server only relays. | `signs_only_what_the_piece_key_signed`, `other_piece_key_refused` |
| A relay | Change an amount or destination, or replay a request | The piece key signs the contract, the counter and the action's hash; any change or repeat fails the check. | `server_cannot_change_the_action`, `replay_refused` |
| Our server | Learn your stop | Stops are sealed in your browser to the guard's key. The server forwards boxes it cannot open. | `client/src/box-browser.ts`, `stop_level_never_in_output` |
| Our server | Run one user's call as another's piece | The plain shard id next to a sealed call must equal the one inside the box, or the guard refuses. | `outer_shard_must_match_box` |
| One price source | Fire your stop with a fake print | Three of seven sources must agree within 0.5%. | `one_bad_feed_cannot_fire`, `one_bad_feed_cannot_fire_tp` |
| Two guard runs at once | Fire a stop twice | Compare-and-swap in sealed storage before any order. | `real_crash_fires_once`, `tp_fires_once` |
| Anyone replaying a call | Reuse a sealed call | Each box has a fresh ephemeral key, nonce and 32-byte salt; a box made for one piece does not open as another. | `client/test/box.test.ts` |
| Us, gone | Leave your money stuck | Your wallets come from your 12 words; the exit tool finds and empties them using OutLayer and Hyperliquid directly. | `exit/`, `client/test/exit.test.ts` |

What you do trust: OutLayer's enclave holds the keys, and its attestation names the exact guard build that ran. `check_guard` on the records contract answers whether a wasm hash is one of our published guard builds, so anyone can compare a run's hash with that list and with their own build.

---

## Privacy: who sees what

| Who | Sees | Does not see |
| --- | --- | --- |
| Anyone on Hyperliquid | Each piece as a separate small account: its size, entry and PnL | Which pieces belong together, who owns them, where the money came from, any stop or take-profit |
| Anyone reading NEAR Intents | Deposits into the confidential balance | Where the money goes from there |
| Anyone reading OutLayer's public call record | That our guard ran, when, and a hash of ciphertext | The op, the piece, the size, the stop |
| Our server | Which pieces are yours, their sizes, the wake bands the guard returns | Your stops, your 12 words, any way to move your money |
| The guard, inside the enclave | Your stops, to fire them | Your 12 words |

### Attacks we ran on our own pieces

The attacker knows one piece's Hyperliquid address and uses only public data.

| Attack | Result |
| --- | --- |
| Trace the funding | **Not linked.** Funded by 1Click's shared payer: about 2,000 sends to 991 accounts in 12 hours. |
| Match the amount | **Not linked.** The amount comes from a confidential balance, so there is no public transfer to match. |
| Recover inputs from OutLayer's public call record | **Linked before, not linked after.** The record kept an unsalted hash of each call's input, so we recovered a stop price from it by guessing. Every call now goes as one sealed box with a 32-byte salt, and the three calls after the fix gave nothing. |
| Follow the agent key | **Not linked.** Hyperliquid shows which account an agent trades for, so each piece gets its own agent and agents are never shared. |
| Read the private withdraw's public status | **Not linked.** 1Click's public status page has no record of it. |
| Line up guard call times with fills | Shows that an account uses Unhuntable's guard, because OutLayer publishes when a project runs. It does not show the owner, the other pieces, the stops or the sizes. Every piece is ticked on the same steady schedule, so a call near a fill is normal for every piece. |

---

## Leave without us

Your pieces and your private balance are OutLayer deterministic wallets made from your NEAR account and your 12 words. The exit tool (`exit/`) needs only those words, your account and a destination:

1. Checks the words belong to your account.
2. Finds every wallet that belongs to you.
3. Closes any open position with a reduce-only order.
4. Moves each piece's USDC back to your private balance.
5. Sends the private balance to your address on NEAR, Base or Arbitrum, after you type `yes`.
6. Offers to remove our server's key from all your wallets.

It runs as a single HTML page from disk, or from a terminal. It talks only to OutLayer, Hyperliquid and a NEAR RPC, and the words never leave your computer.

---

## The signed track record

The guard's `proof` op reads every registered piece's equity and net deposits and signs an EAS off-chain attestation (schema `uint64 asOf, uint32 shards, int64 equityMicroUsd, int64 netDepositsMicroUsd, int64 pnlMicroUsd, string outlayerCall`). It carries totals only. To check one:

```bash
cd tools && npm install && node easverify.cjs proof.json
```

(`proof.json` holds OutLayer's answer to a `proof` call, as `{"output": ...}`) → the SDK's verify result, the recovered signer (the guard's key), the decoded totals, and an easscan link. The attestation names the OutLayer call that made it, and OutLayer's attestation for that call gives the wasm hash of the guard that ran.

---

## Work for OutLayer

While building this we found that OutLayer's public attestation records are listed by sequential id and carry an unsalted hash of each call's input. For short inputs such as a stop price, the input can be recovered by guessing. We showed it on our own call and reported it with a fix: [out-layer/outlayer#35](https://github.com/out-layer/outlayer/issues/35). Our guard does not depend on the fix: every call is one sealed box with a random salt, so the public hash is a hash of ciphertext.

---

## Engineering decisions

- **Seal the whole call, not just the stop.** After we recovered inputs from public hashes, every op except `addr` and `box_pub` became one sealed box: X25519, a SHA-256 key step and ChaCha20-Poly1305 with aad `unhuntable-call-v1`, plus a 32-byte salt. The op name is inside too.
- **One agent per piece.** Hyperliquid publishes which account an agent trades for. A shared agent would tie every piece together in one lookup.
- **The guard never touches money.** Funding, refills and going home run through OutLayer custody wallets under your on-chain policy. The guard only trades.
- **Deterministic wallets.** Wallets come from your account and your 12 words, so the exit tool can always find them.
- **VRF for every random choice.** Piece sizes, entry times, stop jitter and wake-band edges come from OutLayer VRF, with the proof kept, so a plan can be checked later.
- **Hyperliquid's $10 minimum applies to closes too.** Every piece starts at $12 or more, and a defence cut that would go under $10 closes the piece instead of leaving dust nobody can close.
- **Exits cost about $1.20 per piece.** Hyperliquid charges 1 USDC to send to a new address, and each deposit address is new. The app shows this before you go home, and pieces under 3 USDC are left in place.

---

## Repo map

| Folder | What it is | Tests |
| --- | --- | --- |
| `guard/` | The guard: a Rust WASI program for OutLayer. Decisions are pure functions in `src/lib.rs`. | 31 |
| `client/` | TypeScript: sealed boxes, guard client, position planner, fill savings, pieces key, Hyperliquid signing, exit logic | 137 |
| `server/` | API, SQLite, jobs, NEAR sign-in, OutLayer wallet client, money flows | 133 |
| `signer/` | NEAR contract `unhuntable.near`: Hyperliquid accounts controlled by Chain Signatures, signing only what each piece key approved | 12 |
| `contract/` | NEAR records contract: piece hashes, guard builds, fee ledger, treasury mirror | 18 |
| `web/` | Phone-first static web app with a strict CSP | 25 unit + Playwright at two screen sizes |
| `exit/` | Leave-without-us tool: one HTML page or a CLI | in `client/` |
| `attacks/` | Linking attacks with public data only | |
| `tools/` | EAS proof check and its reference | |
| `scripts/` | Repo checks run in CI | |

CI runs every folder's tests, rebuilds the exit page and checks it matches, checks the signer stays under 100 KB, and checks the repo for secrets.

Every folder has its own README with the details.

## Security

Found a problem? Open a GitHub issue without exploit details and ask for a private channel, and we will reply there.

## Licence

MIT. See `LICENSE`.
