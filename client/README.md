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
