# unhuntable records contract

A NEAR contract (Rust, near-sdk 5, built with cargo-near) that keeps public,
checkable records for unhuntable. It holds only hashes, amounts and treasury
settings. It never stores an address that could tie pieces together.

It records four things:

1. **Piece registry.** Each piece is stored as sha256(owner salt ‖ piece id).
   Later a user can prove that a piece was registered by us. Nobody else learns
   which pieces belong together, and no method or event lists the hashes.
2. **Guard allowlist.** The sha256 of every guard wasm build we publish.
   OutLayer reports this hash for every run, so anyone can check that a run used
   one of our builds.
3. **Fee ledger.** Every fee we earn (kind, asset, amount, reference such as a
   swap id). Revenue is public, and the totals add up to the records.
4. **Treasury mirror.** For funds and DAOs: the approvers and threshold set in
   their wallet policy, mirrored here for display.

## Methods

Hashes are always 64 lowercase hex characters. Anything else, such as
uppercase, a `0x` prefix or the wrong length, is refused with "piece hash must
be 64 lowercase hex characters" (or "wasm hash must be 64 lowercase hex
characters" for guards).

| Method | Who | What it does |
| --- | --- | --- |
| `new(owner)` | once | Sets the owner. |
| `owner() -> AccountId` | view | The owner. |
| `transfer_owner(new_owner)` | owner | Hands the contract to a new owner. |
| `add_operator(account)`, `remove_operator(account)` | owner | Operators are our server accounts. |
| `operators() -> Vec<AccountId>` | view | Current operators. |
| `register_pieces(hashes) -> { added, ignored, storage }` | operator, payable | Stores piece hashes. Duplicates are ignored. |
| `is_registered(hash) -> bool` | view | Whether one hash is registered. |
| `allow_guard(wasm_sha256)`, `revoke_guard(wasm_sha256)` | owner | Adds or removes a guard build. |
| `check_guard(wasm_sha256) -> bool` | view | Whether a build is on the list. |
| `list_guards(from_index, limit) -> Vec<String>` | view | Guard builds, up to 100 per page. |
| `record_fee(kind, asset, amount, reference) -> storage` | operator, payable | `kind` is `aurora`, `oneclick`, `agent_call` or `builder`. `amount` is a U128 string above zero, and `reference` is at most 128 characters. |
| `fees(from_index, limit) -> Vec<FeeRecord>` | view | Fee records in order, up to 100 per page. |
| `fee_count() -> u64` | view | Number of fee records. |
| `fee_totals() -> { kind: { asset: total } }` | view | Totals per kind and asset. |
| `set_treasury(threshold, approvers) -> storage` | anyone, payable | Sets the caller's own entry. The threshold is from 1 to the number of approvers, with at most 10 approvers, all different. |
| `get_treasury(account) -> Option<Treasury>` | view | One account's entry. |

**Storage.** Payable methods charge exactly the storage bytes they add and send
the rest of the attached deposit back to the caller. They return
`{ cost, refund }` in yoctoNEAR. If too little is attached, the call fails and
nothing is stored.

**Events.** Events follow NEP-297 with standard `unhuntable`, version `1.0.0`,
logged as `EVENT_JSON:{...}`:

| Event | Data |
| --- | --- |
| `pieces_registered` | `{ count }`: new hashes only, never the hashes |
| `guard_allowed`, `guard_revoked` | `{ wasm_sha256 }` |
| `fee_recorded` | `{ index, kind, asset, amount, reference }` |
| `treasury_set` | `{ account, threshold, approvers }` |
| `owner_transferred` | `{ old_owner, new_owner }` |

Views and operator changes emit nothing.

## Build

Install [cargo-near](https://github.com/near/cargo-near) (`cargo install cargo-near --locked --no-default-features` skips Ledger support, which needs libudev), then:

```bash
cd contract
cargo near build non-reproducible-wasm
```

The wasm is written to `target/near/unhuntable_records.wasm`. A plain
`cargo build` is refused by near-sdk on purpose, because on-chain builds need
the settings cargo-near applies.

## Test

```bash
cd contract
cargo test
```

This runs the unit tests and the sandbox tests in `tests/sandbox.rs`. The
sandbox tests build the contract with `cargo near` (install it as above), start
a local NEAR sandbox node and call the contract there. The first run downloads the
sandbox binary. To use one you already have, set `NEAR_SANDBOX_BIN_PATH`. No
test talks to a public network.

## Check a guard hash

Every OutLayer run reports the sha256 of the wasm it ran. To check that a run
used a published guard build, pass that hash to `check_guard`:

```bash
near contract call-function as-read-only <records contract> check_guard \
  json-args '{"wasm_sha256":"<64 lowercase hex>"}' network-config mainnet now
```

`true` means the build is on our list. `false` means it is not, or it was
revoked, and apps should refuse to use it. To check a build yourself, build the
guard (`cd guard && cargo build --target wasm32-wasip2 --release`) and compare
`sha256sum target/wasm32-wasip2/release/guard.wasm` with the list from
`list_guards`.

## Check a piece

A user who holds their owner salt and a piece id computes
sha256(salt ‖ piece id) and calls `is_registered` with that hash. Only someone
who knows the salt can make the hash, so the registry shows nothing about other
pieces.
