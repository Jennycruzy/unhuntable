# Unhuntable

**Private perps for DeFi traders and AI agents, on Hyperliquid and trade.xyz. Built on ten parts of the NEAR stack.**

**Unhuntable hides the price that wipes you out, for people and for their agents.** Your position is split across accounts nobody can link, your stop is sealed where nobody can read it, and each piece's account is controlled by NEAR Chain Signatures, with no private key anywhere. Hunters have nothing to push the price to.

**Live app:** [tryunhuntable.site](https://tryunhuntable.site) · **Hunt Map:** [tryunhuntable.site/hunt-map](https://tryunhuntable.site/hunt-map/) (no sign-in) · **Agents:** [`agent/`](agent/) (MCP server)

Tracks: **Privacy & Private AI** · **Unstoppable DeFi** · **AI Security & Defense**

### Why it matters

- **Every Hyperliquid account is public.** Its size, the exact price that liquidates it and every stop resting on the book. Big positions are tracked by bots and dashboards, and the price is pushed to the levels everyone can see. The [Hunt Map](https://tryunhuntable.site/hunt-map/) shows them live.
- **near.com hides your name, not that price.** Hunters do not need your name. Unhuntable removes the level itself: no big position to find, no stop on the book.
- **Agents have it worse.** Their wallets are public, they trade on schedules, and a prompt injection can talk them into giving away their stop. Here the stop is sealed on the agent's own machine and no tool can read it back.
- **Proven on mainnet with real money:** [a sealed stop firing on an NVDA short](https://app.hyperliquid.xyz/explorer/tx/0xe3658df9d0c075c3e4df04488de8bc02021800df6bc39495872e394c8fc44fae), [NEAR's MPC network signing for a Hyperliquid account with no private key](https://nearblocks.io/txns/86qJbTWkiXwXsKfCCWqK63yLanzvkbxikMj1R4HfufVd), and [an AI agent paying for a call with x402](https://nearblocks.io/txns/7VcZWHJzgrauZaY6irWh1BiHGcr7kDch92UG69MFvMBD).
- **The answer NEAR's founder pointed to.** In [NEP discussion #531](https://github.com/near/NEPs/issues/531), Illia Polosukhin notes that users spread their activity over many separate accounts to keep it apart, and that the answer lives in the application layer. Unhuntable is that answer for perps: the separate accounts are made and funded for you, from your one NEAR account.

[For judges](#for-judges-start-here) · [How it works](#how-it-works-in-short) · [Two doors](#two-doors-one-protection) · [NEAR stack](#ten-parts-of-the-near-stack-each-doing-real-work) · [Mainnet proof](#what-ran-on-mainnet-with-real-money) · [Go deeper](#go-deeper)

---

## For judges, start here

Ninety seconds, no wallet and no money needed:

1. **Open the [Hunt Map](https://tryunhuntable.site/hunt-map/).** Real Hyperliquid accounts and the exact prices that liquidate them, read from Hyperliquid's public API every 5 minutes. This is what every trader is exposed to today.
2. **Open three mainnet transactions.** [A sealed stop firing on an NVDA short](https://app.hyperliquid.xyz/explorer/tx/0xe3658df9d0c075c3e4df04488de8bc02021800df6bc39495872e394c8fc44fae), [NEAR's MPC network signing for a Hyperliquid account with no private key](https://nearblocks.io/txns/86qJbTWkiXwXsKfCCWqK63yLanzvkbxikMj1R4HfufVd), and [an AI agent paying for a call with x402](https://nearblocks.io/txns/7VcZWHJzgrauZaY6irWh1BiHGcr7kDch92UG69MFvMBD).
3. **Run the tests.** 491 tests across the guard, the signer contract, the client, the server, the MCP server and the app, plus browser tests at phone and desktop size, all in CI: [Check it yourself](docs/check-it-yourself.md).

---

## Ten parts of the NEAR stack, each doing real work

| | What it does in Unhuntable | Proof on mainnet |
| --- | --- | --- |
| **NEAR Chain Signatures** | `unhuntable.near` asks `v1.signer` to sign Hyperliquid actions for a piece, so the piece's Hyperliquid account has no private key anywhere | [`unhuntable.near`](https://nearblocks.io/address/unhuntable.near) · [approve-agent tx](https://nearblocks.io/txns/86qJbTWkiXwXsKfCCWqK63yLanzvkbxikMj1R4HfufVd) · [the account it controls](https://app.hyperliquid.xyz/explorer/address/0x35c99eff31255e9ac3fc2a3c6e4dd70cb026b02a) |
| **OutLayer TEE (Intel TDX)** | Runs the guard: sealed stops, one agent key per piece, up to seven price sources, the defence ladder | Sealed-stop trade: public order list `[]` while open, then a reduce-only close |
| **trade.xyz (US stocks on Hyperliquid)** | 12 stock and index markets, isolated margin, money moved onto trade.xyz and back by Chain Signatures, stops that need two prices from outside the book | [move in](https://nearblocks.io/txns/8LzpGyN9kKpDwMmYKihG1MXXbgHFbs9H3E9Ci7w1jL6Z) · [stop fired](https://nearblocks.io/txns/6ewnHXXtwTjBvqdEqYdDkoVc3oE3ew2b6prZ5MAVCz4c) · [move back](https://nearblocks.io/txns/CALA24Gya1fLd8No2wzukUSM8cQ29eaBAUActpFLVGvc) |
| **x402 on NEAR (AI agents)** | Each agent call is paid in USDC on NEAR with a NEP-366 delegated `ft_transfer`, settled by our relayer before the call runs | [paid agent call](https://nearblocks.io/txns/7VcZWHJzgrauZaY6irWh1BiHGcr7kDch92UG69MFvMBD) |
| **NEAR Intents (Confidential)** | Holds your private balance and funds each piece with no public link between pieces | 2.5 USDC sent privately to a piece, arriving as 2.178894 USDC |
| **1Click** | Deposits from any chain, and pays out to Hyperliquid through a shared payer used by thousands of accounts | [15 USDT in from BNB Chain](#what-ran-on-mainnet-with-real-money); ~2,000 shared-payer sends to 991 accounts in 12 hours |
| **Aurora Intents** | A second private way in, straight to a piece's Hyperliquid account, with our 6 basis point integrator fee | 2 USDC from Arbitrum landed as 1.6827 USDC, fee applied |
| **OutLayer VRF** | Draws piece sizes, entry times and stop jitter, with proofs anyone can check | Each plan stores its VRF output and proof |
| **OutLayer custody + on-chain policies** | Your wallets, under policies owned by **your** NEAR account that our server cannot change | Policies stored by the owner's Meteor wallet and read back from chain before money moved |
| **Sputnik DAO (treasury mode)** | A piece handed to a DAO moves only on a passed vote: `unhuntable.near` signs for it only when the DAO calls | On NEAR testnet: [proposal passed, NEAR signed for the piece's account](docs/treasury.md#proof); the same code runs on mainnet `unhuntable.near` |
| **NEAR wallets (NEP-413)** | Sign-in, the pieces key, every policy approval | Meteor on mainnet; HOT and MyNearWallet supported |
| **EAS** | A signed track record from the guard, totals only | Verifies with the official EAS SDK |
| **Security work for OutLayer** | Found and reported a flaw that leaked call inputs from public records | [out-layer/outlayer#35](https://github.com/out-layer/outlayer/issues/35) |

---

## How it works, in short

1. **Sign in with your NEAR wallet.** Your browser makes 12 words that only you hold. Every key Unhuntable uses for you comes from them.
2. **Deposit from any chain.** The money lands in your private balance on NEAR Intents.
3. **Open a trade.** Pick BTC, ETH, SOL or a US stock on trade.xyz, then size and leverage. A big position is split into 2 to 12 separate Hyperliquid accounts, each funded on its own from your private balance, so nobody can tie them together.
4. **Set your stop.** Your browser seals it into a box only the guard can open. It never goes on Hyperliquid's book, so there is no level for anyone to hunt.
5. **The guard watches.** It runs inside an OutLayer TEE, checks prices every 2 minutes, fires your stop only when independent prices agree, and cuts size before liquidation. It can trade, but Hyperliquid refuses it if it tries to move money.
6. **Go home.** Your own keys sign the money back to your private balance through NEAR Chain Signatures. If we ever disappear, the exit tool brings it home from your 12 words alone.
7. **Or hand it to your agent.** Give an AI agent its own key with limits on the Agents screen. It trades through the same pieces with the same sealed stops, and pays for each call itself.

[Every step in detail](docs/how-it-works.md)

---

## Two doors, one protection

### For DeFi traders

- **Crypto and US stocks.** BTC, ETH and SOL on Hyperliquid; NVDA, TSLA, AAPL, MSFT, GOOGL, AMZN, META, AMD, MU, INTC, XYZ100 and SP500 on trade.xyz. [An NVDA short opened](https://app.hyperliquid.xyz/explorer/tx/0xdfdd58cd4df862ffe15704488de26802050700b2e8fb81d183a604200cfc3cea) with an empty public order list, and [its sealed stop closed it](https://app.hyperliquid.xyz/explorer/tx/0xe3658df9d0c075c3e4df04488de8bc02021800df6bc39495872e394c8fc44fae).
- **No big position to find.** A whale-size position is split into 2 to 12 accounts, each funded on its own from a confidential balance on NEAR Intents, with sizes and entry times drawn from a VRF anyone can check.
- **Stops nobody can read.** Your browser seals the stop into a box only the guard can open. The guard runs in an OutLayer TEE and fires a reduce-only close only when independent prices agree; for stocks, two of them must come from outside the trade.xyz book. Nothing rests on the book until the moment it fires.
- **A guard that defends but cannot steal.** It cuts size on a ladder before liquidation, and with auto-refill on, tops the piece back up from your private balance within a daily limit you set. It trades with agent keys, and Hyperliquid refuses any transfer an agent signs; [we tried it on mainnet](#what-ran-on-mainnet-with-real-money).
- **Accounts with no private key.** Each piece's Hyperliquid account is controlled by NEAR Chain Signatures through [`unhuntable.near`](https://nearblocks.io/address/unhuntable.near), which signs only what that piece's own key approved. We could not move your money even if we wanted to.
- **Money in from any chain, with no trail.** Deposits through 1Click or Aurora Intents land in a confidential balance on NEAR Intents, and every piece is funded through the same shared payer that funds thousands of unrelated Hyperliquid accounts.
- **See yourself as hunters do.** Hunter's View puts each of your positions beside what Hyperliquid's public API shows for it: separate small accounts, no stop on the book. The public [Hunt Map](https://tryunhuntable.site/hunt-map/) shows what everyone else exposes: the liquidation price of every large position held by Hyperliquid's biggest accounts.
- **Teams and DAOs.** A piece can be handed to a DAO, and then its money moves only on a passed vote: [treasury mode](docs/treasury.md), proven with a Sputnik DAO.
- **Leave without us.** The exit tool brings your money home from your 12 words alone, even if our servers are gone.

### For AI agents

Agents get hunted more than people: their wallets are public, they trade on schedules, and a prompt injection can talk them into giving away their stop.

- **Their own key, your limits.** On the Agents screen you make a key for each agent with its largest size, its markets and its opens per day. The key is shown once and stored only as a hash.
- **A stop the agent cannot leak.** The MCP tool seals the stop on the agent's own machine into boxes only the guard can open. No tool reads it back, so a hostile prompt finds nothing to give away.
- **No way to move money.** The agent opens and closes on pieces you set up. Making pieces and moving money need your 12 words, which never leave your browser.
- **Pays for every call itself, in USDC on NEAR.** Each call is paid with x402: the agent signs a NEP-366 delegated `ft_transfer`, our relayer settles it on NEAR before the call runs, and a call the limits refuse costs nothing. [A paid agent call on mainnet](https://nearblocks.io/txns/7VcZWHJzgrauZaY6irWh1BiHGcr7kDch92UG69MFvMBD), 4.5 seconds [end to end](https://nearblocks.io/txns/6XQ9FdGdfuhGYJcinGyHedhqoBCvxorQ1figfR2RAdaL).

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
| Moved a NEAR-controlled piece's 2.16 USDC onto trade.xyz | `unhuntable.near` asked NEAR to sign a `sendAsset` from the piece to itself; [signed in 8.8 seconds](https://nearblocks.io/txns/8LzpGyN9kKpDwMmYKihG1MXXbgHFbs9H3E9Ci7w1jL6Z), Hyperliquid answered `ok`. |
| The guard opened a 6x isolated short of 0.06 NVDA on trade.xyz and sealed a stop | Filled at 178.10 with 4 of 4 stock price sources agreeing. The account's public order list was empty (`[]`) while the position was open. |
| The sealed stop was moved below the price and the guard ticked | [The stop fired](https://nearblocks.io/txns/6ewnHXXtwTjBvqdEqYdDkoVc3oE3ew2b6prZ5MAVCz4c) as a reduce-only close at 178.22. A second tick fired nothing. The piece then moved its money back from trade.xyz through NEAR. The whole trade cost under one cent. |
| An AI agent called the live site through the MCP server, paying with x402 | [0.002 USDC moved](https://nearblocks.io/txns/7VcZWHJzgrauZaY6irWh1BiHGcr7kDch92UG69MFvMBD) from the agent's own NEAR account to `unhuntable.near` in a delegated `ft_transfer` our relayer submitted; the call ran after the payment settled. A [second paid call](https://nearblocks.io/txns/6XQ9FdGdfuhGYJcinGyHedhqoBCvxorQ1figfR2RAdaL) took 4.5 seconds end to end. |
| The same agent tried to open above its size limit, and with no ready piece | Both refused before payment; the agent's USDC balance shows only the two paid calls. |
| Asked the contract to sign the same request twice (NEAR testnet) | Refused: "the piece key did not sign this action". |
| Deposited 15 USDT from BNB Chain into an OutLayer wallet | Arrived as 14.978224 USDC in the wallet's NEAR Intents balance, then moved into its confidential balance. |
| Moved 3 USDC from a confidential balance to a piece's own Hyperliquid account | Arrived as 2.678831 USDC in the piece's perp account in under 3 minutes, sent by 1Click's shared payer, which made about 2,000 sends to 991 different accounts in the same 12 hours. |
| The piece's own wallet approved the guard's agent key | Hyperliquid answered `ok`. |
| The guard set leverage and opened a long of 0.0045 ETH | 7 of 7 price sources agreed; filled at 2266.7. |
| A sealed stop was set, then one guard tick ran | The stop fired once: a reduce-only close filled at 2266.6. A second tick reported nothing left to fire. No stop order ever sat on the book. |
| The guard's agent key tried to send 1 USDC out of the piece | Hyperliquid refused it: an agent's transfer counts as the agent's own empty account. The piece's balance did not change. |
| The guard signed a track-record proof | An EAS off-chain attestation with totals only (2 pieces, equity, net deposits, PnL). It verifies with the official EAS SDK and recovers the guard's key as signer. No address leaves the guard. |
| We attacked our own piece with public data only | Funding origin, amount fingerprint, agent reuse and the private withdraw's public status: **not linked**. Input recovery from OutLayer's public call record: **linked**, before we sealed every call. **Not linked** after. ([details](docs/security.md#attacks-we-ran-on-our-own-pieces)) |

---

## Go deeper

| Page | What it covers |
| --- | --- |
| [Built on NEAR](docs/built-on-near.md) | Chain Signatures and `unhuntable.near`, the OutLayer TEE guard, NEAR Intents, Aurora Intents, NEAR wallets |
| [US stocks on trade.xyz](docs/us-stocks.md) | Markets, money moved by Chain Signatures, stops that need prices from outside the book, the NVDA run step by step |
| [AI agents](docs/ai-agents.md) | Agent keys and limits, the MCP server, x402 payments in USDC on NEAR |
| [The Hunt Map and Hunter's View](docs/hunt-map.md) | How the map is collected and what it counts; your position as the public sees it |
| [How it works](docs/how-it-works.md) | The life of one position, the architecture, prices and stops, the defence ladder, engineering decisions |
| [Security and privacy](docs/security.md) | Who could cheat and why they cannot, who sees what, the attacks we ran on our own pieces, the flaw we found for OutLayer |
| [Treasury mode](docs/treasury.md) | Pieces handed to a DAO: money moves only on a passed Sputnik DAO vote |
| [Leave without us](docs/leave-without-us.md) | Bringing your money home from your 12 words alone |
| [Fees and revenue](docs/fees.md) | The Aurora integrator fee, x402 agent calls, the Hyperliquid builder fee |
| [Check it yourself](docs/check-it-yourself.md) | Every test suite, one command each |

---

## Repo map

| Folder | What it is | Tests |
| --- | --- | --- |
| `guard/` | The guard: a Rust WASI program for OutLayer. Decisions are pure functions in `src/lib.rs`. | 41 |
| `client/` | TypeScript: sealed boxes, guard client, position planner, fill savings, pieces key, Hyperliquid signing, Chain Signatures pieces, NEAR relay, exit logic | 174 |
| `server/` | API, SQLite, jobs, NEAR sign-in, OutLayer wallet client, Chain Signatures relay, money flows, Hunt Map collector, Hunter's View | 203 |
| `signer/` | NEAR contract `unhuntable.near`: Hyperliquid accounts controlled by Chain Signatures, signing only what each piece key approved | 16 |
| `agent/` | MCP server for AI agents: open, sealed stop, status, close; pays each call with x402 in USDC on NEAR | 6 |
| `web/` | Phone-first static web app with a strict CSP | 51 unit + Playwright at two screen sizes |
| `exit/` | Leave-without-us tool: one HTML page or a CLI | in `client/` |
| `attacks/` | Linking attacks with public data only | |
| `tools/` | EAS proof check and its reference | |
| `scripts/` | Repo checks run in CI | |

CI runs every folder's tests, rebuilds the exit page and checks it matches, checks the signer stays under 100 KB, and checks the repo for secrets.

Every folder has its own README with the details, and [`docs/`](docs/) explains each part in depth.

## Security

Found a problem? Open a GitHub issue without exploit details and ask for a private channel, and we will reply there.

## Licence

MIT. See `LICENSE`.
