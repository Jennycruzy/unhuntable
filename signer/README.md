# unhuntable signer contract

Hyperliquid accounts controlled by NEAR Chain Signatures. No private key for these
accounts exists anywhere.

Each piece of a position has its own ed25519 key, made in the user's browser and
backed up by their 12 words. NEAR's MPC network (`v1.signer`) derives the piece's
Hyperliquid account from this contract's account and a path built from that key.
The contract asks the MPC network for a signature only when:

1. the action is one of seven Hyperliquid account actions (below), and the contract
   built the action's hash itself from typed fields. It never signs a hash a caller
   hands it, and it cannot sign orders or account changes. A builder fee approval
   is signed only for the builder address fixed when the contract was built, and
   only at exactly 0.01%;
2. the piece key signed that exact action with the piece's current counter.

Anyone may relay the call. Our server does, so the user's NEAR account never
appears next to their pieces. A relay cannot get a signature without the piece
key, change an amount or a destination, or replay an old request. The contract has
no owner and no admin methods.

Trading itself goes through the guard's Hyperliquid agent key, which Hyperliquid
forbids from moving money. This contract is how the user approves that agent and
how money comes home.

## Actions it can sign

| Tag | Action | Hyperliquid type |
| --- | --- | --- |
| 0 | `ApproveAgent { agent_address, agent_name, nonce }` | `HyperliquidTransaction:ApproveAgent` |
| 1 | `UsdClassTransfer { amount, to_perp, nonce }` | `HyperliquidTransaction:UsdClassTransfer` |
| 2 | `SendAsset { destination, source_dex, destination_dex, token, amount, nonce }` | `HyperliquidTransaction:SendAsset` (`fromSubAccount` is always empty) |
| 3 | `Withdraw { destination, amount, time }` | `HyperliquidTransaction:Withdraw` |
| 4 | `SpotSend { destination, token, amount, time }` | `HyperliquidTransaction:SpotSend` |
| 5 | `UsdSend { destination, amount, time }` | `HyperliquidTransaction:UsdSend` |
| 6 | `ApproveBuilderFee { max_fee_rate, builder, nonce }` | `HyperliquidTransaction:ApproveBuilderFee` |

Addresses are `0x` and 40 lowercase hex characters. Amounts are plain decimals such
as `12.5`. Market list names (`source_dex`, `destination_dex`) are empty for the
main list or up to 16 lowercase letters and digits, such as `xyz`. Anything else is
refused with a plain sentence. `ApproveBuilderFee` is refused unless `builder` is
the address the contract was built with (`UNHUNTABLE_BUILDER`) and `max_fee_rate`
is exactly `0.01%`; a build without that address refuses every one. `SendAsset` is how a piece moves its USDC onto
trade.xyz and back; the app only ever sends it from a piece to itself. The hashes match Hyperliquid's own Python SDK for
every action type (`src/hl_vectors.json`, test `typed_data_hash_matches_hyperliquid_sdk`).

## Treasury mode

A piece's key can hand the piece to a controller, such as a DAO, with
`set_controller`: its signature over `controller_message(piece_key, controller)`
(`unhuntable-controller-v1:<contract>:<piece key hex>:<counter>:<controller>`), which
uses up one counter. From then on `sign` refuses the piece ("this piece is controlled
by another account") and only the controller can have it signed, by calling
`sign_as_controller(piece_key, action)` itself, for a Sputnik DAO through a passed
proposal. The controller can hand the piece on, or back to the piece key, with
`change_controller(piece_key, Option<AccountId>)`. Controllers are kept under their
own storage key, so pieces made before treasury mode need no migration.

## Methods

Arguments and results are borsh, which keeps the contract near 79 KB. A
`PublicKey` is a borsh byte vector: a 4-byte little-endian length (33), the curve
byte `0`, then the 32 key bytes. Strings are a 4-byte length and UTF-8 bytes;
numbers are little-endian; an action is its tag byte followed by its fields in the
order above.

| Method | Who | What it does |
| --- | --- | --- |
| `new(signer: Option<AccountId>, hl_chain: Option<String>)` | once | MPC contract (default `v1.signer`) and `"Mainnet"` or `"Testnet"` |
| `signer()`, `hl_chain()` | view | Settings |
| `controller(piece_key) -> Option<AccountId>`, `controller_message(piece_key, controller) -> String` | view | Treasury mode: who controls a piece, and the text its key signs to hand it over |
| `set_controller(piece_key, controller, signature)`, `change_controller(piece_key, controller)`, `sign_as_controller(piece_key, action)` | piece key once; then the controller | Treasury mode (above) |
| `builder() -> Option<(String, String)>` | view | The one builder address and rate (`0.01%`) a piece can approve, or none when builder fees are off in this build |
| `path(piece_key) -> String` | view | `u1/` followed by the piece key as 64 hex characters |
| `add_piece(piece_key) -> { path, cost, refund }` | anyone, payable | Registers a piece key; storage is paid from the deposit and the rest refunded |
| `counter(piece_key) -> Option<u64>` | view | Actions signed so far; the next message names this number |
| `digest(action) -> String` | view | The EIP-712 digest Hyperliquid recovers the signer from |
| `message(piece_key, action) -> String` | view | The text the piece key signs: `unhuntable-hl-v1:<contract>:<piece key hex>:<counter>:<digest hex>` |
| `sign(piece_key, action, signature: Vec<u8>)` | anyone, payable (≥ 1 yoctoNEAR, ≥ 50 TGas) | Checks the piece key's ed25519 signature over `message`, moves the counter on, and asks the MPC contract to sign the digest. The result is the MPC answer `{big_r, s, recovery_id}` |

Events (NEP-297, standard `unhuntable`): `piece_added` with no data, and
`signed` with the action kind and counter.

## Find a piece's Hyperliquid address

```
v1.signer.derived_public_key({"path": "<path>", "predecessor": "<this contract>", "domain_id": 0})
```

The answer is a secp256k1 key. The Hyperliquid address is the last 20 bytes of the
keccak-256 hash of its 64 uncompressed key bytes. Hyperliquid recovers exactly this
address from the signature: `r` is `big_r` without its first byte, `s` is `s`, and
`v` is `27 + recovery_id`.

## Build and test

```
cargo test                              # unit tests, including the Hyperliquid SDK vectors
cargo near build non-reproducible-wasm --no-abi
UNHUNTABLE_BUILDER=0x<builder address> cargo near build non-reproducible-wasm --no-abi   # with the builder fee
```

On testnet, deploy with `new(Some("v1.signer-prod.testnet"), Some("Testnet"))`.
