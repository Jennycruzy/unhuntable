//! Sandbox tests: the contract built with cargo-near, deployed to a local NEAR sandbox.
//! Nothing here talks to a public network.

use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use tokio::sync::OnceCell;

static WASM: OnceCell<Vec<u8>> = OnceCell::const_new();

async fn wasm() -> &'static [u8] {
    WASM.get_or_init(|| async { near_workspaces::compile_project("./").await.expect("contract builds") }).await
}

struct Env {
    _worker: Worker<near_workspaces::network::Sandbox>,
    contract: Contract,
    owner: Account,
    server: Account,
    alice: Account,
}

async fn setup() -> anyhow::Result<Env> {
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(wasm().await).await?;
    let owner = worker.dev_create_account().await?;
    let server = worker.dev_create_account().await?;
    let alice = worker.dev_create_account().await?;
    contract.call("new").args_json(json!({ "owner": owner.id() })).transact().await?.into_result()?;
    owner.call(contract.id(), "add_operator").args_json(json!({ "account": server.id() })).transact().await?.into_result()?;
    Ok(Env { _worker: worker, contract, owner, server, alice })
}

fn hash(byte: u8) -> String {
    format!("{byte:02x}").repeat(32)
}

fn failure(r: &ExecutionFinalResult) -> String {
    assert!(r.is_failure(), "expected the call to fail");
    format!("{:?}", r.clone().into_result().unwrap_err())
}

/// The contract's own logs (not refund receipts), parsed as NEP-297 events.
fn event_logs(r: &ExecutionFinalResult) -> Vec<Value> {
    r.logs()
        .iter()
        .map(|l| {
            let v: Value = serde_json::from_str(l.strip_prefix("EVENT_JSON:").expect("event log")).unwrap();
            assert_eq!(v["standard"], "unhuntable");
            assert_eq!(v["version"], "1.0.0");
            v
        })
        .collect()
}

impl Env {
    async fn call(&self, who: &Account, method: &str, args: Value, deposit: NearToken) -> anyhow::Result<ExecutionFinalResult> {
        Ok(who.call(self.contract.id(), method).args_json(args).deposit(deposit).max_gas().transact().await?)
    }

    async fn check_guard(&self, h: String) -> anyhow::Result<bool> {
        self.view("check_guard", json!({ "wasm_sha256": h })).await
    }

    async fn view<T: near_sdk::serde::de::DeserializeOwned>(&self, method: &str, args: Value) -> anyhow::Result<T> {
        Ok(self.contract.view(method).args_json(args).await?.json()?)
    }
}

const NONE: NearToken = NearToken::from_yoctonear(0);
const ONE: NearToken = NearToken::from_near(1);

#[tokio::test]
async fn owner_only() -> anyhow::Result<()> {
    let e = setup().await?;
    for (method, args) in [
        ("add_operator", json!({ "account": e.alice.id() })),
        ("allow_guard", json!({ "wasm_sha256": hash(1) })),
        ("revoke_guard", json!({ "wasm_sha256": hash(1) })),
        ("transfer_owner", json!({ "new_owner": e.alice.id() })),
    ] {
        let r = e.call(&e.alice, method, args, NONE).await?;
        assert!(failure(&r).contains("only the owner can do this"), "{method}");
    }
    assert_eq!(e.view::<String>("owner", json!({})).await?, e.owner.id().to_string());
    e.call(&e.owner, "add_operator", json!({ "account": e.alice.id() }), NONE).await?.into_result()?;
    e.call(&e.owner, "allow_guard", json!({ "wasm_sha256": hash(1) }), NONE).await?.into_result()?;
    e.call(&e.owner, "revoke_guard", json!({ "wasm_sha256": hash(1) }), NONE).await?.into_result()?;
    e.call(&e.owner, "transfer_owner", json!({ "new_owner": e.alice.id() }), NONE).await?.into_result()?;
    assert_eq!(e.view::<String>("owner", json!({})).await?, e.alice.id().to_string());
    Ok(())
}

#[tokio::test]
async fn operator_only() -> anyhow::Result<()> {
    let e = setup().await?;
    let r = e.call(&e.alice, "register_pieces", json!({ "hashes": [hash(1)] }), ONE).await?;
    assert!(failure(&r).contains("only an operator can do this"));
    let r = e.call(&e.alice, "record_fee", json!({ "kind": "aurora", "asset": "usdc", "amount": "1", "reference": "r" }), ONE).await?;
    assert!(failure(&r).contains("only an operator can do this"));
    e.call(&e.server, "register_pieces", json!({ "hashes": [hash(1)] }), ONE).await?.into_result()?;
    Ok(())
}

#[tokio::test]
async fn unlisted_guard_refused() -> anyhow::Result<()> {
    let e = setup().await?;
    assert!(!e.check_guard(hash(0xab)).await?);
    e.call(&e.owner, "allow_guard", json!({ "wasm_sha256": hash(0xab) }), NONE).await?.into_result()?;
    assert!(e.check_guard(hash(0xab)).await?);
    assert_eq!(e.view::<Vec<String>>("list_guards", json!({ "from_index": 0, "limit": 10 })).await?, vec![hash(0xab)]);
    e.call(&e.owner, "revoke_guard", json!({ "wasm_sha256": hash(0xab) }), NONE).await?.into_result()?;
    assert!(!e.check_guard(hash(0xab)).await?);
    Ok(())
}

#[tokio::test]
async fn registry_holds_hashes_only() -> anyhow::Result<()> {
    let e = setup().await?;
    for bad in ["ab".repeat(31), "AB".repeat(32), format!("0x{}", "ab".repeat(31)), format!("{}g", "a".repeat(63))] {
        let r = e.call(&e.server, "register_pieces", json!({ "hashes": [bad] }), ONE).await?;
        assert!(failure(&r).contains("piece hash must be 64 lowercase hex characters"));
    }
    let r = e.call(&e.server, "register_pieces", json!({ "hashes": [hash(1), hash(2), hash(1)] }), ONE).await?;
    let ev = event_logs(&r);
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0]["event"], "pieces_registered");
    assert_eq!(ev[0]["data"], json!({ "count": 2 }));
    assert!(!r.logs().concat().contains(&hash(1)));
    let out: Value = r.json()?;
    assert_eq!((out["added"].as_u64(), out["ignored"].as_u64()), (Some(2), Some(1)));
    assert!(e.view::<bool>("is_registered", json!({ "hash": hash(1) })).await?);
    assert!(!e.view::<bool>("is_registered", json!({ "hash": hash(3) })).await?);
    // there is no view that lists piece hashes
    for method in ["pieces", "list_pieces", "get_pieces"] {
        assert!(e.contract.view(method).args_json(json!({})).await.is_err(), "{method}");
    }
    Ok(())
}

#[tokio::test]
async fn fees_add_up() -> anyhow::Result<()> {
    let e = setup().await?;
    let kinds = ["aurora", "oneclick", "agent_call", "builder"];
    let assets = ["usdc", "wnear"];
    let mut want: BTreeMap<String, BTreeMap<String, u128>> = BTreeMap::new();
    let mut x: u64 = 0x2222_2222;
    for i in 0..24 {
        x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let kind = kinds[(x >> 33) as usize % kinds.len()];
        let asset = assets[(x >> 40) as usize % assets.len()];
        let amount = 1 + ((x >> 8) as u128 % 1_000_000_000_000_000_000_000);
        e.call(&e.server, "record_fee", json!({ "kind": kind, "asset": asset, "amount": amount.to_string(), "reference": format!("swap-{i}") }), ONE)
            .await?
            .into_result()?;
        *want.entry(kind.into()).or_default().entry(asset.into()).or_default() += amount;
    }
    let got: BTreeMap<String, BTreeMap<String, String>> = e.view("fee_totals", json!({})).await?;
    let got: BTreeMap<String, BTreeMap<String, u128>> =
        got.into_iter().map(|(k, m)| (k, m.into_iter().map(|(a, v)| (a, v.parse().unwrap())).collect())).collect();
    assert_eq!(got, want);
    let page: Vec<Value> = e.view("fees", json!({ "from_index": 20, "limit": 10 })).await?;
    assert_eq!(page.len(), 4);
    assert_eq!(page[0]["index"], 20);
    assert_eq!(page[0]["reference"], "swap-20");
    Ok(())
}

#[tokio::test]
async fn storage_refund() -> anyhow::Result<()> {
    let e = setup().await?;
    let before = e.server.view_account().await?.balance;
    let r = e.call(&e.server, "register_pieces", json!({ "hashes": [hash(5), hash(6), hash(7)] }), ONE).await?;
    let out: Value = r.clone().into_result()?.json()?;
    let cost: u128 = out["storage"]["cost"].as_str().unwrap().parse()?;
    let refund: u128 = out["storage"]["refund"].as_str().unwrap().parse()?;
    assert!(cost > 0);
    assert_eq!(cost + refund, ONE.as_yoctonear());
    let after = e.server.view_account().await?.balance;
    let spent = before.as_yoctonear() - after.as_yoctonear();
    // the caller paid the storage cost plus gas, not the whole attached NEAR
    assert!(spent >= cost, "spent {spent} < cost {cost}");
    assert!(spent < cost + NearToken::from_millinear(10).as_yoctonear(), "spent {spent}, cost {cost}");

    // too little fails and keeps nothing
    let r = e.call(&e.server, "register_pieces", json!({ "hashes": [hash(8), hash(9), hash(10)] }), NearToken::from_yoctonear(cost - 1)).await?;
    assert!(failure(&r).contains("attach at least"));
    assert!(!e.view::<bool>("is_registered", json!({ "hash": hash(8) })).await?);
    Ok(())
}

#[tokio::test]
async fn treasury_bounds() -> anyhow::Result<()> {
    let e = setup().await?;
    let names: Vec<String> = (0..11).map(|i| format!("signer{i}.near")).collect();
    for (t, a, want) in [
        (0, names[..3].to_vec(), "threshold must be between 1"),
        (4, names[..3].to_vec(), "threshold must be between 1"),
        (5, names.clone(), "at most 10 approvers"),
    ] {
        let r = e.call(&e.alice, "set_treasury", json!({ "threshold": t, "approvers": a }), ONE).await?;
        assert!(failure(&r).contains(want), "{want}");
    }
    assert_eq!(e.view::<Option<Value>>("get_treasury", json!({ "account": e.alice.id() })).await?, None);
    e.call(&e.alice, "set_treasury", json!({ "threshold": 2, "approvers": names[..3] }), ONE).await?.into_result()?;
    let t: Value = e.view("get_treasury", json!({ "account": e.alice.id() })).await?;
    assert_eq!(t["threshold"], 2);
    assert_eq!(t["approvers"], json!(names[..3]));
    Ok(())
}

#[tokio::test]
async fn events() -> anyhow::Result<()> {
    let e = setup().await?;
    let one = |r: &ExecutionFinalResult, want: &str| -> Value {
        assert!(r.is_success(), "{:?}", r.failures());
        let ev = event_logs(r);
        assert_eq!(ev.len(), 1, "{ev:?}");
        assert_eq!(ev[0]["event"], want);
        ev[0]["data"].clone()
    };
    let r = e.call(&e.server, "register_pieces", json!({ "hashes": [hash(1)] }), ONE).await?;
    assert_eq!(one(&r, "pieces_registered"), json!({ "count": 1 }));
    let r = e.call(&e.owner, "allow_guard", json!({ "wasm_sha256": hash(2) }), NONE).await?;
    assert_eq!(one(&r, "guard_allowed"), json!({ "wasm_sha256": hash(2) }));
    let r = e.call(&e.owner, "revoke_guard", json!({ "wasm_sha256": hash(2) }), NONE).await?;
    assert_eq!(one(&r, "guard_revoked"), json!({ "wasm_sha256": hash(2) }));
    let r = e.call(&e.server, "record_fee", json!({ "kind": "builder", "asset": "usdc", "amount": "77", "reference": "fill-1" }), ONE).await?;
    assert_eq!(one(&r, "fee_recorded"), json!({ "index": 0, "kind": "builder", "asset": "usdc", "amount": "77", "reference": "fill-1" }));
    let r = e.call(&e.alice, "set_treasury", json!({ "threshold": 1, "approvers": [e.alice.id()] }), ONE).await?;
    assert_eq!(one(&r, "treasury_set"), json!({ "account": e.alice.id(), "threshold": 1, "approvers": [e.alice.id()] }));
    let r = e.call(&e.owner, "transfer_owner", json!({ "new_owner": e.alice.id() }), NONE).await?;
    assert_eq!(one(&r, "owner_transferred"), json!({ "old_owner": e.owner.id(), "new_owner": e.alice.id() }));
    let r = e.call(&e.alice, "add_operator", json!({ "account": e.owner.id() }), NONE).await?;
    assert!(r.is_success() && r.logs().is_empty());
    Ok(())
}
