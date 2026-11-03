# unhuntable client

A small TypeScript library for calling the unhuntable guard on OutLayer.
It needs Node 20 or newer and has no runtime dependencies: it uses only
`node:crypto` and the global `fetch`.

It replaces `tools/gbox.py`, `tools/gcall.sh` and `tools/seal.py`, which are gone.

## What it does

- `sealedBox(guardBoxPub, inner)` wraps one guard call in a sealed box, the
  same way the guard opens it: an ephemeral X25519 key,
  key = sha256("unhuntable-box-v1" ‖ shared ‖ epk ‖ gpk), ChaCha20-Poly1305
  with a random 12-byte nonce and aad "unhuntable-call-v1". A random 32-byte
  hex `salt` is added to the inner JSON, so two equal calls never look alike.
  It returns `{ box: { epk, nonce, ct } }`, which is the whole guard input.
- `boxOpen(secret, box, aad)` opens a box. The guard does this; the library
  has it for tests.
- `callGuard(owner, project, paymentKey, input)` posts `{"input": input}` to
  `https://api.outlayer.ai/call/{owner}/{project}` with the header
  `X-Payment-Key` and returns the answer's `output`. It throws `GuardError`
  when the output has an `error`, and `OutLayerError` on a bad HTTP status or
  an answer it cannot read.
- `GuardClient` has one method per guard op: `addr`, `boxPub`, `agent`,
  `leverage`, `open`, `seal`, `tick`, `register`, `proof`. `addr` and
  `box_pub` go plain. Every other op goes as one sealed box with the op name,
  the shard and all fields inside, so OutLayer's public call record shows only
  ciphertext. A stop for `seal` travels inside that box as `stop`.

The client checks the same fields the guard checks before it spends a call:
shard is 1-16 lowercase letters or digits, coin is BTC, ETH or SOL, side is
long or short, leverage is a whole number 1-10, size and trigger are positive,
and a master account is a 0x address. A bad request throws a `TypeError` and
nothing is sent.

The payment key is only ever passed in by you. The library never reads it from
a file or the environment.

## How to use it

```ts
import { GuardClient } from "unhuntable-client";

const guard = new GuardClient({
  owner: "<outlayer account>",
  project: "guard",
  paymentKey: myPaymentKey, // from your own secret store
});

await guard.addr();
const agent = await guard.agent("alpha"); // approve agent.agent once on Hyperliquid
await guard.register({ shard: "alpha", master: "0x..." });
await guard.leverage({ shard: "alpha", coin: "ETH", leverage: 5 });
await guard.open({ shard: "alpha", coin: "ETH", side: "long", size: 0.01 });
await guard.seal({ shard: "alpha", stop: { coin: "ETH", side: "long", trigger: 2100, size: 0.01 } });
await guard.tick({ shard: "alpha", coin: "ETH", dry: true });
const proof = await guard.proof();
```

The client fetches the guard's box key with `box_pub` on the first sealed call
and keeps it. Pass `boxPub` to the constructor to skip that call.

To check a proof with `tools/easverify.cjs`, save it as `{"output": proof}`
and pass that file.

## Planning a position

`plan(input, vrfBytes)` turns one position into an exact plan for splitting it
across separate accounts ("pieces"). It is pure: no network, no clock, no
`Math.random`. The same input and the same VRF bytes always give the same plan,
so anyone with the VRF output can check the plan later.

```ts
import { plan, isPlanError } from "unhuntable-client/planner";

const p = plan(
  { coin: "ETH", side: "long", notionalUsd: 600, leverage: 5, hiding: "whale",
    markPx: 2300, szDecimals: 4, maxLeverage: 25 },
  vrfBytes,
);
if (isPlanError(p)) console.log(p.message);
else for (const piece of p.pieces) console.log(piece.size, piece.fundingUsd, piece.entryOffsetMs);
```

- `normal` is one piece entering within 90 s. `whale` is 2-12 pieces
  (about $50 each; past 12 pieces they grow), entering between 2 and 20 minutes from now, at least 20 s apart.
- Sizes get a random ±15% each and add up exactly to the total size, rounded
  down to the coin's size decimals.
- Every piece is at least $12, since Hyperliquid refuses orders under $10,
  reduce-only closes included.
- Each piece is funded with one ladder amount (12, 15, 20 ... 1000 USDC) that
  covers its margin, a reserve that keeps liquidation at least 18% away at
  open, trading fees and the $0.33 funding route fee. A piece never needs money
  from another piece.
- Refusals come back as `{ code, message }` with a plain sentence:
  `shard_min_notional`, `max_leverage`, `over_cap` or `bad_input`.

Random numbers are read from the VRF bytes as big-endian u32 / 2^32. When the
bytes run out the stream goes on with sha256(vrf ‖ counter), counter from 0.

## Fill savings

`fillSavings(book, side, totalSize, fills)` compares your fills with taking the
whole size from a Hyperliquid `l2Book` reply in one go (`buy` walks the asks,
`sell` the bids). It returns `{ benchmarkAvgPx, ourAvgPx, savedUsd, savedBps }`,
positive when your fills were better, or `{ code: "book_too_thin" }` when the
book cannot fill the size.

The planner, fill savings and VRF helpers have no `node:` imports, so
`unhuntable-client/planner`, `/fills` and `/vrf` also run in browsers.

## Build and test

```bash
cd client
npm ci
npm run typecheck
npm test
npm run build
```

The tests use no network: HTTP goes through a fake `fetch` and keys are
throwaway bytes. They open the box vector in `guard/tests/ref3.json` made by
the Python reference, and they check that `guard/tests/ref_ts_box.json`, a
sealed `seal` call made by this client with fixed random bytes, is unchanged.
The guard's Rust test `sealed_call_from_ts_client_opens` opens that same file
with `box_open` and reads its stop as the guard does. To rewrite the file
after a deliberate change to the box format:

```bash
WRITE_VECTOR=1 npm test
```

The planner also has property tests (fast-check) that check hundreds of random
positions for the rules above.
