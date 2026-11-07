//! Chain Signatures pieces: hashes match Hyperliquid's own SDK, and the contract
//! signs only when the piece key signed that exact action, once.

use super::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, NearToken};

const VECTORS: &str = include_str!("hl_vectors.json");
const A: &str = "0x1111111111111111111111111111111111111111";

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(who: &str, deposit: NearToken, tgas: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(acc("unhuntable.near"))
        .predecessor_account_id(acc(who))
        .attached_deposit(deposit)
        .prepaid_gas(Gas::from_tgas(tgas))
        .block_timestamp(1_000_000_000_000)
        .build());
}

fn setup(chain: Option<&str>) -> Contract {
    ctx("owner.near", NearToken::from_yoctonear(0), 300);
    Contract::new(None, chain.map(String::from))
}

fn key(seed: u8) -> (SigningKey, PublicKey) {
    let sk = SigningKey::from_bytes(&[seed; 32]);
    let mut b = vec![0u8];
    b.extend_from_slice(sk.verifying_key().as_bytes());
    (sk, PublicKey::try_from(b).unwrap())
}

fn agent(nonce: u64) -> HlAction {
    HlAction::ApproveAgent { agent_address: A.into(), agent_name: String::new(), nonce }
}

fn add(c: &mut Contract, pk: &PublicKey) -> Added {
    ctx("server.near", NearToken::from_near(1), 300);
    c.add_piece(pk.clone())
}

fn sign_with(c: &Contract, sk: &SigningKey, pk: &PublicKey, a: &HlAction) -> Vec<u8> {
    sk.sign(c.message(pk.clone(), a.clone()).as_bytes()).to_bytes().to_vec()
}

fn panics<F: FnOnce() + std::panic::UnwindSafe>(f: F) -> String {
    let err = std::panic::catch_unwind(f).expect_err("expected a panic");
    err.downcast_ref::<String>().cloned().or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default()
}

#[test]
fn typed_data_hash_matches_hyperliquid_sdk() {
    let v: serde_json::Value = serde_json::from_str(VECTORS).unwrap();
    let mut n = 0;
    for net in ["mainnet", "testnet"] {
        let chain = v[net]["hl_chain"].as_str().unwrap();
        let c = setup(Some(chain));
        for case in v[net]["cases"].as_array().unwrap() {
            let a: HlAction = serde_json::from_value(case["action"].clone()).unwrap();
            assert_eq!(c.digest(a), case["hash"].as_str().unwrap(), "{}", case["name"]);
            n += 1;
        }
    }
    assert_eq!(n, 9, "every action type has a vector");
}

#[test]
fn chain_must_be_mainnet_or_testnet() {
    ctx("owner.near", NearToken::from_yoctonear(0), 300);
    let msg = panics(|| {
        Contract::new(None, Some("mainnet".into()));
    });
    assert!(msg.contains(hl::ERR_CHAIN), "{msg}");
    let c = setup(None);
    assert_eq!(c.hl_chain(), "Mainnet");
    assert_eq!(c.signer(), acc("v1.signer"));
}

#[test]
fn bad_fields_refused() {
    let c = setup(None);
    let cases: Vec<(HlAction, &str)> = vec![
        (HlAction::ApproveAgent { agent_address: "0xABCDEF1111111111111111111111111111111111".into(), agent_name: "".into(), nonce: 1 }, hl::ERR_ADDRESS),
        (HlAction::ApproveAgent { agent_address: "0x1234".into(), agent_name: "".into(), nonce: 1 }, hl::ERR_ADDRESS),
        (HlAction::ApproveAgent { agent_address: A.into(), agent_name: "x".repeat(65), nonce: 1 }, hl::ERR_NAME),
        (HlAction::ApproveAgent { agent_address: A.into(), agent_name: "tab\there".into(), nonce: 1 }, hl::ERR_NAME),
        (HlAction::UsdClassTransfer { amount: "1e5".into(), to_perp: true, nonce: 1 }, hl::ERR_AMOUNT),
        (HlAction::UsdClassTransfer { amount: "-1".into(), to_perp: true, nonce: 1 }, hl::ERR_AMOUNT),
        (HlAction::UsdClassTransfer { amount: ".5".into(), to_perp: true, nonce: 1 }, hl::ERR_AMOUNT),
        (HlAction::UsdClassTransfer { amount: "1.".into(), to_perp: true, nonce: 1 }, hl::ERR_AMOUNT),
        (HlAction::UsdClassTransfer { amount: "1.2.3".into(), to_perp: true, nonce: 1 }, hl::ERR_AMOUNT),
        (HlAction::UsdClassTransfer { amount: "".into(), to_perp: true, nonce: 1 }, hl::ERR_AMOUNT),
        (HlAction::Withdraw { destination: A.into(), amount: "1".repeat(25), time: 1 }, hl::ERR_AMOUNT),
        (
            HlAction::SendAsset { destination: A.into(), source_dex: "XYZ".into(), destination_dex: "".into(), token: "USDC".into(), amount: "1".into(), nonce: 1 },
            hl::ERR_DEX,
        ),
        (HlAction::SpotSend { destination: A.into(), token: "".into(), amount: "1".into(), time: 1 }, hl::ERR_TOKEN),
    ];
    for (a, err) in cases {
        let dbg = format!("{a:?}");
        let msg = panics(std::panic::AssertUnwindSafe(|| {
            c.digest(a);
        }));
        assert!(msg.contains(err), "{dbg}: {msg}");
    }
}

#[test]
fn piece_key_must_be_ed25519_and_new() {
    let mut c = setup(None);
    ctx("server.near", NearToken::from_near(1), 300);
    let mut secp = vec![1u8];
    secp.extend_from_slice(&[7u8; 64]);
    let secp = PublicKey::try_from(secp).unwrap();
    let msg = panics(std::panic::AssertUnwindSafe(|| {
        c.add_piece(secp.clone());
    }));
    assert!(msg.contains(ERR_PIECE_KEY), "{msg}");

    let (_, pk) = key(1);
    let piece = add(&mut c, &pk);
    assert!(piece.path.starts_with(PATH_PREFIX));
    assert_eq!(piece.path.len(), PATH_PREFIX.len() + 64);
    assert_eq!(piece.path, c.path(pk.clone()));
    assert!(piece.cost > 0);
    assert_eq!(c.counter(pk.clone()), Some(0));
    let logs = get_logs();
    assert!(logs.iter().any(|l| l.contains("\"event\":\"piece_added\"")), "{logs:?}");
    // the event carries nothing that identifies the piece
    assert!(!logs.iter().any(|l| l.contains(&piece.path[PATH_PREFIX.len()..])), "{logs:?}");

    let msg = panics(std::panic::AssertUnwindSafe(|| {
        add(&mut c, &pk);
    }));
    assert!(msg.contains(ERR_KNOWN_PIECE), "{msg}");
}

#[test]
fn signs_only_what_the_piece_key_signed() {
    let mut c = setup(None);
    let (sk, pk) = key(2);
    add(&mut c, &pk);
    let a = agent(42);
    let sig = sign_with(&c, &sk, &pk, &a);

    // our server relays it: any caller works, the piece key is what counts
    ctx("server.near", NearToken::from_yoctonear(1), 100);
    let _ = c.sign(pk.clone(), a.clone(), sig.clone());
    assert_eq!(c.counter(pk.clone()), Some(1));

    let receipts = get_created_receipts();
    assert_eq!(receipts.len(), 1);
    let r = &receipts[0];
    assert_eq!(r.receiver_id, acc("v1.signer"));
    let s = format!("{:?}", r.actions);
    let digest = c.digest(a.clone());
    let want = format!(r#"{{"request":{{"path":"{}","payload_v2":{{"Ecdsa":"{}"}},"domain_id":0}}}}"#, c.path(pk.clone()), digest);
    let field = |name: &str| -> String {
        let start = s.find(&format!("{name}: [")).unwrap_or_else(|| panic!("no {name} in {s}")) + name.len() + 3;
        let end = start + s[start..].find(']').unwrap();
        let bytes: Vec<u8> = s[start..end].split(", ").map(|n| n.parse().unwrap()).collect();
        String::from_utf8(bytes).unwrap()
    };
    assert_eq!(field("method_name"), "sign");
    assert_eq!(field("args"), want);
    assert!(s.contains("attached_deposit: NearToken { inner: 1 }"), "{s}");
    assert!(s.contains("gas_weight: GasWeight(1)"), "{s}");
    let logs = get_logs();
    assert!(logs.iter().any(|l| l.contains("\"event\":\"signed\"") && l.contains("\"kind\":\"approve_agent\"") && l.contains("\"counter\":0")), "{logs:?}");
}

#[test]
fn replay_refused() {
    let mut c = setup(None);
    let (sk, pk) = key(3);
    add(&mut c, &pk);
    let a = agent(1);
    let sig = sign_with(&c, &sk, &pk, &a);
    ctx("server.near", NearToken::from_yoctonear(1), 100);
    let _ = c.sign(pk.clone(), a.clone(), sig.clone());
    // the same signature again: the counter moved, so it no longer matches
    let msg = panics(std::panic::AssertUnwindSafe(|| {
        let _ = c.sign(pk.clone(), a.clone(), sig.clone());
    }));
    assert!(msg.contains(ERR_PIECE_SIG), "{msg}");
    assert_eq!(c.counter(pk), Some(1));
}

#[test]
fn server_cannot_change_the_action() {
    let mut c = setup(None);
    let (sk, pk) = key(4);
    add(&mut c, &pk);
    // the owner signed a small withdraw home…
    let home = HlAction::Withdraw { destination: A.into(), amount: "1".into(), time: 5 };
    let sig = sign_with(&c, &sk, &pk, &home);
    // …a relay tries to send it elsewhere, or more of it, with the same signature
    let elsewhere = HlAction::Withdraw { destination: "0x9999999999999999999999999999999999999999".into(), amount: "1".into(), time: 5 };
    let more = HlAction::Withdraw { destination: A.into(), amount: "100".into(), time: 5 };
    ctx("server.near", NearToken::from_yoctonear(1), 100);
    for bad in [elsewhere, more] {
        let msg = panics(std::panic::AssertUnwindSafe(|| {
            let _ = c.sign(pk.clone(), bad.clone(), sig.clone());
        }));
        assert!(msg.contains(ERR_PIECE_SIG), "{msg}");
    }
    assert_eq!(c.counter(pk.clone()), Some(0));
    // the action the owner signed still goes through
    let _ = c.sign(pk.clone(), home, sig);
    assert_eq!(c.counter(pk), Some(1));
}

#[test]
fn other_piece_key_refused() {
    let mut c = setup(None);
    let (_, pk) = key(5);
    let (other_sk, other_pk) = key(6);
    add(&mut c, &pk);
    add(&mut c, &other_pk);
    let a = agent(9);
    // a valid signature, but by a different piece's key
    let sig = other_sk.sign(c.message(pk.clone(), a.clone()).as_bytes()).to_bytes().to_vec();
    ctx("server.near", NearToken::from_yoctonear(1), 100);
    let msg = panics(std::panic::AssertUnwindSafe(|| {
        let _ = c.sign(pk.clone(), a.clone(), sig.clone());
    }));
    assert!(msg.contains(ERR_PIECE_SIG), "{msg}");
}

#[test]
fn unregistered_key_and_bad_inputs_refused() {
    let mut c = setup(None);
    let (sk, pk) = key(7);
    let a = agent(1);
    let raw = vec![0u8; 64];
    ctx("server.near", NearToken::from_yoctonear(1), 100);
    let msg = panics(std::panic::AssertUnwindSafe(|| {
        let _ = c.sign(pk.clone(), a.clone(), raw.clone());
    }));
    assert!(msg.contains(ERR_NO_PIECE), "{msg}");

    add(&mut c, &pk);
    let sig = sign_with(&c, &sk, &pk, &a);
    ctx("server.near", NearToken::from_yoctonear(1), 100);
    let msg = panics(std::panic::AssertUnwindSafe(|| {
        let _ = c.sign(pk.clone(), a.clone(), vec![1u8; 63]);
    }));
    assert!(msg.contains(ERR_SIG_LEN), "{msg}");

    ctx("server.near", NearToken::from_yoctonear(0), 100);
    let msg = panics(std::panic::AssertUnwindSafe(|| {
        let _ = c.sign(pk.clone(), a.clone(), sig.clone());
    }));
    assert!(msg.contains(ERR_SIGN_DEPOSIT), "{msg}");

    ctx("server.near", NearToken::from_yoctonear(1), 30);
    let msg = panics(std::panic::AssertUnwindSafe(|| {
        let _ = c.sign(pk.clone(), a.clone(), sig.clone());
    }));
    assert!(msg.contains(ERR_SIGN_GAS), "{msg}");
    assert_eq!(c.counter(pk), Some(0));
}

#[test]
fn message_names_contract_piece_counter_and_digest() {
    let mut c = setup(None);
    let (_, pk) = key(8);
    add(&mut c, &pk);
    let a = agent(3);
    let m = c.message(pk.clone(), a.clone());
    let parts: Vec<&str> = m.split(':').collect();
    assert_eq!(parts[0], "unhuntable-hl-v1");
    assert_eq!(parts[1], "unhuntable.near");
    assert_eq!(parts[2], &c.path(pk.clone())[PATH_PREFIX.len()..]);
    assert_eq!(parts[3], "0");
    assert_eq!(parts[4], c.digest(a));
}

#[test]
fn borsh_tags_never_change() {
    // Clients encode actions with these tags; reordering the enum would break them.
    let t = |a: HlAction| near_sdk::borsh::to_vec(&a).unwrap()[0];
    assert_eq!(t(agent(1)), 0);
    assert_eq!(t(HlAction::UsdClassTransfer { amount: "1".into(), to_perp: true, nonce: 1 }), 1);
    assert_eq!(t(HlAction::SendAsset { destination: A.into(), source_dex: "".into(), destination_dex: "".into(), token: "T".into(), amount: "1".into(), nonce: 1 }), 2);
    assert_eq!(t(HlAction::Withdraw { destination: A.into(), amount: "1".into(), time: 1 }), 3);
    assert_eq!(t(HlAction::SpotSend { destination: A.into(), token: "T".into(), amount: "1".into(), time: 1 }), 4);
    assert_eq!(t(HlAction::UsdSend { destination: A.into(), amount: "1".into(), time: 1 }), 5);
}

#[test]
fn piece_key_wire_format() {
    // A borsh PublicKey is a byte vector: 4-byte little-endian length (33), curve byte 0, 32 key bytes.
    let (_, pk) = key(9);
    let b = near_sdk::borsh::to_vec(&pk).unwrap();
    assert_eq!(&b[..5], &[33, 0, 0, 0, 0]);
    assert_eq!(b.len(), 37);
}
