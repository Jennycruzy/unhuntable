# unhuntable agent

An MCP server that lets an AI agent trade through Unhuntable: positions split across
accounts nobody can link, stops sealed where nobody can read them, every call paid
with x402 in USDC on NEAR.

Agents get hunted more than people: their wallets are public, they act on schedules,
and a prompt injection can talk them into saying where their stop is. Here the stop is
sealed on the agent's own machine into a box only the guard (an OutLayer TEE) can open.
It is never placed on Hyperliquid's book, and no tool can read it back, so there is
nothing for a hunter, or for a hostile prompt, to get out of the agent.

## What the agent can and cannot do

The owner makes the agent's key on the Agents screen of the app and sets its limits:
the largest size it may open, which markets (BTC, ETH, SOL), and how many opens a day.

| The agent can | The agent cannot |
| --- | --- |
| Open a position on pieces the owner already set up | Make pieces: that needs the owner's 12 words |
| Seal a stop for each piece | Read a stop back |
| Read its own positions: state, size, distance to liquidation | See Hyperliquid addresses, or positions it did not open |
| Close its own positions | Move money, withdraw, or trade stocks |

The server checks the key and its limits before it asks for payment, so a refused call
costs nothing.

## Tools

| Tool | What it does | Paid calls |
| --- | --- | --- |
| `unhuntable_open` | `{coin, side, sizeUsd, leverage, hiding}`: open on ready pieces | 1 |
| `unhuntable_set_stop` | `{positionId, stopPrice}`: seal the stop for every piece | 2 (status, then the seal) |
| `unhuntable_status` | This agent's positions, with no stop levels | 1 |
| `unhuntable_close` | `{positionId, now}`: close, spread over 90 s or at once | 1 |
| `unhuntable_traders` | Traders who sell keys: prices, counts, closed results, the guard-signed record | 0 |
| `unhuntable_trader_trades` | `{handle}`: closed trades of a trader the owner holds a key to | 1 |
| `unhuntable_follow` | `{handle, kind, copyUsd?}`: ask the owner for a copy or viewing key; it waits for their approval in the app | 1 |

## Paying per call

Every call except the guard's public box key is paid with
[x402](https://x402.org) v2 (scheme `exact`) in Circle's USDC on NEAR. The first
request gets `402 Payment Required` with a `PAYMENT-REQUIRED` challenge naming the
price and our account. The MCP server signs a NEP-366 delegated `ft_transfer` for exactly
that amount with the payer's key, and sends the request again. Our server settles the
payment on NEAR before it runs the call; its own relayer pays the gas, so the payer
needs USDC and no NEAR. The payment's NEAR transaction comes back in every answer and is
listed on the owner's Agents screen. Built on FastNEAR's
[`@fastnear/x402`](https://js.fastnear.com/x402) and the x402 Foundation's NEAR scheme.

## Set it up

```bash
cd client && npm ci && npm run build
cd ../agent && npm ci && npm run build
```

MCP client settings (the Agents screen shows them with the key filled in):

```json
{
  "mcpServers": {
    "unhuntable": {
      "command": "node",
      "args": ["unhuntable/agent/dist/mcp.js"],
      "env": {
        "UNHUNTABLE_URL": "https://tryunhuntable.site",
        "UNHUNTABLE_AGENT_KEY": "uak_...",
        "NEAR_PAYER_ACCOUNT_ID": "<the agent's NEAR account>",
        "NEAR_PAYER_SECRET_KEY": "<its full-access key, ed25519:...>"
      }
    }
  }
}
```

`NEAR_NETWORK` (`near:mainnet` by default) and `NEAR_RPC_URL` are optional. The payer
key never leaves this machine; it signs only the payment.

To pay through PingPay Agent Pay instead, add `"UNHUNTABLE_PAY_WITH": "pingpay"`. Each call
then costs 0.2 USDC: the agent asks Ping for a quote with its own account as the refund
address, sends the quoted amount to the quoted NEAR Intents deposit address with
`ft_transfer` (registering that address with the token first when needed), and sends the
proof. `PINGPAY_TOKEN` picks the NEP-141 token it pays with (USDC on NEAR by default); the
account needs a little NEAR for gas.

## Test

```bash
npm test
```

Twelve tests, no network: stops sealed here open only with the guard's key and carry each
piece's size; a full MCP session over an in-memory transport opens, seals, reads status
and closes; nothing that leaves the machine and no tool answer contains the stop price;
refusals come back in the server's own words; the PingPay payer quotes with its own refund
address, deposits once, retries while NEAR Intents settles, and registers the deposit
address before transferring, and keeps a settling payment's proof so the next call resumes it.
