use super::*;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, NearToken};

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn owner() -> AccountId {
    acc("owner.near")
}
fn server() -> AccountId {
    acc("server.near")
}
fn alice() -> AccountId {
    acc("alice.near")
}

fn hash(byte: u8) -> String {
    format!("{byte:02x}").repeat(32)
}

fn as_caller(who: &AccountId, deposit: NearToken) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(acc("records.near"))
        .predecessor_account_id(who.clone())
        .attached_deposit(deposit)
        .block_timestamp(1_000_000_000_000)
        .build());
}

fn setup() -> Contract {
    as_caller(&owner(), NearToken::from_yoctonear(0));
    let mut c = Contract::new(owner());
    c.add_operator(server());
    c
}

fn plenty() -> NearToken {
    NearToken::from_near(1)
}

/// Parse NEP-297 logs: every log must be EVENT_JSON with our standard and version.
fn events() -> Vec<serde_json::Value> {
    get_logs()
        .iter()
        .map(|l| {
            let json = l.strip_prefix("EVENT_JSON:").unwrap_or_else(|| panic!("not an event log: {l}"));
            let v: serde_json::Value = serde_json::from_str(json).unwrap();
            assert_eq!(v["standard"], "unhuntable");
            assert_eq!(v["version"], "1.0.0");
            assert!(v["event"].is_string());
            v
        })
        .collect()
}

fn panics<F: FnOnce() + std::panic::UnwindSafe>(f: F) -> String {
    let err = std::panic::catch_unwind(f).expect_err("expected a panic");
    err.downcast_ref::<String>().cloned().or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default()
}

#[test]
fn owner_only() {
    let mut c = setup();
    as_caller(&alice(), NearToken::from_yoctonear(0));
    let msg = panics(std::panic::AssertUnwindSafe(|| c.add_operator(alice())));
    assert!(msg.contains(ERR_OWNER), "{msg}");
    assert!(panics(std::panic::AssertUnwindSafe(|| c.allow_guard(hash(1)))).contains(ERR_OWNER));
    assert!(panics(std::panic::AssertUnwindSafe(|| c.revoke_guard(hash(1)))).contains(ERR_OWNER));
    assert!(panics(std::panic::AssertUnwindSafe(|| c.transfer_owner(alice()))).contains(ERR_OWNER));
    assert!(panics(std::panic::AssertUnwindSafe(|| c.remove_operator(server()))).contains(ERR_OWNER));
    assert_eq!(c.owner(), owner());

    as_caller(&owner(), NearToken::from_yoctonear(0));
    c.add_operator(alice());
    c.allow_guard(hash(1));
    c.revoke_guard(hash(1));
    c.remove_operator(alice());
    c.transfer_owner(alice());
    assert_eq!(c.owner(), alice());
    // the old owner is now refused
    assert!(panics(std::panic::AssertUnwindSafe(|| c.allow_guard(hash(2)))).contains(ERR_OWNER));
}

#[test]
fn operator_only() {
    let mut c = setup();
    as_caller(&alice(), plenty());
    assert!(panics(std::panic::AssertUnwindSafe(|| {
        c.register_pieces(vec![hash(1)]);
    }))
    .contains(ERR_OPERATOR));
    assert!(panics(std::panic::AssertUnwindSafe(|| {
        c.record_fee("aurora".into(), "usdc".into(), U128(1), "swap-1".into());
    }))
    .contains(ERR_OPERATOR));
    // the owner is not an operator either
    as_caller(&owner(), plenty());
    assert!(panics(std::panic::AssertUnwindSafe(|| {
        c.register_pieces(vec![hash(1)]);
    }))
    .contains(ERR_OPERATOR));
    // a removed operator is refused
    c.remove_operator(server());
    as_caller(&server(), plenty());
    assert!(panics(std::panic::AssertUnwindSafe(|| {
        c.register_pieces(vec![hash(1)]);
    }))
    .contains(ERR_OPERATOR));
}

#[test]
fn unlisted_guard_refused() {
    let mut c = setup();
    assert!(!c.check_guard(hash(0xab)));
    c.allow_guard(hash(0xab));
    assert!(c.check_guard(hash(0xab)));
    assert!(!c.check_guard(hash(0xac)));
    c.allow_guard(hash(0xac));
    assert_eq!(c.list_guards(0, 10).len(), 2);
    assert_eq!(c.list_guards(1, 10).len(), 1);
    assert_eq!(c.list_guards(0, 1).len(), 1);
    c.revoke_guard(hash(0xab));
    assert!(!c.check_guard(hash(0xab)));
    assert_eq!(c.list_guards(0, 10), vec![hash(0xac)]);
    assert!(panics(std::panic::AssertUnwindSafe(|| c.revoke_guard(hash(0xab)))).contains("not on the guard list"));
    for bad in ["AB".repeat(32), format!("0x{}", "ab".repeat(31)), "ab".repeat(31), "zz".repeat(32)] {
        assert!(panics(std::panic::AssertUnwindSafe(|| c.allow_guard(bad.clone()))).contains(ERR_GUARD_HASH));
        assert!(panics(std::panic::AssertUnwindSafe(|| {
            c.check_guard(bad.clone());
        }))
        .contains(ERR_GUARD_HASH));
    }
}

#[test]
fn registry_holds_hashes_only() {
    let mut c = setup();
    as_caller(&server(), plenty());
    let bad = [
        "ab".repeat(31),                        // too short
        "ab".repeat(33),                        // too long
        "AB".repeat(32),                        // uppercase
        format!("0x{}", "ab".repeat(31)),       // 0x prefix, still 64 chars
        format!("0x{}", "ab".repeat(32)),       // 0x prefix, 66 chars
        format!("{}g", "a".repeat(63)),         // not hex
        format!(" {}", "a".repeat(63)),         // space
        String::new(),
    ];
    for b in &bad {
        let msg = panics(std::panic::AssertUnwindSafe(|| {
            c.register_pieces(vec![hash(1), b.clone()]);
        }));
        assert!(msg.contains(ERR_PIECE_HASH), "{b:?}: {msg}");
        assert!(panics(std::panic::AssertUnwindSafe(|| {
            c.is_registered(b.clone());
        }))
        .contains(ERR_PIECE_HASH));
    }
    // nothing from a refused batch was stored
    assert!(!c.is_registered(hash(1)));

    let r = c.register_pieces(vec![hash(1), hash(2), hash(1)]);
    assert_eq!((r.added, r.ignored), (2, 1));
    assert!(c.is_registered(hash(1)) && c.is_registered(hash(2)));
    assert!(!c.is_registered(hash(3)));
    // the event carries a count, never the hashes
    let ev = events();
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0]["event"], "pieces_registered");
    assert_eq!(ev[0]["data"], serde_json::json!({ "count": 2 }));
    assert!(!get_logs().concat().contains(&hash(1)));
    // a second batch of known hashes adds nothing
    as_caller(&server(), plenty());
    let r = c.register_pieces(vec![hash(1), hash(2)]);
    assert_eq!((r.added, r.ignored), (0, 2));
    assert_eq!(r.storage.cost, U128(0));
}

#[test]
fn fees_add_up() {
    let mut c = setup();
    let assets = ["usdc", "wnear", "eth"];
    let mut want: BTreeMap<String, BTreeMap<String, u128>> = BTreeMap::new();
    // deterministic pseudo-random amounts
    let mut x: u64 = 0x1111_1111;
    for i in 0..200u64 {
        x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let kind = FEE_KINDS[(x >> 33) as usize % FEE_KINDS.len()];
        let asset = assets[(x >> 40) as usize % assets.len()];
        let amount = 1 + ((x >> 12) as u128 % 10_000_000_000);
        as_caller(&server(), plenty());
        c.record_fee(kind.into(), asset.into(), U128(amount), format!("ref-{i}"));
        *want.entry(kind.into()).or_default().entry(asset.into()).or_default() += amount;
    }
    let got: BTreeMap<String, BTreeMap<String, u128>> =
        c.fee_totals().into_iter().map(|(k, m)| (k, m.into_iter().map(|(a, v)| (a, v.0)).collect())).collect();
    assert_eq!(got, want);
    assert_eq!(c.fee_count(), 200);
    // the ledger itself adds up to the same totals
    let mut from_ledger: BTreeMap<String, BTreeMap<String, u128>> = BTreeMap::new();
    let mut from = 0;
    loop {
        let page = c.fees(from, 100);
        if page.is_empty() {
            break;
        }
        for (j, f) in page.iter().enumerate() {
            assert_eq!(f.index, (from as usize + j) as u64);
            *from_ledger.entry(f.kind.clone()).or_default().entry(f.asset.clone()).or_default() += f.amount.0;
        }
        from += page.len() as u32;
    }
    assert_eq!(from_ledger, want);
}

#[test]
fn fee_checks() {
    let mut c = setup();
    as_caller(&server(), plenty());
    let mut fails = |kind: &str, asset: &str, amount: u128, reference: String, want: &str| {
        let msg = panics(std::panic::AssertUnwindSafe(|| {
            c.record_fee(kind.into(), asset.into(), U128(amount), reference.clone());
        }));
        assert!(msg.contains(want), "{msg}");
    };
    fails("bank", "usdc", 1, "r".into(), "fee kind");
    fails("aurora", "", 1, "r".into(), "asset");
    fails("aurora", "usdc", 0, "r".into(), "above zero");
    fails("aurora", "usdc", 1, "r".repeat(129), "at most 128");
    c.record_fee("builder".into(), "usdc".into(), U128(5), "é".repeat(128));
}

#[test]
fn storage_refund() {
    let mut c = setup();
    as_caller(&server(), plenty());
    let r = c.register_pieces(vec![hash(7), hash(8)]);
    assert!(r.storage.cost.0 > 0);
    assert_eq!(r.storage.cost.0 + r.storage.refund.0, plenty().as_yoctonear());
    // the refund goes back to the caller as a transfer
    let receipts = get_created_receipts();
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0].receiver_id, server());
    let cost = r.storage.cost.0;

    // exactly the cost: no refund, no transfer
    as_caller(&server(), NearToken::from_yoctonear(cost));
    let r = c.register_pieces(vec![hash(9), hash(10)]);
    assert_eq!(r.storage, StoragePaid { cost: U128(cost), refund: U128(0) });
    assert!(get_created_receipts().is_empty());

    // too little fails
    as_caller(&server(), NearToken::from_yoctonear(cost - 1));
    let msg = panics(std::panic::AssertUnwindSafe(|| {
        c.register_pieces(vec![hash(11), hash(12)]);
    }));
    assert!(msg.contains("attach at least"), "{msg}");
    as_caller(&server(), NearToken::from_yoctonear(0));
    assert!(panics(std::panic::AssertUnwindSafe(|| {
        c.record_fee("aurora".into(), "usdc".into(), U128(1), "r".into());
    }))
    .contains("attach at least"));
}

#[test]
fn treasury_bounds() {
    let mut c = setup();
    let approvers: Vec<AccountId> = (0..11).map(|i| acc(&format!("signer{i}.near"))).collect();
    as_caller(&alice(), plenty());
    let mut fails = |t: u8, a: Vec<AccountId>, want: &str| {
        let msg = panics(std::panic::AssertUnwindSafe(|| {
            c.set_treasury(t, a.clone());
        }));
        assert!(msg.contains(want), "{msg}");
    };
    fails(0, approvers[..3].to_vec(), "threshold must be between 1");
    fails(4, approvers[..3].to_vec(), "threshold must be between 1");
    fails(1, vec![], "threshold must be between 1");
    fails(5, approvers.clone(), "at most 10 approvers");
    fails(2, vec![approvers[0].clone(), approvers[0].clone()], "different accounts");
    assert_eq!(c.get_treasury(alice()), None);

    c.set_treasury(10, approvers[..10].to_vec());
    c.set_treasury(2, approvers[..3].to_vec());
    let t = c.get_treasury(alice()).unwrap();
    assert_eq!(t.threshold, 2);
    assert_eq!(t.approvers, approvers[..3].to_vec());
    assert_eq!(t.updated_ms, 1_000_000);
    // each caller sets only its own entry
    assert_eq!(c.get_treasury(server()), None);
}

#[test]
fn events_each_method() {
    let mut c = setup();
    assert!(get_logs().is_empty(), "new and add_operator emit nothing");

    let one = |want: &str| -> serde_json::Value {
        let ev = events();
        assert_eq!(ev.len(), 1, "{ev:?}");
        assert_eq!(ev[0]["event"], want);
        ev[0]["data"].clone()
    };

    as_caller(&server(), plenty());
    c.register_pieces(vec![hash(1)]);
    assert_eq!(one("pieces_registered"), serde_json::json!({ "count": 1 }));

    as_caller(&owner(), NearToken::from_yoctonear(0));
    c.allow_guard(hash(2));
    assert_eq!(one("guard_allowed"), serde_json::json!({ "wasm_sha256": hash(2) }));
    as_caller(&owner(), NearToken::from_yoctonear(0));
    c.revoke_guard(hash(2));
    assert_eq!(one("guard_revoked"), serde_json::json!({ "wasm_sha256": hash(2) }));

    as_caller(&server(), plenty());
    c.record_fee("oneclick".into(), "usdc".into(), U128(1234), "swap-7".into());
    assert_eq!(
        one("fee_recorded"),
        serde_json::json!({ "index": 0, "kind": "oneclick", "asset": "usdc", "amount": "1234", "reference": "swap-7" })
    );

    as_caller(&alice(), plenty());
    c.set_treasury(1, vec![alice()]);
    assert_eq!(one("treasury_set"), serde_json::json!({ "account": "alice.near", "threshold": 1, "approvers": ["alice.near"] }));

    as_caller(&owner(), NearToken::from_yoctonear(0));
    c.transfer_owner(alice());
    assert_eq!(one("owner_transferred"), serde_json::json!({ "old_owner": "owner.near", "new_owner": "alice.near" }));

    // views and operator changes emit nothing
    as_caller(&alice(), NearToken::from_yoctonear(0));
    c.add_operator(owner());
    c.remove_operator(owner());
    c.check_guard(hash(2));
    c.is_registered(hash(1));
    c.fee_totals();
    assert!(get_logs().is_empty());
}

#[test]
fn hash_parsing() {
    assert_eq!(parse_hash(&hash(0xab)), Some([0xab; 32]));
    assert_eq!(parse_hash(&"0123456789abcdef".repeat(4)).unwrap()[..8], [0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]);
    assert_eq!(parse_hash(&"ab".repeat(31)), None);
}
