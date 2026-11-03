use guardlib::*;
fn sign(d: [u8; 32]) -> Vec<u8> {
    sign_with(&[0x11u8; 32], &d).unwrap()
}

fn reference() -> serde_json::Value {
    serde_json::from_str(include_str!("ref.json")).unwrap()
}

#[test]
fn address_matches_reference() {
    assert_eq!(address_of(&[0x11u8; 32]).unwrap(), reference()["addr"].as_str().unwrap());
}

#[test]
fn order_signatures_match_reference_sdk() {
    let r = reference();
    let builder = "0x1234567890abcdef1234567890abcdef12345678";
    let ours = [
        (order_action(asset("ETH").unwrap(), false, 2187.3, 0.0051, None), 1730000000000u64),
        (order_action(asset("ETH").unwrap(), true, 2316.6, 0.0123, Some((builder, 10))), 1730000000001),
        (order_action(asset("BTC").unwrap(), false, 104321.0, 0.00011, None), 1730000000002),
    ];
    for (i, (a, n)) in ours.iter().enumerate() {
        let c = &r["cases"][i];
        assert_eq!(to_json(a), c["action"], "action json {i}");
        assert_eq!(sig_json(&sign(l1_digest(a, *n))), c["sig"], "signature {i}");
    }
}

#[test]
fn builder_fee_signature_matches_reference_sdk() {
    let r = reference();
    let d = builder_fee_digest("0.01%", "0x1234567890abcdef1234567890abcdef12345678", 1730000000003);
    assert_eq!(sig_json(&sign(d)), r["builder_fee"]["sig"]);
}

#[test]
fn wire_and_rounding() {
    assert_eq!(float_to_wire(2187.30), "2187.3");
    assert_eq!(float_to_wire(0.00011), "0.00011");
    assert_eq!(float_to_wire(100.0), "100");
    assert_eq!(round_px(2187.3456, 4), 2187.3); // 5 sig figs
    assert_eq!(round_px(104321.7, 5), 104322.0);
    assert_eq!(round_px(99999.75, 5), 100000.0);
    assert_eq!(round_sz(0.00519, 4), 0.0051);
}

fn long_stop() -> Stop {
    Stop { coin: "ETH".into(), side: "long".into(), trigger: 2100.0, size: 0.0051, fired: false }
}

#[test]
fn one_bad_feed_cannot_fire() {
    // four honest feeds at 2250, one feed lies at 2000 (below the stop)
    let a = agreed(&[2250.0, 2251.0, 2249.5, 2000.0, 2250.5]).unwrap();
    assert!(!should_fire(&long_stop(), &a));
    // two lying feeds still cannot fire
    let a = agreed(&[2250.0, 2251.0, 2249.5, 2000.0, 2001.0]).unwrap();
    assert!(!should_fire(&long_stop(), &a));
}

#[test]
fn too_few_sources_never_fire() {
    assert!(agreed(&[2000.0, 2000.0]).is_none());
    assert!(agreed(&[2000.0, 2300.0, 1800.0]).is_none());
}

#[test]
fn real_crash_fires_once() {
    let a = agreed(&[2095.0, 2096.0, 2094.0, 2099.0]).unwrap();
    let mut s = long_stop();
    assert!(should_fire(&s, &a));
    s.fired = true;
    assert!(!should_fire(&s, &a));
}

#[test]
fn short_stop_fires_on_rise() {
    let s = Stop { coin: "ETH".into(), side: "short".into(), trigger: 2400.0, size: 0.01, fired: false };
    assert!(should_fire(&s, &agreed(&[2401.0, 2402.0, 2405.0]).unwrap()));
    assert!(!should_fire(&s, &agreed(&[2399.0, 2402.0, 2405.0]).unwrap()));
}

#[test]
fn wake_band_never_contains_the_stop() {
    let s = long_stop();
    let sh = Stop { coin: "ETH".into(), side: "short".into(), trigger: 2260.0, size: 0.01, fired: false };
    for i in 0..1000 {
        let u1 = (i as f64 * 0.618034) % 1.0;
        let u2 = (i as f64 * 0.414214) % 1.0;
        let (lo, hi) = wake_band(2250.0, Some(&s), u1, u2);
        assert!(lo > s.trigger && lo < 2250.0 && hi > 2250.0);
        let (lo, hi) = wake_band(2250.0, Some(&sh), u1, u2);
        assert!(hi < sh.trigger && hi > 2250.0 && lo < 2250.0);
    }
}

#[test]
fn close_order_is_reduce_only_ioc_against_position() {
    let a = to_json(&close_order(&long_stop(), 2250.0, None).unwrap());
    let o = &a["orders"][0];
    assert_eq!(o["b"], false); // long → sell
    assert_eq!(o["r"], true);
    assert_eq!(o["t"]["limit"]["tif"], "Ioc");
    assert_eq!(o["p"], "2182.5"); // 3% through
    assert_eq!(o["s"], "0.0051");
}

fn ref3() -> serde_json::Value {
    serde_json::from_str(include_str!("ref3.json")).unwrap()
}

#[test]
fn agent_key_leverage_and_open_match_reference_sdk() {
    let r = ref3();
    let k = [0x22u8; 32];
    assert_eq!(address_of(&k).unwrap(), r["addr"].as_str().unwrap());
    let lev = update_leverage_action(asset("ETH").unwrap(), 10);
    assert_eq!(to_json(&lev), r["lev"]["action"]);
    assert_eq!(sig_json(&sign_with(&k, &l1_digest(&lev, 1730000000010)).unwrap()), r["lev"]["sig"]);
    // open: buy 0.0045 ETH, mid 2263.1 → px 2331.0 (3% through, 5 sig figs)
    let op = open_order(asset("ETH").unwrap(), true, 2263.1068, 0.0045, None);
    assert_eq!(to_json(&op), r["open"]["action"]);
    assert_eq!(sig_json(&sign_with(&k, &l1_digest(&op, 1730000000011)).unwrap()), r["open"]["sig"]);
}

#[test]
fn sealed_box_from_python_client_opens() {
    let b = &ref3()["box"];
    let h = |k: &str| hex::decode(b[k].as_str().unwrap()).unwrap();
    let sk = [0x33u8; 32];
    assert_eq!(box_public(&sk).to_vec(), h("gpk"));
    let pt = box_open(&sk, &h("epk"), &h("nonce"), &h("ct"), b"a").unwrap();
    assert_eq!(String::from_utf8(pt).unwrap(), b["pt"].as_str().unwrap());
    // wrong shard (aad) or tampered ciphertext must not open
    assert!(box_open(&sk, &h("epk"), &h("nonce"), &h("ct"), b"b").is_err());
    let mut ct = h("ct");
    ct[0] ^= 1;
    assert!(box_open(&sk, &h("epk"), &h("nonce"), &ct, b"a").is_err());
}

#[test]
fn shard_names() {
    assert!(valid_shard("a") && valid_shard("shard2"));
    assert!(!valid_shard("") && !valid_shard("A") && !valid_shard("a:b") && !valid_shard("aaaaaaaaaaaaaaaaa"));
}

#[test]
fn usd_send_digest_matches_reference_sdk() {
    let r: serde_json::Value = serde_json::from_str(include_str!("ref_usdsend.json")).unwrap();
    let d = usd_send_digest("0x1234567890abcdef1234567890abcdef12345678", "1", 1730000000020);
    let ours = sig_json(&sign_with(&[0x22u8; 32], &d).unwrap());
    // the SDK prints r/s without leading zeros; compare the numbers
    let n = |v: &serde_json::Value| v.as_str().unwrap().trim_start_matches("0x").trim_start_matches('0').to_string();
    assert_eq!(n(&ours["r"]), n(&r["r"]));
    assert_eq!(n(&ours["s"]), n(&r["s"]));
    assert_eq!(ours["v"], r["v"]);
}

#[test]
fn eas_offchain_attestation_matches_sdk() {
    let r: serde_json::Value = serde_json::from_str(include_str!("ref_eas.json")).unwrap();
    assert_eq!(format!("0x{}", hex::encode(eas_schema_uid())), r["schemaUid"].as_str().unwrap());
    let p = Proof { as_of: 1793700000, shards: 2, equity_micro: 2669202, net_deposits_micro: 2678831, pnl_micro: -9629,
                    call: "00000000-0000-4000-8000-000000000001".into() };
    let data = eas_data(&p);
    assert_eq!(format!("0x{}", hex::encode(&data)), r["data"].as_str().unwrap());
    let sig = sign_with(&[0x22u8; 32], &eas_digest(1793700100, &data, &[0xab; 32])).unwrap();
    let s = &r["signature"];
    let n = |v: &serde_json::Value| v.as_str().unwrap().trim_start_matches("0x").trim_start_matches('0').to_string();
    let ours = sig_json(&sig);
    assert_eq!(n(&ours["r"]), n(&s["r"]));
    assert_eq!(n(&ours["s"]), n(&s["s"]));
    assert_eq!(ours["v"], s["v"]);
}
