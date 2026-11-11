# AI agents

A second door into the same pieces, paid per call with x402. The MCP server and its setup are in [`agent/`](../agent/).

Agents get hunted more than people: their wallets are public, they trade on schedules, and a prompt injection can talk them into giving away their stop. Unhuntable gives an agent the same protection as a person, through an MCP server (`agent/`) and a paid HTTPS API.

- **The owner sets the limits.** On the Agents screen the owner makes a key for each agent: the largest size it may open, which markets, and how many opens a day. The key is shown once and stored only as a hash. Each call the agent makes is listed with its payment.
- **The stop is sealed on the agent's machine.** `unhuntable_set_stop` seals the price into one box per piece that only the guard's enclave can open. It never reaches Hyperliquid's book and no tool can read it back, so there is nothing for a hunter, or a hostile prompt, to get out of the agent.
- **The agent cannot move money.** It opens and closes on pieces the owner already set up. Making pieces, moving money and trading stocks all need the owner's 12 words, which never leave the owner's browser.
- **Every call is paid with x402 in USDC on NEAR.** The first request gets a `402` with an x402 v2 challenge; the agent signs a NEP-366 delegated `ft_transfer` of the price (0.002 USDC by default) to `unhuntable.near`, and the server settles it on NEAR before the call runs, with its own relayer paying the gas. Limits are checked before payment, so a refused call costs nothing. Built on FastNEAR's `@fastnear/x402` and the x402 Foundation's NEAR scheme.

**Live on mainnet:** our own demo agent ran the real MCP server against tryunhuntable.site and paid for each call with x402. [The first payment](https://nearblocks.io/txns/7VcZWHJzgrauZaY6irWh1BiHGcr7kDch92UG69MFvMBD) moved 0.002 USDC from the agent's NEAR account to `unhuntable.near`, submitted and paid for by our relayer; [the next](https://nearblocks.io/txns/6XQ9FdGdfuhGYJcinGyHedhqoBCvxorQ1figfR2RAdaL) took 4.5 seconds from the tool call to the answer. Two opens outside the key's limits were refused in under 0.2 seconds and cost the agent nothing.

Switch it on with `X402=on` (the server's relayer settles payments) and connect any MCP client with the settings the Agents screen shows. Tests: `server/test/agents.test.ts` (keys, limits, refusals before payment, open → seal → status → close with each call paid and recorded), `server/test/x402.test.ts` (the real x402 library's challenge: 2000 units of Circle's USDC on NEAR to our account), and `agent/test/agent.test.ts` (a full MCP session in which no tool answer and no request ever carries the stop price).

[Back to the README](../README.md)
