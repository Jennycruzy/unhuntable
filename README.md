# Unhuntable

**Private perps on Hyperliquid and trade.xyz.** Your position is split across accounts nobody can link, and your stop-loss is sealed where nobody can read it, so hunters have no level to push the price to. Built on NEAR.

## What is built and live

Each part below has run on mainnet with real money, with a link to check it. The app is live at [tryunhuntable.site](https://tryunhuntable.site).

- **Crypto perps on Hyperliquid.** BTC, ETH and SOL, split into 1 to 12 pieces, each its own Hyperliquid account, funded separately so nothing ties them together. [A sealed-stop ETH trade](#what-ran-on-mainnet-with-real-money): the public order list stayed empty while it was open, then the stop fired.
- **US stocks on trade.xyz.** NVDA, TSLA, AAPL, MSFT, GOOGL, AMZN, META, AMD, MU, INTC, XYZ100 and SP500, from the same pieces and with the same sealed stop. [An NVDA short opened](https://app.hyperliquid.xyz/explorer/tx/0xdfdd58cd4df862ffe15704488de26802050700b2e8fb81d183a604200cfc3cea) with an empty public order list, and [the sealed stop closed it](https://app.hyperliquid.xyz/explorer/tx/0xe3658df9d0c075c3e4df04488de8bc02021800df6bc39495872e394c8fc44fae).
- **Stops nobody can read.** The stop is sealed in your browser into a box only the guard can open. The guard runs in an OutLayer TEE and fires a reduce-only close when independent prices agree; for stocks, two of them must come from outside the trade.xyz book. Nothing rests on the book until the moment it fires.
- **Accounts with no private key.** Each piece's Hyperliquid account is controlled by NEAR Chain Signatures through our contract [`unhuntable.near`](https://nearblocks.io/address/unhuntable.near), which signs only what that piece's own key approved. We could not move your money even if we wanted to. [NEAR signed a piece's approval in 6.5 seconds](https://nearblocks.io/txns/86qJbTWkiXwXsKfCCWqK63yLanzvkbxikMj1R4HfufVd).
- **Money in and out with no trail.** A private balance in NEAR Intents' confidential mode funds every piece separately; deposits come from any chain through 1Click or Aurora Intents.
- **AI agents trade through the same pieces.** An MCP server with its own key and limits, stops sealed on the agent's machine, every call paid with x402 in USDC on NEAR. [A paid agent call on mainnet](https://nearblocks.io/txns/7VcZWHJzgrauZaY6irWh1BiHGcr7kDch92UG69MFvMBD).
- **See the problem, and your answer to it.** The public [Hunt Map](https://tryunhuntable.site/hunt-map/) lists the liquidation price of every large position held by Hyperliquid's biggest accounts. Hunter's View puts each of your positions beside what Hyperliquid's public API shows for it: separate accounts, no stop on the book.
- **Leave without us.** The exit tool brings your money home from your 12 words alone, even if our servers are gone.

**Why it matters.** On Hyperliquid, anyone can see the price that wipes you out: every account's size, entry, liquidation price and resting stops are public. near.com hides your name, not that price. Hunters do not need your name; they push the price to the level they can read, take the liquidation, and the market watches. Unhuntable removes the level itself.

Tracks: **Privacy & Private AI** · **Unstoppable DeFi** · **AI Security & Defense**

### The NEAR stack, all on mainnet

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
| **NEAR wallets (NEP-413)** | Sign-in, the pieces key, every policy approval | Meteor on mainnet; HOT and MyNearWallet supported |
| **EAS** | A signed track record from the guard, totals only | Verifies with the official EAS SDK |
| **Security work for OutLayer** | Found and reported a flaw that leaked call inputs from public records | [out-layer/outlayer#35](https://github.com/out-layer/outlayer/issues/35) |

[Built on NEAR](#built-on-near) · [What ran on mainnet](#what-ran-on-mainnet-with-real-money) · [Check it yourself](#check-it-yourself) · [How it works](#how-it-works) · [Who could cheat](#who-could-cheat-and-why-they-cannot) · [Privacy](#privacy-who-sees-what) · [Leave without us](#leave-without-us) · [Security finding for OutLayer](#work-for-outlayer)

---

## Built on NEAR

Every NEAR piece below does a job the product cannot do without, and each has run on NEAR mainnet.

### NEAR Chain Signatures: Hyperliquid accounts with no private key

`unhuntable.near` ([`signer/`](signer/)) controls a piece's Hyperliquid account. NEAR's MPC network (`v1.signer`) derives the piece's Hyperliquid account from this contract and the piece's own ed25519 key, so the account has no private key anywhere: not on our server, not in an enclave, not in a wallet.

The contract builds each Hyperliquid action's EIP-712 hash itself from typed fields and asks the MPC network to sign it only when the piece key signed that exact action with its current counter. It can sign six account actions (approve an agent, move USDC between spot and perp, move between market lists, withdraw, and two kinds of send), plus a builder fee approval only for the builder it was built with and only at 0.01% (see [the builder fee](#hyperliquid-builder-fee-one-basis-point-capped-by-a-near-contract)), and nothing else: no orders, no account changes. Anyone may relay the call; a relay cannot get a signature without the piece key, change an amount or a destination, or replay an old request. The contract has no owner and no admin methods.

- Live: [`unhuntable.near`](https://nearblocks.io/address/unhuntable.near) runs on `v1.signer` with Hyperliquid mainnet.
- Approve the guard's agent for a piece through Chain Signatures: [NEAR tx `86qJbTWk…`](https://nearblocks.io/txns/86qJbTWkiXwXsKfCCWqK63yLanzvkbxikMj1R4HfufVd), signed by NEAR in 6.5 seconds for 0.0086 NEAR; Hyperliquid answered `ok`.
- The hashes match Hyperliquid's Python SDK for all seven action types (`signer/src/hl_vectors.json`).

How the app uses it, end to end:

- **Your 12 words make every piece key.** The browser derives piece *n*'s ed25519 key from your pieces key, registers it on `unhuntable.near`, and asks NEAR's MPC network (`v1.signer`) directly, not our server, which Hyperliquid account it controls. It signs only for `unhuntable.near` and only for the account NEAR derived.
- **The guard's agent is approved through NEAR.** The piece key signs the approval in your browser; when the piece's funding lands, our server relays it to `unhuntable.near`, NEAR's MPC network signs it, and the server checks the signature recovers to the piece's account before posting it to Hyperliquid.
- **No lock to sign, nothing to unlock.** The contract is the lock: a piece's money can move only on its own key's signature. Going home, your browser asks OutLayer for a deposit address of your own private balance and signs the moves to it; our server only relays them.
- **Leave without us.** The exit tool finds these pieces from your 12 words alone, closes an open position with a one-time agent key it makes and approves through the contract, and brings the money home. Any NEAR account can pay the gas; it cannot change what it relays.

### OutLayer TEE: the guard, the wallets and your rules

The guard ([`guard/`](guard/)) is a Rust program that runs inside OutLayer's trusted execution environment (TEE: Intel TDX, attested). It holds one Hyperliquid agent key per piece, keeps your stops in sealed storage, draws every random choice from OutLayer's VRF, checks up to seven price sources, fires stops and runs the defence ladder. OutLayer custody wallets hold your private balance, under a policy stored on chain with **you** as owner: where money may go, and that Hyperliquid signing stays off. Our server cannot change it.

- A sealed-stop trade on a Chain Signatures piece: the public order list stayed empty (`[]`) while the position was open, and the stop fired as a reduce-only close.
- Policy changes approved by the owner's NEAR wallet and read back from chain before any money moved.
- We found and reported a privacy flaw in OutLayer's public call record ([out-layer/outlayer#35](https://github.com/out-layer/outlayer/issues/35)).

### US stocks on trade.xyz: the same pieces, the same sealed stop

[trade.xyz](https://trade.xyz) is a market list on Hyperliquid for US stocks and indexes. A position there is as public as any other: the account, the size, the liquidation price and every resting stop. Unhuntable trades it the same way it trades crypto, with three things done differently because stocks are different.

**Markets.** NVDA, TSLA, AAPL, MSFT, GOOGL, AMZN, META, AMD, MU, INTC, and the indexes XYZ100 and SP500. Pick "US stocks" on the Trade screen.

**Money moves by Chain Signatures.** trade.xyz keeps its own balance, apart from Hyperliquid's main one. A piece's USDC is moved onto trade.xyz with a `sendAsset` action from the piece to itself, and moved back the same way before going home. The piece key approves that exact action, `unhuntable.near` builds the Hyperliquid message itself, and NEAR's MPC network signs. The app only ever builds this action from a piece to itself, and nothing can be signed that the piece key did not approve. This is why stocks are traded only from NEAR-controlled pieces.

**Stops need prices from outside the book.** A stock stop fires only when at least 3 sources agree within 0.5%, and at least 2 of those are not the trade.xyz order book: trade.xyz's oracle, Yahoo Finance and Nasdaq. Outside prices count only when they are under 5 minutes old. So pushing the trade.xyz book alone can never fire your stop, and when US prices are not live (outside 04:00 to 20:00 New York time on trading days) the guard holds instead of guessing.

**Isolated margin.** trade.xyz markets use isolated margin, so each piece's risk is its own. The planner picks the leverage that keeps liquidation at least 18% away and tells you before you confirm.

**Leaving.** Going home and the [exit tool](#leave-without-us) both close stock positions and move the money back from trade.xyz first.

**Proof on mainnet** (one piece, about $10.70 of NVDA, total cost under one cent):

| Step | Result |
| --- | --- |
| Piece moved 2.16 USDC onto trade.xyz | [NEAR signed in 8.8 s](https://nearblocks.io/txns/8LzpGyN9kKpDwMmYKihG1MXXbgHFbs9H3E9Ci7w1jL6Z); Hyperliquid answered `ok` |
| Guard set 6x isolated leverage and opened a short of 0.06 NVDA | [guard run](https://nearblocks.io/txns/HofQYerGRb1BgdThuEAgzyVfA7LwEA9pzAv4mj6oixLj): 4 of 4 price sources agreed; [filled at 178.10](https://app.hyperliquid.xyz/explorer/tx/0xdfdd58cd4df862ffe15704488de26802050700b2e8fb81d183a604200cfc3cea) |
| Stop sealed at 190, then one guard tick | Hyperliquid's public order list for the account was `[]` on both market lists; the [tick](https://nearblocks.io/txns/9vnaLswaPtZB6kfWt88jvwakxgScCPZ8FBU2964kuPV6) fired nothing |
| Stop sealed again at a price already crossed, then one guard tick | [The stop fired](https://nearblocks.io/txns/6ewnHXXtwTjBvqdEqYdDkoVc3oE3ew2b6prZ5MAVCz4c): a [reduce-only close at 178.22](https://app.hyperliquid.xyz/explorer/tx/0xe3658df9d0c075c3e4df04488de8bc02021800df6bc39495872e394c8fc44fae). A [second tick](https://nearblocks.io/txns/FxAXyJ5hnt15Xc5ukxH8GT4DebBEvALSYiDLtGyU3hMc) fired nothing |
| Piece moved its 2.150877 USDC back to the main balance | [NEAR signed in 8.7 s](https://nearblocks.io/txns/CALA24Gya1fLd8No2wzukUSM8cQ29eaBAUActpFLVGvc); Hyperliquid answered `ok` |

The account is [`0x35c9…b02a`](https://app.hyperliquid.xyz/explorer/address/0x35c99eff31255e9ac3fc2a3c6e4dd70cb026b02a): no private key for it exists, and both fills are on its public page.

### NEAR Intents and Confidential Intents: money in, between pieces and home, with no trail

Your private balance lives in NEAR Intents' confidential mode. Deposits arrive from any chain through 1Click; private transfers, private swaps and private withdrawals to each piece's own Hyperliquid account leave no public link between pieces. On Hyperliquid every piece is funded by 1Click's shared payer, the same sender as thousands of unrelated accounts a day.

- 15 USDT from BNB Chain in; 2.5 USDC swapped privately to NEAR; 2.5 USDC sent privately to a piece's Hyperliquid account, arriving as 2.178894 USDC.

### Aurora Intents: a second private door, and our revenue

Aurora's Swap API takes a deposit on any chain and lands it straight on a piece's Hyperliquid account in confidential mode. Our Aurora key carries an integrator fee of 6 basis points to `jennycruzy.near`, shown in every quote.

- 2 USDC from Arbitrum arrived as 1.6827 USDC on a piece's Hyperliquid account, under our Aurora key with the fee applied.

### AI agents: a second door into the same pieces, paid per call with x402

Agents get hunted more than people: their wallets are public, they trade on schedules, and a prompt injection can talk them into giving away their stop. Unhuntable gives an agent the same protection as a person, through an MCP server (`agent/`) and a paid HTTPS API.

- **The owner sets the limits.** On the Agents screen the owner makes a key for each agent: the largest size it may open, which markets, and how many opens a day. The key is shown once and stored only as a hash. Each call the agent makes is listed with its payment.
- **The stop is sealed on the agent's machine.** `unhuntable_set_stop` seals the price into one box per piece that only the guard's enclave can open. It never reaches Hyperliquid's book and no tool can read it back, so there is nothing for a hunter, or a hostile prompt, to get out of the agent.
- **The agent cannot move money.** It opens and closes on pieces the owner already set up. Making pieces, moving money and trading stocks all need the owner's 12 words, which never leave the owner's browser.
- **Every call is paid with x402 in USDC on NEAR.** The first request gets a `402` with an x402 v2 challenge; the agent signs a NEP-366 delegated `ft_transfer` of the price (0.002 USDC by default) to `unhuntable.near`, and the server settles it on NEAR before the call runs, with its own relayer paying the gas. Limits are checked before payment, so a refused call costs nothing. Built on FastNEAR's `@fastnear/x402` and the x402 Foundation's NEAR scheme.

**Live on mainnet:** our own demo agent ran the real MCP server against tryunhuntable.site and paid for each call with x402. [The first payment](https://nearblocks.io/txns/7VcZWHJzgrauZaY6irWh1BiHGcr7kDch92UG69MFvMBD) moved 0.002 USDC from the agent's NEAR account to `unhuntable.near`, submitted and paid for by our relayer; [the next](https://nearblocks.io/txns/6XQ9FdGdfuhGYJcinGyHedhqoBCvxorQ1figfR2RAdaL) took 4.5 seconds from the tool call to the answer. Two opens outside the key's limits were refused in under 0.2 seconds and cost the agent nothing.

Switch it on with `X402=on` (the server's relayer settles payments) and connect any MCP client with the settings the Agents screen shows. Tests: `server/test/agents.test.ts` (keys, limits, refusals before payment, open → seal → status → close with each call paid and recorded), `server/test/x402.test.ts` (the real x402 library's challenge: 2000 units of Circle's USDC on NEAR to our account), and `agent/test/agent.test.ts` (a full MCP session in which no tool answer and no request ever carries the stop price).

### Hyperliquid builder fee: one basis point, capped by a NEAR contract

The second revenue line is Hyperliquid's builder fee: a fee a front end may add to the orders it sends, once the account has approved it. Unhuntable's is **0.01% of the size, on opening orders only**, and the rules sit in code nobody at Unhuntable can change:

- **The NEAR contract caps it.** The signer contract signs a builder fee approval only for the one builder address it was built with, and only at exactly 0.01%. Hyperliquid would allow up to 0.1%; the contract refuses anything above 0.01% and any other builder, so a higher fee can never be approved for your pieces, by us or by anyone with the server.
- **Your pieces key approves it, once per piece.** It is one more action the browser signs when it sets up a new NEAR-controlled piece, after checking the builder and the rate against the contract itself through a public NEAR RPC. The review screen shows the fee and its most in dollars before you confirm.
- **It never touches a stop.** The guard adds the fee only when it opens a position on Hyperliquid's own market list. Stops, take-profits, defence cuts and closes never carry it, so a fee can never stand between a stop and its fill. trade.xyz stock orders do not carry it.
- **It never blocks a trade.** If Hyperliquid does not take the approval, the piece trades without the fee.

The server uses it only when `BUILDER_FEE=on` and the signer contract and the guard both report the same builder address. Hyperliquid accepts a builder only while that account holds at least 100 USDC in perps, so switching it on is: hold 100 USDC on the builder account, build the guard and the signer contract with `UNHUNTABLE_BUILDER=<that address>`, publish both, and set `BUILDER_FEE=on`. The whole path is tested end to end against Hyperliquid's own SDK hashes (`approve_builder_fee` vectors in `signer/src/hl_vectors.json`, and `the builder fee` tests in `server/test/chainsig.test.ts` and `web/test/chainsig.test.ts`).

### NEAR accounts and wallets

Your NEAR account owns every wallet policy on `outlayer.near`, and only its signature can change one: on mainnet the owner's Meteor wallet stored and changed piece policies, and each was read back from chain before money moved. You sign in to the app with the same wallet (a NEP-413 message the server checks against your account's full-access keys). The 12 words that make your piece keys are yours; the exit tool uses them to bring money home with our servers off.

---

## The problem, the answer, the proof

**The problem.** Hyperliquid is the biggest onchain perps exchange, and it is fully transparent. A public account page shows a position, its liquidation price and its resting stop and take-profit orders to anyone. Stop hunting is not a theory there: big positions are tracked by bots and public dashboards, and the price is pushed to the levels everyone can see.

The same problem shows up across all public chains. In [NEP discussion #531](https://github.com/near/NEPs/issues/531), Illia Polosukhin notes that users end up spreading their activity over many separate accounts to keep it apart, and that the answer lives in the application layer. Unhuntable is that answer for perps: the separate accounts are made and funded for you, from your one NEAR account.

**The answer.** Three things a trader on Hyperliquid cannot get today, together:

1. **Pieces nobody can tie together.** A position is split into 2 to 12 accounts. Each is funded separately from a confidential balance on NEAR Intents and arrives through the same shared payer that funds thousands of other Hyperliquid accounts a day. Sizes are randomised and entries are spread over minutes, with the timing drawn from a VRF anyone can check.
2. **Stops that do not exist until they fire.** No stop order rests on Hyperliquid. The level is sealed in your browser into a box only the guard can open, and the guard runs inside an OutLayer enclave. When at least three public price sources (of up to seven) agree the level is crossed, the guard sends a reduce-only market order. Nobody can see where it is, including us.
3. **A guard that defends but cannot steal.** The guard holds one Hyperliquid *agent* key per piece. An agent key can place and cancel orders; Hyperliquid refuses any transfer it signs. The guard cuts size on a ladder as liquidation gets close, and it has no way to move money out.

**The proof.** We ran it on Hyperliquid mainnet with real money (table below), attacked our own pieces with only public data, and found and reported a privacy flaw in OutLayer's public call record that would have exposed sealed stops. Everything else in this repo is tested offline: about 400 tests across the guard, the signer, the client, the server, the records contract and the app, all in CI.

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
| We attacked our own piece with public data only | Funding origin, amount fingerprint, agent reuse and the private withdraw's public status: **not linked**. Input recovery from OutLayer's public call record: **linked**, before we sealed every call. **Not linked** after. ([details](#attacks-we-ran-on-our-own-pieces)) |

## The Hunt Map and Hunter's View

Two screens show the same fact from both sides, and both read only what Hyperliquid gives to anyone.

### The Hunt Map: the levels everyone can read

**Open [tryunhuntable.site/hunt-map](https://tryunhuntable.site/hunt-map/)** (no sign-in). You see, for each market, how many dollars are closed out at each percent from the price, and under it the accounts themselves: address, side, leverage, size and the exact price that liquidates them. Every address opens its public page on Hyperliquid, so each row can be checked by hand.

Where it comes from: a collector (`server/src/huntmap.ts`) runs beside the app with its own SQLite file and no secrets. Every 5 minutes it reads the 2,000 largest accounts on Hyperliquid's leaderboard in turn, keeps every position of $250,000 or more with its liquidation price, reads the resting stop orders of 40 holders per round, and stores one-minute candles for the 12 markets with the most money on visible levels.

The page then asks one question of that data: **when a level sits within 5% of the price, does the price go and reach it?** Each such level is followed for 24 hours. The page counts how many were reached, how many times the price went the same distance the other way (the fair comparison: a level with nobody on it), and how often the price was halfway back within the hour after a touch. The counts are shown as they are, starting from zero, and grow as the collector runs.

### Hunter's View: your own position, as the public sees it

**Open a position → look at "Hunter's view" on the Positions screen.** On the left is what you know: one position, your stop, your take-profit. On the right is what Hyperliquid's public API answers for each of your pieces: a separate account, its side, its size, its own liquidation price and the number of orders it has resting on the book. Each address opens its public page.

The sentence under the public side is built from Hyperliquid's answer and nothing else. With a sealed stop it reads "Hyperliquid shows 3 separate accounts and no stop or take-profit on the book." If an order of yours ever rests on the book, the same sentence counts it and says anyone can read it. If Hyperliquid cannot be read, the panel says so and shows no rows.

The server reads the same two public endpoints a tracker would (`clearinghouseState` and `frontendOpenOrders`), once per piece, and only for the signed-in owner of the position (`server/src/hunter.ts`).

---

## Check it yourself

No keys, no wallet, no money, no network. Each step is "do this → you see that".

**1. The guard's decisions** (Rust, needs `rustup`):

```bash
cd guard && cargo test --lib --test guard_tests
```

→ `test result: ok. 41 passed`. These include `moving_the_xyz_book_alone_cannot_fire_a_stock_stop`, `stocks_need_two_outside_sources`, `trade_xyz_leverage_and_open_match_reference_sdk`, `one_bad_feed_cannot_fire`, `real_crash_fires_once`, `stop_level_never_in_output`, `guard_has_no_transfer_path`, `defence_ladder_steps`, and signature tests that match Hyperliquid's official Python SDK byte for byte (`order_signatures_match_reference_sdk`, `usd_send_digest_matches_reference_sdk`) and EAS's official SDK (`eas_offchain_attestation_matches_sdk`).

**2. The client library, the planner and the exit tool** (Node 20+):

```bash
cd client && npm ci && npm test
```

→ `171 passed`. The sealed-box tests open a box made by the Rust guard's reference and make one the guard opens (`sealed_call_from_ts_client_opens` on the Rust side). The planner's property tests check hundreds of random positions: sizes add up exactly, every piece is above Hyperliquid's $10 minimum, and no piece needs money from another. The exit tests check that the 12 words and the private key are never sent anywhere. The Chain Signatures tests (`chainsig.test.ts`) match the signer contract's hashes, rebuild the exact message piece C signed on mainnet, and recover NEAR's real MPC signature for it to piece C's Hyperliquid account.

**3. The server and its money flows:**

```bash
cd client && npm run build && cd ../server && npm ci && npm test
```

→ `191 passed`. Sign-in with a NEP-413 signature, encrypted wallet keys, deposits, funding, policy batches and read-back, ticks, refills and going home, with fake clocks and recorded replies. `chainsig.test.ts` runs a position and a trip home on NEAR-controlled pieces against a fake contract and MPC network that check signatures the way the real ones do; it refuses another key's signature, a wrong counter, a send back to perps and any token but USDC, and its relay transactions match near-api-js byte for byte.

**4. The records contract** (needs `cargo-near`, see `contract/README.md`):

```bash
cd contract && cargo test
```

→ unit tests plus sandbox tests on a local NEAR node: owner-only and operator-only methods, the 64-hex hash rule, fee totals that add up, exact storage refunds, and NEP-297 events.

**5. The signer contract** (Rust, needs `rustup`):

```bash
cd signer && cargo test
```

→ `test result: ok. 13 passed`. These include `typed_data_hash_matches_hyperliquid_sdk` (every action type against Hyperliquid's Python SDK), `signs_only_what_the_piece_key_signed`, `server_cannot_change_the_action`, `replay_refused` and `other_piece_key_refused`.

**6. The web app** (phone and desktop):

```bash
cd web && npm ci && npm test && npm run build && npx playwright test
```

→ 46 unit tests, then every screen in headless Chromium at 360×780 and 1280×800, with all outside requests blocked. Screenshots land in `web/screenshots/`.

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
5. **Lock.** New pieces are NEAR-controlled: your browser makes each piece key from your 12 words, registers it on `unhuntable.near`, checks the piece's account with NEAR's MPC network, and signs the guard's agent approval. The contract is their lock. Your wallet signs one `store_wallet_policy` call on `outlayer.near` for your private balance, so it can send only to your pieces and to you; the server reads it back from chain before use.
6. **Fund and open.** At each piece's VRF time, the private balance funds that piece directly (never from another piece), NEAR's MPC network signs the agent approval your piece key made, and the guard opens the piece's size.
7. **Seal stops.** Your stop and take-profit are sealed in the browser, one box per piece, and forwarded unopened to the guard. The server never sees a level.
8. **Watch and defend.** The guard is ticked per coin every 2 minutes, and at once when the price leaves a piece's wake band. It fires stops and take-profits, and runs the defence ladder.
9. **Go home.** Your browser asks OutLayer for a deposit address of your own private balance and signs each piece's moves to it with the piece key; our server relays them through `unhuntable.near` and Hyperliquid gets them signed by NEAR. Pieces made as OutLayer wallets take one wallet approval to unlock and a second to lock again.

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
| Our server | Send a NEAR-controlled piece's money somewhere else, or swap in its own contract | Your browser signs only for `unhuntable.near` and only for the account NEAR's MPC network derives, which it asks NEAR itself. Going home, it gets the deposit address from OutLayer itself, with your pieces key. | `web/test/chainsig.test.ts` |
| A relay | Change an amount or destination, or replay a request | The piece key signs the contract, the counter and the action's hash; any change or repeat fails the check. | `server_cannot_change_the_action`, `replay_refused` |
| Our server | Learn your stop | Stops are sealed in your browser to the guard's key. The server forwards boxes it cannot open. | `client/src/box-browser.ts`, `stop_level_never_in_output` |
| Our server | Run one user's call as another's piece | The plain shard id next to a sealed call must equal the one inside the box, or the guard refuses. | `outer_shard_must_match_box` |
| One price source | Fire your stop with a fake print | At least three sources must agree within 0.5%. | `one_bad_feed_cannot_fire`, `one_bad_feed_cannot_fire_tp` |
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

Your private balance is an OutLayer deterministic wallet made from your NEAR account and your 12 words, and every piece key comes from the same words. The exit tool (`exit/`) needs only those words, your account and a destination:

1. Checks the words belong to your account.
2. Finds every wallet that belongs to you, and every NEAR-controlled piece: each piece key the words make is looked up on `unhuntable.near`, and its Hyperliquid account is read from NEAR's MPC network.
3. Closes any open position with a reduce-only order. On a NEAR-controlled piece it first makes a one-time agent key on your computer and approves it through the contract.
4. Moves each piece's USDC back to your private balance. NEAR-controlled pieces' moves are signed by their piece key and by NEAR; a NEAR account you name pays the gas (about 0.01 NEAR a step) and cannot change them.
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
| `guard/` | The guard: a Rust WASI program for OutLayer. Decisions are pure functions in `src/lib.rs`. | 41 |
| `client/` | TypeScript: sealed boxes, guard client, position planner, fill savings, pieces key, Hyperliquid signing, Chain Signatures pieces, NEAR relay, exit logic | 171 |
| `server/` | API, SQLite, jobs, NEAR sign-in, OutLayer wallet client, Chain Signatures relay, money flows, Hunt Map collector, Hunter's View | 191 |
| `signer/` | NEAR contract `unhuntable.near`: Hyperliquid accounts controlled by Chain Signatures, signing only what each piece key approved | 13 |
| `contract/` | NEAR records contract: piece hashes, guard builds, fee ledger, treasury mirror | 18 |
| `agent/` | MCP server for AI agents: open, sealed stop, status, close; pays each call with x402 in USDC on NEAR | 6 |
| `web/` | Phone-first static web app with a strict CSP | 46 unit + Playwright at two screen sizes |
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
