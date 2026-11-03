# unhuntable guard

The guard is a WASI program that runs on OutLayer. For each shard it holds one
Hyperliquid agent key, made from WASI randomness and kept sealed. An agent key
can place and cancel orders but Hyperliquid refuses any transfer it signs, so
the guard can trade a shard's account and can never move money out of it.

All decisions live in `src/lib.rs` as pure functions and are tested natively:

```bash
cargo test --lib --test guard_tests
```

`src/main.rs` only reads and writes sealed storage, fetches prices and sends
orders. It builds for OutLayer with:

```bash
cargo build --target wasm32-wasip2 --release
```

## Calls

`addr` and `box_pub` are sent plain. Every other op is sent as one sealed box:
`{"box": {"epk", "nonce", "ct"}}`, sealed to the guard's box key with aad
`unhuntable-call-v1`. The op name, the shard and every field are inside the
box, so OutLayer's public call record shows only ciphertext. A sealed call may
also carry a plain `"shard"` next to `"box"` for routing; if it does, it must
equal the shard inside the box, or the guard refuses with "shard does not
match the sealed call".

A shard id is 1-16 lowercase letters or digits. A coin is BTC, ETH or SOL.
A side is `long` or `short` and always means the side of the position.

| op | input | output |
| --- | --- | --- |
| `addr` | `{}` | `{hl_address, vrf_public_key}` |
| `box_pub` | `{}` | `{box_pub}` |
| `agent` | `{shard}` | `{shard, agent}`: the agent address to approve once on Hyperliquid |
| `register` | `{shard, master}` | `{registered}`: stores the shard's master account, sealed |
| `leverage` | `{shard, coin, leverage}` | `{hl}` |
| `open` | `{shard, coin, side, size, builder?}` | `{mid, prices, action, hl}` |
| `seal` | `{shard, stop: {coin, side, trigger, size}, jitter_bps?}` | `{sealed}` |
| `seal_tp` | `{shard, tp: {coin, side, trigger, size}}` | `{sealed}` |
| `tick` | `{shard, coin, dry?, defend?, builder?}` | `{done, band, has_stop, has_tp, defence, order, sources_ok, sources_agree, source_errors, price_ms}` |
| `tick_coin` | `{coin, shards: [1-32 ids], dry?, defend?, builder?}` | `{shards: {id: {done, band, has_stop, has_tp, defence, order}}, sources_ok, sources_agree, source_errors, price_ms}` |
| `defend` | `{shard, coin, dry?}` | `{action, rung, distance, size?, hl?}` plus the price summary |
| `close` | `{shard, coin}` | `{done: "closed", size, hl}` or `{done: "nothing_open"}` |
| `vrf` | `{label}` | `{output_hex, proof, alpha}` |
| `proof` | `{}` | `{eas, totals}`: signed track-record totals across all shards |
| `withdraw_probe` | `{shard}` | `{agent, http, body}`: Hyperliquid's refusal of a transfer signed by the agent |

`done` in a tick is one of `no_agreement`, `watch`, `fired`, `would_fire`,
`took_profit`, `would_take_profit` or `already_fired_elsewhere`. `has_stop`
and `has_tp` are null when there is none. `dry` reports what would happen and
sends nothing.

## Prices

Each price round asks seven public sources. A price counts only when at least
three sources agree within 0.5% of their median; the median of the agreeing
prices is the mid. With no agreement nothing fires, nothing is cut and nothing
is closed.

## Stops and take-profits

A stop fires when every agreeing price is at or past the trigger against the
position: at or below it for a long, at or above it for a short. A
take-profit is the same the other way: at or above for a long, at or below for
a short. One bad or bribed feed cannot fire either. If both are hit at once the
stop fires.

A fire is marked in sealed storage with compare-and-swap before the order is
sent, so each stop and take-profit fires at most once, even when two runs race.

`seal` takes an optional `jitter_bps`, a whole number 0-100. The guard draws
VRF bytes (label `jitter-<shard>-<coin>-<ms>`) and moves the trigger by a
random amount within plus or minus that many basis points before storing it.
The stored trigger is never returned.

The wake band in a tick is a price range around the mid that holds no live
stop or take-profit. Each edge facing a trigger sits no further than a random 25-75% of the
way from the mid to it, drawn from VRF, so the edges never point at a trigger.

## Defence ladder

`defend`, and `tick` or `tick_coin` with `defend: true`, read the shard's
position and liquidation price from Hyperliquid's `clearinghouseState` for the
registered master account. The distance is `|mid - liquidationPx| / mid`, using
the agreed mid. No liquidation price means no action.

| distance | step |
| --- | --- |
| under 12% | cut 25% of the current size |
| under 8% | cut another 25% |
| under 5% | close the whole position |
| 15% or more | the ladder resets to 0 |

The rung reached (0-3) is kept sealed at `defend:<shard>:<coin>`, written with
compare-and-swap before the order is sent. Each rung fires once and rungs only
go up until the distance is back at 15% or more, so a cut is not repeated
while the price hovers. Climbing two rungs at once cuts 25% twice. Sizes are
rounded down to the coin's size decimals. A cut under $10, or one that would
leave less than $10, closes the position instead. With no position the ladder
resets to 0.

## Caps

- One open is at most 5000 USD of notional at the agreed mid (`MAX_NOTIONAL_USD`).
- Leverage is a whole number 1-10.
- `tick_coin` takes 1-32 shards, with no repeats.
- `jitter_bps` is 0-100.
- A `vrf` label is 1-64 characters of a-z, 0-9 and `-`. The draw uses seed
  `plan-<label>`; `alpha` is the full string OutLayer signed, so anyone can
  check a plan's random draw against `vrf_public_key` from `addr`.

## Rules every op keeps

- No output, error or log holds a stop or take-profit trigger, a jittered
  trigger or a master address. Addresses in Hyperliquid replies are replaced
  with `0x(address)`. Outputs hold done states, bands, booleans, counts, the
  sizes of orders sent, Hyperliquid replies and the liquidation distance.
- Every order for close, take-profit, stop and defence is reduce-only and
  immediate-or-cancel, 3% through the agreed mid, signed by that shard's agent
  key. Reduce-only means it can only make the position smaller.
- The guard has no way to move funds. The only transfer it ever signs is the
  1 USDC send in `withdraw_probe`, which exists to show that Hyperliquid
  refuses it.
