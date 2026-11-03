# Unhuntable — build handoff

Private Hyperliquid perps run through NEAR. A position is split across separate accounts ("shards"), each funded privately, and each traded by a guard that runs in an OutLayer TEE. Stops live inside the guard and are never visible to the market.

This file is for anyone (person or agent) picking up code work. It holds no keys and no live account details. Money, wallets and deploys are run from the owner's machine only.

## What exists (all measured on mainnet)

| Part | Where | State |
|---|---|---|
| Guard (OutLayer WASI P2, Rust) | `guard/` | Deployed. 15 native tests. |
| Client tools | `tools/` | Sealed-box client, guard caller, Hyperliquid master actions, EAS verify. |
| Linking attacks | `attacks/linking_attacks.py` | 6 attacks on public data. |

The guard does:
- One Hyperliquid **agent** key per shard, made from WASI randomness and sealed. The shard's own wallet key stays the Hyperliquid master and approves the agent once. Hyperliquid refuses any transfer signed by an agent, so the guard can trade and cannot move money out.
- Every call except `addr` and `box_pub` must arrive as one sealed box (X25519 + ChaCha20-Poly1305, random salt). OutLayer publishes a hash of each call's input; a box makes that hash useless.
- Stops sealed in storage. A stop fires only when at least 3 of 7 price sources agree and all are past the trigger. Fired flag set by compare-and-swap before the order goes out (at most once).
- Wake band: a random-padded price range with no stop inside, drawn from OutLayer's VRF.
- Caps in code: 25 USD notional per open, leverage 1–10, builder address and rate fixed in code.
- `proof`: totals across registered shards, signed as an EAS off-chain attestation (Base, EAS 1.0.1) by the guard's keystore key. No address leaves the guard.

Ops: `addr`, `box_pub`, `agent`, `leverage`, `open`, `seal`, `tick`, `register`, `proof`, `withdraw_probe`.

## Build and test

```
cd guard
cargo test --lib --test guard_tests          # native, no network
cargo build --target wasm32-wasip2 --release # needs rustup target add wasm32-wasip2
```

Reference vectors come from the official SDKs; regenerate only if a format changes:
- `guard/tests/refgen.py`, `refgen3.py` (hyperliquid-python-sdk 0.24.0, cryptography)
- `tools/easref.cjs` (eas-sdk 2.10.0; use CommonJS, the ESM build fails on Node 24)

Every signature test uses throwaway keys (0x11…, 0x22…, 0x33…). Never put a real key or a real account address in a test.

## Rules for code work

1. No keys, API keys, payment keys, seed phrases, wallet IDs or live account addresses in this repo. `.gitignore` blocks the usual places; still check before every commit.
2. No live money and no deploys from a cloud session. Code, tests and docs only. The owner's machine runs anything that touches funds.
3. Every new signing path gets a byte-exact test against the official SDK, as the existing ones do.
4. The guard never signs bytes a caller supplied. It composes every action from parsed, checked fields.
5. Nothing a caller sends may be plain text if it reveals a stop, a size, a shard or a timing.
6. Plain words in code comments, docs and commit messages. No filler.
7. Commits only at real milestones. No AI attribution lines.
8. No internal labels anywhere in code, docs or commits: no version tags, stage or gate names, test numbers or dates. Describe what the thing does.

## Known limits (keep them honest in any public text)

- OutLayer's public call records show when the guard runs. Matching those times with fills can show that an account uses the guard. It does not show the owner, sibling shards, stops or sizes.
- Exiting Hyperliquid costs about 1.20 USDC flat (1.0 Hyperliquid new-account fee plus about 0.20 to 1Click).
- Builder fees need the builder address to hold at least 100 USDC on Hyperliquid.

## Next code tasks

Listed by the owner when the next build stage starts. Each task names the files to touch and the tests that must pass.
