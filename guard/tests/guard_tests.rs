use guardlib::*;
use serde_json::json;
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
        let (lo, hi) = wake_band(2250.0, Some(&s), None, u1, u2);
        assert!(lo > s.trigger && lo < 2250.0 && hi > 2250.0);
        let (lo, hi) = wake_band(2250.0, Some(&sh), None, u1, u2);
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

    let eth = asset("ETH").unwrap();
    // a long position (positive szi) closes with a sell 3% under the mid
    let long = to_json(&close_position_order(eth, 0.0051, 2250.0).unwrap());
    let o = &long["orders"][0];
    assert_eq!((o["b"].clone(), o["r"].clone(), o["p"].clone(), o["s"].clone()), (false.into(), true.into(), "2182.5".into(), "0.0051".into()));
    assert_eq!(o["t"]["limit"]["tif"], "Ioc");
    // a short position (negative szi) closes with a buy 3% over the mid, for the full size
    let short = to_json(&close_position_order(eth, -0.0123, 2250.0).unwrap());
    let o = &short["orders"][0];
    assert_eq!((o["b"].clone(), o["r"].clone(), o["p"].clone(), o["s"].clone()), (true.into(), true.into(), "2317.5".into(), "0.0123".into()));
    assert_eq!(o["t"]["limit"]["tif"], "Ioc");
    // nothing open: no order
    assert!(close_position_order(eth, 0.0, 2250.0).is_none());
    assert!(close_position_order(eth, -0.0, 2250.0).is_none());
    assert!(close_position_order(eth, 0.00001, 2250.0).is_none()); // under one size step
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
    // wrong aad or tampered ciphertext must not open
    assert!(box_open(&sk, &h("epk"), &h("nonce"), &h("ct"), b"b").is_err());
    let mut ct = h("ct");
    ct[0] ^= 1;
    assert!(box_open(&sk, &h("epk"), &h("nonce"), &ct, b"a").is_err());
}

#[test]
fn sealed_call_from_ts_client_opens() {
    let r: serde_json::Value = serde_json::from_str(include_str!("ref_ts_box.json")).unwrap();
    let h = |k: &str| hex::decode(r[k].as_str().unwrap()).unwrap();
    let sk = [0x33u8; 32];
    assert_eq!(box_public(&sk).to_vec(), h("gpk"));
    let pt = box_open(&sk, &h("epk"), &h("nonce"), &h("ct"), b"unhuntable-call-v1").unwrap();
    assert_eq!(String::from_utf8(pt.clone()).unwrap(), r["pt"].as_str().unwrap());
    let input: serde_json::Value = serde_json::from_slice(&pt).unwrap();
    assert_eq!(input["op"], "seal");
    assert_eq!(input["shard"], r["shard"]);
    assert!(valid_shard(input["shard"].as_str().unwrap()));
    assert_eq!(input["salt"].as_str().unwrap().len(), 64);
    // the guard reads the stop from input["stop"] exactly like this
    let st: Stop = serde_json::from_value(input["stop"].clone()).unwrap();
    assert_eq!(st, Stop { coin: "ETH".into(), side: "long".into(), trigger: 2100.5, size: 0.0045, fired: false });
    // a box made for a call never opens with the shard name as aad
    assert!(box_open(&sk, &h("epk"), &h("nonce"), &h("ct"), b"alpha").is_err());
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

// ---------------------------------------------------------------- trading and defence

/// Small fixed-seed generator so property loops are the same on every run.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    /// uniform in [0,1)
    fn u(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
    fn range(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * self.u()
    }
}

fn trig(side: &str, trigger: f64) -> Stop {
    Stop { coin: "ETH".into(), side: side.into(), trigger, size: 0.01, fired: false }
}

#[test]
fn outer_shard_must_match_box() {

    let inner = json!({ "op": "tick", "shard": "ab12", "coin": "ETH" });
    assert!(check_outer_shard(&json!({ "box": {}, "shard": "ab12" }), &inner).is_ok());
    assert_eq!(check_outer_shard(&json!({ "box": {}, "shard": "cd34" }), &inner).unwrap_err(), "shard does not match the sealed call");
    assert!(check_outer_shard(&json!({ "box": {} }), &inner).is_ok());
    assert!(check_outer_shard(&json!({ "box": {}, "shard": null }), &inner).is_ok());
    // an outer shard on a call with no shard inside, or not a string, is refused too
    assert!(check_outer_shard(&json!({ "box": {}, "shard": "ab12" }), &json!({ "op": "proof" })).is_err());
    assert!(check_outer_shard(&json!({ "box": {}, "shard": 12 }), &json!({ "shard": 12 })).is_err());
}

#[test]
fn tp_fires_only_in_profit_direction() {
    let long = trig("long", 2400.0);
    assert!(should_take_profit(&long, &[2400.0, 2401.0, 2405.0]));
    assert!(!should_take_profit(&long, &[2399.0, 2401.0, 2405.0]));
    assert!(!should_take_profit(&long, &[2000.0, 2001.0, 2002.0])); // a fall is not profit for a long
    let short = trig("short", 2000.0);
    assert!(should_take_profit(&short, &[1999.0, 2000.0, 1995.0]));
    assert!(!should_take_profit(&short, &[2001.0, 1999.0, 1995.0]));
    assert!(!should_take_profit(&short, &[2500.0, 2501.0, 2502.0]));
    assert!(!should_take_profit(&trig("up", 1.0), &[2.0, 2.0, 2.0]));
    // never with fewer than three prices
    assert!(!should_take_profit(&long, &[2500.0, 2500.0]));
}

#[test]
fn tp_fires_once() {
    let mut tp = trig("long", 2400.0);
    let a = agreed(&[2410.0, 2411.0, 2409.0, 2412.0]).unwrap();
    assert!(should_take_profit(&tp, &a));
    tp.fired = true;
    assert!(!should_take_profit(&tp, &a));
    let d = decide_shard(None, Some(&tp), Some(&a), Some(median(&a)), 0.5, 0.5);
    assert_eq!(d.fire, Fire::Nothing);
}

#[test]
fn one_bad_feed_cannot_fire_tp() {
    let tp = trig("long", 2400.0);
    // honest feeds at 2250, one lies at 2500 (past the take-profit)
    let a = agreed(&[2250.0, 2251.0, 2249.5, 2500.0, 2250.5]).unwrap();
    assert!(!should_take_profit(&tp, &a));
    let a = agreed(&[2250.0, 2251.0, 2249.5, 2500.0, 2501.0]).unwrap();
    assert!(!should_take_profit(&tp, &a));
    // feeds that do not agree give no prices at all
    assert!(agreed(&[2250.0, 2500.0, 2600.0]).is_none());
}

#[test]
fn wake_band_never_contains_stop_or_tp() {
    let mut r = Rng(0x1234_5678_9abc_def1);
    for _ in 0..20_000 {
        let price = r.range(5.0, 150_000.0);
        let u1 = r.u();
        let u2 = r.u();
        let side = if r.u() < 0.5 { "long" } else { "short" };
        // triggers anywhere from 0.05% to 60% away, on either side of the price
        let away = |r: &mut Rng| {
            let f = r.range(0.0005, 0.6);
            if r.u() < 0.5 { price * (1.0 - f) } else { price * (1.0 + f) }
        };
        let stop = (r.u() < 0.8).then(|| trig(side, away(&mut r)));
        let tp = (r.u() < 0.8).then(|| trig(side, away(&mut r)));
        let (lo, hi) = wake_band(price, stop.as_ref(), tp.as_ref(), u1, u2);
        assert!(lo < price && price < hi);
        for t in [stop.as_ref(), tp.as_ref()].into_iter().flatten() {
            assert!(t.trigger < lo || t.trigger > hi, "trigger inside band");
        }
        // with no take-profit the band is the old stop-only band
        if let Some(st) = stop.as_ref() {
            let (a, b) = wake_band(price, Some(st), None, u1, u2);
            assert!(st.trigger < a || st.trigger > b);
        }
    }
}

#[test]
fn stop_jitter_within_tolerance() {
    let mut r = Rng(42);
    for _ in 0..20_000 {
        let t = r.range(1.0, 200_000.0);
        let bps = (r.next() % 101) as u64;
        let u = r.u();
        let j = jitter_trigger(t, bps, u);
        let w = t * bps as f64 / 10_000.0;
        assert!(j >= t - w - 1e-9 * t && j <= t + w + 1e-9 * t);
        assert_eq!(jitter_trigger(t, 0, u), t);
    }
    // u spreads results across the whole band: every tenth of it is hit
    let mut seen = [false; 10];
    for i in 0..1000 {
        let j = jitter_trigger(2000.0, 100, (i as f64 + 0.5) / 1000.0);
        seen[(((j - 1980.0) / 40.0) * 10.0).floor().clamp(0.0, 9.0) as usize] = true;
    }
    assert!(seen.iter().all(|x| *x));
    assert_eq!(jitter_trigger(2000.0, 100, 0.0), 1980.0);
    // jitter_bps: missing is 0, 0-100 whole numbers pass, the rest is refused

    assert_eq!(check_jitter_bps(&json!(null)).unwrap(), 0);
    assert_eq!(check_jitter_bps(&json!(100)).unwrap(), 100);
    assert!(check_jitter_bps(&json!(101)).is_err());
    assert!(check_jitter_bps(&json!(-1)).is_err());
    assert!(check_jitter_bps(&json!(2.5)).is_err());
    assert!(check_jitter_bps(&json!("5")).is_err());
}

/// What the tick op decides for one shard on its own, written out the long way.
fn single_tick(stop: Option<&Stop>, tp: Option<&Stop>, prices: &[f64], u1: f64, u2: f64) -> (&'static str, Option<(f64, f64)>) {
    match agreed(prices) {
        None => ("no_agreement", None),
        Some(a) => {
            let m = median(&a);
            let done = if stop.is_some_and(|s| should_fire(s, &a)) {
                "fired"
            } else if tp.is_some_and(|t| should_take_profit(t, &a)) {
                "took_profit"
            } else {
                "watch"
            };
            (done, Some(wake_band(m, stop, tp, u1, u2)))
        }
    }
}

#[test]
fn tick_coin_matches_single_ticks() {
    let mut r = Rng(7);
    for _ in 0..2000 {
        let base = r.range(100.0, 5000.0);
        let n = 2 + (r.next() % 6) as usize;
        let prices: Vec<f64> = (0..n).map(|_| base * (1.0 + r.range(-0.008, 0.008))).collect();
        let agree = agreed(&prices);
        let mid = agree.as_ref().map(|a| median(a));
        let shards = 1 + (r.next() % 32) as usize;
        for _ in 0..shards {
            let side = if r.u() < 0.5 { "long" } else { "short" };
            let mut stop = (r.u() < 0.7).then(|| trig(side, base * r.range(0.97, 1.03)));
            let tp = (r.u() < 0.7).then(|| trig(side, base * r.range(0.97, 1.03)));
            if let Some(s) = stop.as_mut() {
                s.fired = r.u() < 0.2;
            }
            let (u1, u2) = (r.u(), r.u());
            let d = decide_shard(stop.as_ref(), tp.as_ref(), agree.as_deref(), mid, u1, u2);
            let (done, band) = single_tick(stop.as_ref(), tp.as_ref(), &prices, u1, u2);
            assert_eq!(d.done(false), done);
            assert_eq!(d.band, band);
        }
    }
}

#[test]
fn tick_coin_shard_list_checks() {

    assert_eq!(check_shards(&json!(["a", "b2"])).unwrap(), vec!["a".to_string(), "b2".to_string()]);
    let full: Vec<String> = (0..32).map(|i| format!("s{i}")).collect();
    assert_eq!(check_shards(&json!(full)).unwrap().len(), 32);
    let over: Vec<String> = (0..33).map(|i| format!("s{i}")).collect();
    assert!(check_shards(&json!(over)).is_err());
    assert_eq!(check_shards(&json!(["a", "b", "a"])).unwrap_err(), "duplicate shard");
    assert!(check_shards(&json!([])).is_err());
    assert!(check_shards(&json!(["A"])).is_err());
    assert!(check_shards(&json!("a")).is_err());
    assert!(check_shards(&json!(null)).is_err());
}

#[test]
fn defence_ladder_steps() {
    let (mid, szd) = (2000.0, 4);
    let size = 1.0; // $2000 of ETH
    let step = |d: f64, rung: u8| defence_step(d, rung, size, mid, szd);
    // boundaries are exact: 12% itself does nothing, just under cuts 25%
    assert_eq!(step(0.12, 0).kind, DefenceKind::Nothing);
    assert_eq!(step(0.1199, 0), DefenceAction { kind: DefenceKind::Cut, rung: 1, size: 0.25 });
    assert_eq!(step(0.08, 1).kind, DefenceKind::Nothing);
    assert_eq!(step(0.0799, 1), DefenceAction { kind: DefenceKind::Cut, rung: 2, size: 0.25 });
    assert_eq!(step(0.05, 2).kind, DefenceKind::Nothing);
    assert_eq!(step(0.0499, 2), DefenceAction { kind: DefenceKind::Close, rung: 3, size: 1.0 });
    // each rung fires once
    assert_eq!(step(0.10, 1), DefenceAction { kind: DefenceKind::Nothing, rung: 1, size: 0.0 });
    assert_eq!(step(0.06, 2).kind, DefenceKind::Nothing);
    assert_eq!(step(0.01, 3).kind, DefenceKind::Nothing);
    // rungs never go down while the price hovers under 15%
    assert_eq!(step(0.13, 2).rung, 2);
    assert_eq!(step(0.1499, 3).rung, 3);
    // reset only at 15% or more
    assert_eq!(step(0.15, 3), DefenceAction { kind: DefenceKind::Nothing, rung: 0, size: 0.0 });
    assert_eq!(step(0.40, 1).rung, 0);
    // jumping two rungs at once cuts 25% twice
    assert_eq!(step(0.07, 0), DefenceAction { kind: DefenceKind::Cut, rung: 2, size: 0.4375 });
    assert_eq!(step(0.03, 0).kind, DefenceKind::Close);
    // a cut under $10, or one that would leave under $10, closes instead
    assert_eq!(defence_step(0.10, 0, 0.015, 2000.0, 4), DefenceAction { kind: DefenceKind::Close, rung: 1, size: 0.015 });
    assert_eq!(defence_step(0.10, 0, 0.0065, 2000.0, 4).kind, DefenceKind::Close);
    // sizes round down to the size decimals
    assert_eq!(defence_step(0.10, 0, 0.12345, 2000.0, 4).size, 0.0308);
    // no position or no price: nothing
    assert_eq!(defence_step(0.01, 0, 0.0, mid, szd).kind, DefenceKind::Nothing);
    assert_eq!(defence_step(f64::NAN, 1, size, mid, szd), DefenceAction { kind: DefenceKind::Nothing, rung: 1, size: 0.0 });
    // property: an order never exceeds the position, rungs never go down below 15%
    let mut r = Rng(99);
    for _ in 0..20_000 {
        let d = r.range(0.0, 0.3);
        let rung = (r.next() % 4) as u8;
        let size = r.range(0.0001, 50.0);
        let mid = r.range(5.0, 120_000.0);
        let szd = (r.next() % 6) as u32;
        let a = defence_step(d, rung, size, mid, szd);
        assert!(a.size >= 0.0 && a.size <= size);
        assert!(a.rung <= 3);
        if d < DEFENCE_RESET {
            assert!(a.rung >= rung);
        } else {
            assert_eq!(a.rung, 0);
        }
        if a.kind == DefenceKind::Cut {
            assert!(a.size * mid >= MIN_ORDER_USD && (size - a.size) * mid >= MIN_ORDER_USD);
        }
        if a.kind != DefenceKind::Nothing {
            assert!(a.rung > rung);
        }
    }
}

#[test]
fn positions_from_clearinghouse_state() {
    let st = serde_json::json!({
        "assetPositions": [
            { "position": { "coin": "BTC", "szi": "0.001", "liquidationPx": null } },
            { "position": { "coin": "ETH", "szi": "-0.0123", "liquidationPx": "2600.5" } }
        ],
        "marginSummary": { "accountValue": "40.0" }
    });
    assert_eq!(position_of(&st, "ETH"), Some(Position { szi: -0.0123, liquidation_px: Some(2600.5) }));
    assert_eq!(position_of(&st, "BTC"), Some(Position { szi: 0.001, liquidation_px: None }));
    assert_eq!(position_of(&st, "SOL"), None);
    assert!((liq_distance(2000.0, 1800.0).unwrap() - 0.1).abs() < 1e-12);
    assert!((liq_distance(2000.0, 2200.0).unwrap() - 0.1).abs() < 1e-12);
    assert!(liq_distance(0.0, 1.0).is_none());
}

#[test]
fn vrf_label_rule() {
    assert!(valid_vrf_label("a") && valid_vrf_label("plan-7-eth") && valid_vrf_label(&"a".repeat(64)));
    assert!(!valid_vrf_label("") && !valid_vrf_label(&"a".repeat(65)));
    assert!(!valid_vrf_label("Plan") && !valid_vrf_label("a_b") && !valid_vrf_label("a b") && !valid_vrf_label("a:b"));
}

#[test]
fn open_over_cap_refused() {
    assert_eq!(MAX_NOTIONAL_USD, 5000.0);
    assert!(check_open_cap(1.0, 5000.0).is_ok());
    assert!(check_open_cap(1.0, 5000.01).is_err());
    assert!(check_open_cap(2.0, 2500.0).is_ok());
    assert!(check_open_cap(2.0, 2500.01).is_err());
    assert!(check_open_cap(f64::INFINITY, 1.0).is_err());
}

#[test]
fn seal_inputs_checked() {

    let st = check_trigger(&json!({ "coin": "eth", "side": "long", "trigger": 2100.0, "size": 0.01, "fired": true }), "stop").unwrap();
    assert_eq!(st, trig("long", 2100.0));
    assert!(check_trigger(&json!({ "coin": "DOGE", "side": "long", "trigger": 1.0, "size": 1.0 }), "stop").is_err());
    assert!(check_trigger(&json!({ "coin": "ETH", "side": "up", "trigger": 1.0, "size": 1.0 }), "stop").is_err());
    assert!(check_trigger(&json!({ "coin": "ETH", "side": "long", "trigger": 0.0, "size": 1.0 }), "stop").is_err());
    assert!(check_trigger(&json!({ "coin": "ETH", "side": "long", "trigger": 1.0, "size": -1.0 }), "stop").is_err());
    assert!(check_trigger(&json!(null), "take-profit").is_err());
}

/// Every way a trigger could be written as text.
fn spellings(x: f64) -> Vec<String> {
    vec![format!("{x}"), format!("{x:.2}"), format!("{x:.3}"), format!("{x:.4}"), format!("{x:e}"), float_to_wire(x), serde_json::json!(x).to_string()]
}

#[test]
fn stop_level_never_in_output() {
    let master = "0x9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";
    let mut r = Rng(2024);
    for _ in 0..3000 {
        let price = r.range(50.0, 90_000.0);
        let side = if r.u() < 0.5 { "long" } else { "short" };
        let far = |r: &mut Rng| price * if r.u() < 0.5 { r.range(0.80, 0.99) } else { r.range(1.01, 1.20) };
        let t0 = far(&mut r);
        let stop = trig(side, jitter_trigger(t0, 1 + r.next() % 100, r.u()));
        let tp = trig(side, far(&mut r));
        let prices: Vec<f64> = (0..5).map(|_| price * (1.0 + r.range(-0.002, 0.002))).collect();
        let a = agreed(&prices).unwrap();
        let mid = median(&a);
        let d = decide_shard(Some(&stop), Some(&tp), Some(&a), Some(mid), r.u(), r.u());
        // Hyperliquid replies can name accounts; reports drop every address
        let hl = serde_json::json!({ "http": 200, "body": { "status": "err", "response": format!("User {master} has no margin") } });
        let liq = if side == "long" { price * 0.9 } else { price * 1.1 };
        let dist = liq_distance(mid, liq);
        let step = defence_step(dist.unwrap(), 0, 0.5, mid, 4);
        let info = PriceInfo { sources_ok: 5, sources_agree: Some(a.len()), source_errors: vec!["okx: 451".into()], price_ms: 812 };
        let defence = defend_report(&step, dist, Some(hl.clone()));
        let shard = shard_report(d.done(false), d.band, still_live(Some(&stop), d.fire == Fire::Stop), still_live(Some(&tp), d.fire == Fire::TakeProfit), defence.clone(), hl.clone());
        let outs = [
            tick_report(shard.clone(), &info),
            tick_coin_report(vec![("ab12".into(), shard.clone()), ("cd34".into(), shard)], &info),
            tick_report(defence, &info),
            close_report(0.5, hl.clone()),
        ];
        for o in outs {
            let text = o.to_string();
            for t in [t0, stop.trigger, tp.trigger] {
                for sp in spellings(t) {
                    assert!(!text.contains(&sp), "trigger {sp} in {text}");
                }
            }
            assert!(!text.to_lowercase().contains(&master[2..]), "master address in {text}");
        }
    }
}

#[test]
fn guard_has_no_transfer_path() {
    let main = include_str!("../src/main.rs");
    let lib = include_str!("../src/lib.rs");
    for word in ["spotSend", "usdClassTransfer", "withdraw3", "vaultTransfer"] {
        assert!(!main.contains(word) && !lib.contains(word), "{word} found");
    }
    assert!(!lib.contains("usdSend"));
    // cut the withdraw_probe op out of main.rs: from its arm to the next arm
    let start = main.find("\"withdraw_probe\" =>").expect("withdraw_probe op");
    let end = start + main[start..].find("_ => return Err").expect("end of ops");
    assert!(main[start..end].contains("usdSend"));
    let rest = format!("{}{}", &main[..start], &main[end..]);
    assert!(!rest.contains("usdSend"), "usdSend outside withdraw_probe");
}

// ---------------------------------------------------------------- trade.xyz (HIP-3)

#[test]
fn trade_xyz_leverage_and_open_match_reference_sdk() {
    let r: serde_json::Value = serde_json::from_str(include_str!("ref_xyz.json")).unwrap();
    let k = [0x22u8; 32];
    let nvda = asset("xyz:NVDA").unwrap();
    assert_eq!(nvda.index, 110_002);
    assert_eq!(nvda.dex, "xyz");
    let lev = update_leverage_action(nvda, 5);
    assert_eq!(to_json(&lev), r["lev"]["action"]);
    assert_eq!(sig_json(&sign_with(&k, &l1_digest(&lev, 1730000000020)).unwrap()), r["lev"]["sig"]);
    // short 0.112 NVDA at mid 178.28: 3% through is 172.93
    let op = open_order(nvda, false, 178.28, 0.112, None);
    assert_eq!(to_json(&op), r["open"]["action"]);
    assert_eq!(sig_json(&sign_with(&k, &l1_digest(&op, 1730000000021)).unwrap()), r["open"]["sig"]);
}

#[test]
fn coin_names_any_case() {
    assert_eq!(asset("xyz:nvda").unwrap().coin, "xyz:NVDA");
    assert_eq!(asset("eth").unwrap().coin, "ETH");
    assert!(asset("NVDA").is_none(), "a stock is only known by its trade.xyz name");
    assert!(asset("xyz:JIO").is_none(), "no outside price, so no market");
    assert_eq!(to_json(&update_leverage_action(asset("BTC").unwrap(), 3))["isCross"], true);
    let st = check_trigger(&json!({ "coin": "XYZ:tsla", "side": "short", "trigger": 400.0, "size": 0.5 }), "stop").unwrap();
    assert_eq!(st.coin, "xyz:TSLA");
}

#[test]
fn every_market_is_unique_and_stocks_have_outside_prices() {
    for (i, a) in ASSETS.iter().enumerate() {
        assert!(ASSETS.iter().skip(i + 1).all(|b| b.coin != a.coin && b.index != a.index), "{}", a.coin);
        assert_eq!(a.dex == "xyz", a.coin.starts_with("xyz:"), "{}", a.coin);
        assert_eq!(a.dex == "xyz", a.outside.is_some(), "{}", a.coin);
        assert_eq!(a.dex == "xyz", a.index >= 110_000, "{}", a.coin);
    }
}

#[test]
fn moving_the_xyz_book_alone_cannot_fire_a_stock_stop() {
    let stop = Stop { coin: "xyz:NVDA".into(), side: "long".into(), trigger: 170.0, size: 0.1, fired: false };
    // the book is pushed to 165; oracle, Yahoo and Nasdaq stay at 178
    let a = agreed_outside(&[(165.0, false), (178.1, true), (178.2, true), (178.15, true)]).unwrap();
    assert!(!should_fire(&stop, &a));
    // a real fall: everything at 169
    let a = agreed_outside(&[(169.0, false), (169.1, true), (168.9, true), (169.05, true)]).unwrap();
    assert!(should_fire(&stop, &a));
}

#[test]
fn stocks_need_two_outside_sources() {
    // market shut: Yahoo and Nasdaq stale, only the book and the oracle are left
    assert!(agreed_outside(&[(178.0, false), (178.1, true)]).is_none());
    // three agree but only one is outside the book
    assert!(agreed_outside(&[(178.0, false), (178.05, false), (178.1, true)]).is_none());
    // book, oracle and Yahoo agree: two outside
    assert_eq!(agreed_outside(&[(178.0, false), (178.1, true), (178.05, true)]).unwrap().len(), 3);
    // an outside source far away does not count
    assert!(agreed_outside(&[(178.0, false), (178.1, true), (190.0, true)]).is_none());
}

#[test]
fn yahoo_last_minute_with_a_close() {
    let v = json!({ "chart": { "result": [{ "timestamp": [100, 160, 220], "indicators": { "quote": [{ "close": [178.1, 178.2, null] }] } }] } });
    assert_eq!(yahoo_last(&v), Some((178.2, 160)));
    assert_eq!(yahoo_last(&json!({ "chart": { "result": null } })), None);
}

#[test]
fn nasdaq_prices_and_times() {
    assert_eq!(nasdaq_price("$178.125"), Some(178.125));
    assert_eq!(nasdaq_price("27,997.14"), Some(27997.14));
    assert_eq!(nasdaq_price("N/A"), None);
    // after the first Sunday of November: EST, UTC-5, so 3:25 PM ET = 20:25 UTC
    assert_eq!(nasdaq_time("Nov 9, 2026 3:25 PM ET"), Some(1794255900));
    // July: EDT, UTC-4, so 9:30 AM ET = 13:30 UTC
    assert_eq!(nasdaq_time("Jul 2, 2026 9:30 AM ET"), Some(1782999000));
    // after-hours wording, 12 PM and 12 AM
    assert_eq!(nasdaq_time("After Hours: Jul 2, 2026 12:05 PM ET"), Some(1782999000 + 9300));
    assert_eq!(nasdaq_time("Jan 5, 2026 12:00 AM ET"), Some(1767589200));
    assert_eq!(nasdaq_time("yesterday"), None);
    assert_eq!(nasdaq_time("Nov 9, 2026 13:25 PM ET"), None);
    assert!(fresh(1794255900, 1794255900 + 300));
    assert!(!fresh(1794255900, 1794255900 + 301));
    assert!(!fresh(1794255900 + 1000, 1794255900));
}

#[test]
fn oracle_price_by_name() {
    let v = json!([{ "universe": [{ "name": "xyz:XYZ100" }, { "name": "xyz:TSLA" }] }, [{ "oraclePx": "28005.0" }, { "oraclePx": "381.01" }]]);
    assert_eq!(oracle_px(&v, "xyz:TSLA"), Some(381.01));
    assert_eq!(oracle_px(&v, "xyz:NVDA"), None);
}

#[test]
fn xyz_positions_read_by_full_name() {
    let st = json!({ "assetPositions": [{ "position": { "coin": "xyz:NVDA", "szi": "-0.112", "liquidationPx": "205.1" } }] });
    assert_eq!(position_of(&st, "xyz:NVDA"), Some(Position { szi: -0.112, liquidation_px: Some(205.1) }));
}
