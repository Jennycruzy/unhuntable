# Security and privacy

Who could cheat and why they cannot, who sees what, the attacks we ran on our own pieces, and the flaw we found for OutLayer.

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

What you do trust: OutLayer's enclave holds the keys, and runs the guard build that our project names on `outlayer.near`. Which build that is, and every build we ever published, is public on NEAR: `get_project` answers the active build's hash and `list_versions` lists each build with its hash and the address of the exact file, so anyone can download the file OutLayer runs and check its hash. The active build is `9fcd15a7…`, built from [`guard/`](../guard/) at commit `045d307`. Steps: [Check it yourself](check-it-yourself.md), step 9.

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

## The signed track record

The guard's `proof` op reads every registered piece's equity and net deposits and signs an EAS off-chain attestation (schema `uint64 asOf, uint32 shards, int64 equityMicroUsd, int64 netDepositsMicroUsd, int64 pnlMicroUsd, string outlayerCall`). It carries totals only. To check one:

```bash
cd tools && npm install && node easverify.cjs proof.json
```

(`proof.json` holds OutLayer's answer to a `proof` call, as `{"output": ...}`) → the SDK's verify result, the recovered signer (the guard's key), the decoded totals, and an easscan link. The attestation names the OutLayer call that made it, and OutLayer's attestation for that call gives the wasm hash of the guard that ran.

## Work for OutLayer

While building this we found that OutLayer's public attestation records are listed by sequential id and carry an unsalted hash of each call's input. For short inputs such as a stop price, the input can be recovered by guessing. We showed it on our own call and reported it with a fix: [out-layer/outlayer#35](https://github.com/out-layer/outlayer/issues/35). Our guard does not depend on the fix: every call is one sealed box with a random salt, so the public hash is a hash of ciphertext.

[Back to the README](../README.md)
