//! Unhuntable guard (OutLayer WASI P2).
//!
//! Each shard's Hyperliquid account is owned by that shard's own wallet key
//! (OutLayer custody). The guard holds one Hyperliquid AGENT key per shard,
//! made from WASI randomness and sealed; the shard approves it once. Hyperliquid
//! itself refuses withdrawals signed by an agent, so this code can trade and
//! can never move money out.
//!
//! Stops and take-profits arrive encrypted to the guard's sealed X25519 key (the
//! public input hash of an OutLayer call reveals nothing), are stored sealed, and
//! fire only when at least three price sources agree (crypto: of seven exchanges; trade.xyz
//! stocks: of the book, the oracle, Yahoo and Nasdaq, with two or more outside the book). Answers never
//! contain a trigger level or a master address. Every decision is a pure function
//! in lib.rs; this file only reads, writes and sends.

#[cfg(not(target_arch = "wasm32"))]
fn main() {}

#[cfg(target_arch = "wasm32")]
#[used]
#[link_section = "outlayer.manifest"]
static OUTLAYER_MANIFEST: [u8; include_bytes!("../manifest.json").len()] = *include_bytes!("../manifest.json");

#[cfg(target_arch = "wasm32")]
fn main() {
    let input: serde_json::Value = outlayer::env::input_json().ok().flatten().unwrap_or(serde_json::json!({}));
    let out = match guest::run(&input) {
        Ok(v) => v,
        Err(e) => serde_json::json!({ "error": e }),
    };
    outlayer::env::output_string(&out.to_string());
}

#[cfg(target_arch = "wasm32")]
mod http;

#[cfg(target_arch = "wasm32")]
mod guest {
    use crate::http;
    use guardlib::*;
    use outlayer::{signing_keys, storage::sealed, vrf};
    use serde_json::{json, Value};
    use std::time::{Instant, SystemTime, UNIX_EPOCH};

    const KEY: &str = "hl";
    const CALL_AAD: &[u8] = b"unhuntable-call-v1";
    const ENC: &str = "stops";
    const HL: &str = "https://api.hyperliquid.xyz";
    /// Builder fee: address fixed at build time (env UNHUNTABLE_BUILDER), rate fixed in code;
    /// input can only switch it on, and only for opening an order on Hyperliquid's own market
    /// list. Stops, take-profits, defence cuts and closes never carry it, so a fee can never
    /// stand between a stop and its fill. f = 10 → 1 bp (0.01%). No address set → no fee.
    const BUILDER: Option<(&str, u64)> = match option_env!("UNHUNTABLE_BUILDER") {
        Some(a) => Some((a, 10)),
        None => None,
    };

    fn now_ms() -> u64 {
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64
    }

    fn e<T: std::fmt::Display>(x: T) -> String {
        x.to_string()
    }

    /// A 32-byte secret made once from WASI randomness and kept sealed.
    fn secret(name: &str) -> Result<[u8; 32], String> {
        if let Some(r) = sealed::get(ENC, None, name).map_err(e)? {
            return r.plaintext().try_into().map_err(|_| "bad secret".to_string());
        }
        let fresh = wasi::random::random::get_random_bytes(32);
        sealed::set_if_absent(ENC, None, name, &fresh).map_err(e)?;
        // read back: if two runs raced, both use the one that was stored
        let r = sealed::get(ENC, None, name).map_err(e)?.ok_or("secret vanished")?;
        r.plaintext().try_into().map_err(|_| "bad secret".to_string())
    }

    /// Sign with the guard's keystore key (its public identity, used for proofs).
    fn sign(d: [u8; 32]) -> Result<Vec<u8>, String> {
        signing_keys::sign(KEY, None, &d).map_err(e)
    }

    fn shard_of(input: &Value) -> Result<String, String> {
        let s = input["shard"].as_str().ok_or("shard")?.to_string();
        if !valid_shard(&s) {
            return Err("shard must be 1-16 lowercase letters/digits".into());
        }
        Ok(s)
    }

    fn agent_secret(shard: &str) -> Result<[u8; 32], String> {
        secret(&format!("agent:{shard}"))
    }

    fn get_json(url: &str) -> Result<Value, String> {
        let (st, b) = http::request("GET", url, None)?;
        if st != 200 {
            return Err(format!("{url} {st}"));
        }
        serde_json::from_slice(&b).map_err(e)
    }

    fn post_json(url: &str, body: &Value) -> Result<(u16, String), String> {
        let (st, b) = http::request("POST", url, Some(body.to_string().as_bytes()))?;
        Ok((st, String::from_utf8_lossy(&b).to_string()))
    }

    fn num(v: &Value) -> Option<f64> {
        v.as_str().and_then(|s| s.parse().ok()).or_else(|| v.as_f64())
    }

    fn now_s() -> u64 {
        now_ms() / 1000
    }

    /// Hyperliquid's mid for a coin from allMids (with the market's dex).
    fn hl_mid(a: &Asset) -> Result<Option<f64>, String> {
        let body = if a.dex.is_empty() { json!({"type": "allMids"}) } else { json!({"type": "allMids", "dex": a.dex}) };
        post_json(&format!("{HL}/info"), &body).and_then(|(_, b)| serde_json::from_str::<Value>(&b).map_err(e)).map(|v| num(&v[a.coin]))
    }

    /// Price sources for a market as (name, price, outside the order book). Each failure is
    /// reported, not fatal. Crypto: seven exchanges. trade.xyz stocks: the book's mid, the
    /// oracle, Yahoo and Nasdaq, the last two only while fresh.
    fn prices(a: &Asset) -> (Vec<(String, f64, bool)>, Vec<String>, u64) {
        let t = Instant::now();
        let mut ok = Vec::new();
        let mut bad = Vec::new();
        let mut take = |name: &str, outside: bool, r: Result<Option<f64>, String>| match r {
            Ok(Some(p)) => ok.push((name.to_string(), p, outside)),
            Ok(None) => bad.push(format!("{name}: no price")),
            Err(err) => bad.push(format!("{name}: {err}")),
        };
        take("hyperliquid", a.outside.is_none(), hl_mid(a));
        if let Some(o) = &a.outside {
            take("xyz_oracle", true, post_json(&format!("{HL}/info"), &json!({"type": "metaAndAssetCtxs", "dex": a.dex}))
                .and_then(|(_, b)| serde_json::from_str::<Value>(&b).map_err(e))
                .map(|v| oracle_px(&v, a.coin)));
            take("yahoo", true, get_json(&format!("https://query1.finance.yahoo.com/v8/finance/chart/{}?interval=1m&range=1d&includePrePost=true", o.yahoo))
                .map(|v| yahoo_last(&v).filter(|(_, t)| fresh(*t, now_s())).map(|(p, _)| p)));
            if let Some((sym, class)) = o.nasdaq {
                take("nasdaq", true, get_json(&format!("https://api.nasdaq.com/api/quote/{sym}/info?assetclass={class}")).map(|v| {
                    let d = &v["data"]["primaryData"];
                    let t = d["lastTradeTimestamp"].as_str().and_then(nasdaq_time)?;
                    nasdaq_price(d["lastSalePrice"].as_str()?).filter(|_| fresh(t, now_s()))
                }));
            }
            return (ok, bad, t.elapsed().as_millis() as u64);
        }
        let coin = a.coin;
        take("binance", true, get_json(&format!("https://api.binance.com/api/v3/ticker/price?symbol={coin}USDT")).map(|v| num(&v["price"])));
        take("okx", true, get_json(&format!("https://www.okx.com/api/v5/market/ticker?instId={coin}-USDT")).map(|v| num(&v["data"][0]["last"])));
        take("coinbase", true, get_json(&format!("https://api.coinbase.com/v2/prices/{coin}-USD/spot")).map(|v| num(&v["data"]["amount"])));
        take("bybit", true, get_json(&format!("https://api.bybit.com/v5/market/tickers?category=linear&symbol={coin}USDT")).map(|v| num(&v["result"]["list"][0]["lastPrice"])));
        // Kraken and Bitstamp answer from every worker region (Binance 451 / Bybit 403 on some)
        take("kraken", true, get_json(&format!("https://api.kraken.com/0/public/Ticker?pair={coin}USD"))
            .map(|v| v["result"].as_object().and_then(|m| m.values().next()).and_then(|t| num(&t["c"][0]))));
        take("bitstamp", true, get_json(&format!("https://www.bitstamp.net/api/v2/ticker/{}usd/", coin.to_lowercase())).map(|v| num(&v["last"])));
        (ok, bad, t.elapsed().as_millis() as u64)
    }

    /// The agreeing prices under the market's rule.
    fn agreement(a: &Asset, ps: &[(String, f64, bool)]) -> Option<Vec<f64>> {
        if a.outside.is_some() {
            agreed_outside(&ps.iter().map(|p| (p.1, p.2)).collect::<Vec<_>>())
        } else {
            agreed(&ps.iter().map(|p| p.1).collect::<Vec<_>>())
        }
    }

    fn agreed_mid(coin: &str) -> Result<(f64, Vec<f64>, Value), String> {
        let a = asset(coin).ok_or("asset")?;
        let (ps, bad, ms) = prices(a);
        let ag = agreement(a, &ps).ok_or(if a.outside.is_some() {
            format!("fewer than {MIN_AGREE} price sources agree, with at least {MIN_OUTSIDE} outside trade.xyz's order book")
        } else {
            format!("fewer than {MIN_AGREE} price sources agree")
        })?;
        let info = json!({ "sources_ok": ps.len(), "sources_agree": ag.len(), "source_errors": bad, "price_ms": ms });
        Ok((median(&ag), ag, info))
    }

    /// Sign an L1 action with the shard's agent key and send it.
    fn send(shard: &str, action: &V) -> Result<Value, String> {
        let nonce = now_ms();
        let sig = sign_with(&agent_secret(shard)?, &l1_digest(action, nonce))?;
        let body = json!({ "action": to_json(action), "nonce": nonce, "signature": sig_json(&sig), "vaultAddress": null });
        let (st, b) = post_json(&format!("{HL}/exchange"), &body)?;
        let body = serde_json::from_str::<Value>(&b).unwrap_or(Value::String(b));
        Ok(json!({ "http": st, "body": redact_addresses(&body) }))
    }

    fn coin_of(v: &Value) -> Result<String, String> {
        let c = v["coin"].as_str().unwrap_or("ETH");
        Ok(asset(c).ok_or(format!("unsupported coin {c}"))?.coin.to_string())
    }

    fn stop_name(shard: &str, coin: &str) -> String {
        format!("stop:{shard}:{coin}")
    }

    fn hexf(v: &Value, k: &str) -> Result<Vec<u8>, String> {
        hex::decode(v[k].as_str().ok_or(format!("box.{k}"))?).map_err(e)
    }

    fn tp_name(shard: &str, coin: &str) -> String {
        format!("tp:{shard}:{coin}")
    }

    fn defend_name(shard: &str, coin: &str) -> String {
        format!("defend:{shard}:{coin}")
    }

    /// One price fetch: agreeing prices (if at least three agree), their median, and the summary.
    fn price_round(coin: &str) -> (Option<Vec<f64>>, Option<f64>, PriceInfo) {
        let Some(a) = asset(coin) else {
            return (None, None, PriceInfo { source_errors: vec![format!("unsupported coin {coin}")], ..Default::default() });
        };
        let (ps, bad, price_ms) = prices(a);
        let agree = agreement(a, &ps);
        let mid = agree.as_ref().map(|a| median(a));
        let info = PriceInfo { sources_ok: ps.len(), sources_agree: agree.as_ref().map(|a| a.len()), source_errors: bad, price_ms };
        (agree, mid, info)
    }

    /// The shard's registered master account. Never put in an output.
    fn master_of(shard: &str) -> Result<String, String> {
        let r = sealed::get(ENC, None, &format!("master:{shard}")).map_err(e)?.ok_or("shard is not registered")?;
        String::from_utf8(r.into_plaintext()).map_err(e)
    }

    /// clearinghouseState on a market list: "" for Hyperliquid's own, "xyz" for trade.xyz.
    /// Equity now and net deposits ever, summed over shards: perps (main and trade.xyz), spot
    /// USDC, and every USDC sent in or out per Hyperliquid's ledger. pnl = equity - net.
    fn totals(list: &[String]) -> Result<(f64, f64), String> {
        let (mut equity, mut net) = (0f64, 0f64);
        for sh in list {
            let m = String::from_utf8(sealed::get(ENC, None, &format!("master:{sh}")).map_err(e)?.ok_or("master missing")?.into_plaintext()).map_err(e)?;
            let perp: Value = serde_json::from_str(&clearinghouse(&m, "")?.1).map_err(e)?;
            equity += num(&perp["marginSummary"]["accountValue"]).ok_or("perp equity")?;
            let xyz: Value = serde_json::from_str(&clearinghouse(&m, "xyz")?.1).map_err(e)?;
            equity += num(&xyz["marginSummary"]["accountValue"]).unwrap_or(0.0);
            let spot: Value = serde_json::from_str(&post_json(&format!("{HL}/info"), &json!({"type":"spotClearinghouseState","user": m}))?.1).map_err(e)?;
            for b in spot["balances"].as_array().cloned().unwrap_or_default() {
                if b["coin"] == "USDC" {
                    equity += num(&b["total"]).unwrap_or(0.0);
                }
            }
            let led: Value = serde_json::from_str(&post_json(&format!("{HL}/info"), &json!({"type":"userNonFundingLedgerUpdates","user": m,"startTime":0}))?.1).map_err(e)?;
            for u in led.as_array().cloned().unwrap_or_default() {
                let d = &u["delta"];
                let amt = num(&d["amount"]).or_else(|| num(&d["usdc"])).unwrap_or(0.0);
                let fee = num(&d["fee"]).unwrap_or(0.0);
                let from = d["user"].as_str().unwrap_or("").to_lowercase();
                let to = d["destination"].as_str().unwrap_or("").to_lowercase();
                match d["type"].as_str().unwrap_or("") {
                    "send" | "spotTransfer" if to == m && from != m => net += amt,
                    "send" | "spotTransfer" if from == m && to != m => net -= amt + fee,
                    "deposit" => net += amt,
                    "withdraw" => net -= amt + fee,
                    _ => {}
                }
            }
        }
        Ok((equity, net))
    }

    fn clearinghouse(master: &str, dex: &str) -> Result<(u16, String), String> {
        let body = if dex.is_empty() { json!({"type": "clearinghouseState", "user": master}) } else { json!({"type": "clearinghouseState", "user": master, "dex": dex}) };
        post_json(&format!("{HL}/info"), &body)
    }

    fn position(master: &str, coin: &str) -> Result<Option<Position>, String> {
        let (st, b) = clearinghouse(master, asset(coin).ok_or("asset")?.dex)?;
        if st != 200 {
            return Err(format!("clearinghouseState {st}"));
        }
        let v: Value = serde_json::from_str(&b).map_err(e)?;
        Ok(position_of(&v, coin).filter(|p| p.szi != 0.0))
    }

    /// Read a sealed stop or take-profit together with its record (for compare-and-swap).
    fn read_trigger(name: &str) -> Result<(Option<sealed::Sealed>, Option<Stop>), String> {
        let rec = sealed::get(ENC, None, name).map_err(e)?;
        let t = rec.as_ref().and_then(|r| serde_json::from_slice(r.plaintext()).ok());
        Ok((rec, t))
    }

    /// Mark a trigger fired with compare-and-swap. false when another run got there first.
    fn mark_fired(name: &str, rec: &sealed::Sealed, t: &Stop) -> Result<bool, String> {
        let mut f = t.clone();
        f.fired = true;
        Ok(sealed::set_if_equals(ENC, None, name, rec, &serde_json::to_vec(&f).unwrap()).map_err(e)?.0)
    }

    /// Stop and take-profit for one shard at the prices already fetched, then the defence step.
    fn tick_shard(shard: &str, coin: &str, agree: Option<&[f64]>, mid: Option<f64>, dry: bool, defend: bool) -> Result<Value, String> {
        let (stop_rec, stop) = read_trigger(&stop_name(shard, coin))?;
        let (tp_rec, tp) = read_trigger(&tp_name(shard, coin))?;
        let (rnd, _, _) = vrf::random_bytes(&vrf_seed("band", shard, coin, now_ms()))?;
        let d = decide_shard(stop.as_ref(), tp.as_ref(), agree, mid, u01(&rnd[0..8]), u01(&rnd[8..16]));
        let mut done = d.done(dry);
        let mut order = Value::Null;
        let fired_now = |f: Fire| d.fire == f && !dry;
        if !dry && d.fire != Fire::Nothing {
            // at most once: mark fired BEFORE sending
            let (name, rec, t) = match d.fire {
                Fire::Stop => (stop_name(shard, coin), stop_rec.as_ref(), stop.as_ref()),
                _ => (tp_name(shard, coin), tp_rec.as_ref(), tp.as_ref()),
            };
            let (rec, t) = (rec.ok_or("record vanished")?, t.ok_or("record vanished")?);
            if mark_fired(&name, rec, t)? {
                order = send(shard, &close_order(t, mid.ok_or("no mid")?, None).ok_or("asset")?)?;
            } else {
                done = "already_fired_elsewhere";
            }
        }
        let defence = if defend && (dry || d.fire == Fire::Nothing) {
            defence_shard(shard, coin, mid, dry).unwrap_or_else(|err| json!({ "error": err }))
        } else {
            Value::Null
        };
        Ok(shard_report(done, d.band, still_live(stop.as_ref(), fired_now(Fire::Stop)), still_live(tp.as_ref(), fired_now(Fire::TakeProfit)), defence, order))
    }

    /// One defence ladder step for a shard's position in a coin.
    fn defence_shard(shard: &str, coin: &str, mid: Option<f64>, dry: bool) -> Result<Value, String> {
        let master = master_of(shard)?;
        let a = asset(coin).ok_or("asset")?;
        let name = defend_name(shard, coin);
        let rec = sealed::get(ENC, None, &name).map_err(e)?;
        let rung: u8 = rec.as_ref().and_then(|r| std::str::from_utf8(r.plaintext()).ok()?.parse().ok()).unwrap_or(0).min(3);
        let pos = position(&master, coin)?;
        let (step, distance) = match (pos.as_ref(), mid) {
            // no position: the ladder starts again from 0
            (None, _) => (DefenceAction { kind: DefenceKind::Nothing, rung: 0, size: 0.0 }, None),
            (Some(p), Some(m)) => match p.liquidation_px.and_then(|l| liq_distance(m, l)) {
                Some(d) => (defence_step(d, rung, p.szi.abs(), m, a.sz_decimals), Some(d)),
                None => (DefenceAction { kind: DefenceKind::Nothing, rung, size: 0.0 }, None),
            },
            // no price agreement: no action
            (Some(_), None) => (DefenceAction { kind: DefenceKind::Nothing, rung, size: 0.0 }, None),
        };
        if dry {
            return Ok(defend_report(&step, distance, None));
        }
        if step.rung != rung {
            let bytes = step.rung.to_string();
            let won = match &rec {
                Some(r) => sealed::set_if_equals(ENC, None, &name, r, bytes.as_bytes()).map_err(e)?.0,
                None => sealed::set_if_absent(ENC, None, &name, bytes.as_bytes()).map_err(e)?,
            };
            if !won {
                // another run moved the ladder first; it sends the order
                return Ok(defend_report(&DefenceAction { kind: DefenceKind::Nothing, rung, size: 0.0 }, distance, None));
            }
        }
        let hl = match (step.kind, pos.as_ref(), mid) {
            (DefenceKind::Nothing, _, _) => None,
            (_, Some(p), Some(m)) => Some(send(shard, &reduce_order(a, p.szi < 0.0, m, step.size, None))?),
            _ => None,
        };
        Ok(defend_report(&step, distance, hl))
    }

    pub fn run(outer: &Value) -> Result<Value, String> {
        let t0 = Instant::now();
        // Every op except addr/box_pub arrives as ONE sealed box: {"box":{epk,nonce,ct}}, aad "unhuntable-call-v1".
        // The op name, shard id and all fields are inside, plus the client's random salt, so the
        // public input_hash on OutLayer's call record reveals nothing.
        let opened;
        let boxed = outer.get("box").is_some() && outer.get("op").is_none();
        let input: &Value = if boxed {
            let b = &outer["box"];
            let pt = box_open(&secret("box")?, &hexf(b, "epk")?, &hexf(b, "nonce")?, &hexf(b, "ct")?, CALL_AAD)?;
            opened = serde_json::from_slice::<Value>(&pt).map_err(|_| "box content is not JSON")?;
            check_outer_shard(outer, &opened)?;
            &opened
        } else {
            outer
        };
        let op = input["op"].as_str().unwrap_or("addr");
        if !boxed && op != "addr" && op != "box_pub" {
            return Err(format!("op {op} must be sent as a sealed box"));
        }
        let builder = if input["builder"].as_bool().unwrap_or(false) { BUILDER } else { None };
        let mut out = match op {
            "addr" => {
                let pk = signing_keys::public_key(KEY, None).map_err(e)?;
                json!({ "hl_address": evm_address(&pk), "vrf_public_key": vrf::public_key().ok(), "builder": BUILDER.map(|b| b.0) })
            }

            "box_pub" => json!({ "box_pub": hex::encode(box_public(&secret("box")?)) }),

            "agent" => {
                let shard = shard_of(input)?;
                json!({ "shard": shard, "agent": address_of(&agent_secret(&shard)?)? })
            }

            "leverage" => {
                let shard = shard_of(input)?;
                let coin = coin_of(input)?;
                let lev = input["leverage"].as_u64().filter(|l| (1..=MAX_LEVERAGE).contains(l)).ok_or("leverage 1-10")?;
                json!({ "hl": send(&shard, &update_leverage_action(asset(&coin).unwrap(), lev))? })
            }

            "open" => {
                let shard = shard_of(input)?;
                let coin = coin_of(input)?;
                let is_buy = match input["side"].as_str() {
                    Some("long") => true,
                    Some("short") => false,
                    _ => return Err("side must be long or short".into()),
                };
                let size = input["size"].as_f64().filter(|x| *x > 0.0).ok_or("size")?;
                let (mid, _, info) = agreed_mid(&coin)?;
                check_open_cap(size, mid)?;
                let a = asset(&coin).unwrap();
                let order = open_order(a, is_buy, mid, size, if a.dex.is_empty() { builder } else { None });
                json!({ "mid": mid, "prices": info, "action": to_json(&order), "hl": send(&shard, &order)? })
            }

            // The stop travels inside the one sealed call (aad "unhuntable-call-v1") as input["stop"].
            // With jitter_bps the stored trigger moves by a VRF-drawn amount within ±jitter_bps.
            "seal" => {
                let shard = shard_of(input)?;
                let mut st = check_trigger(&input["stop"], "stop")?;
                let bps = check_jitter_bps(&input["jitter_bps"])?;
                if bps > 0 {
                    let (rnd, _, _) = vrf::random_bytes(&vrf_seed("jitter", &shard, &st.coin, now_ms()))?;
                    st.trigger = jitter_trigger(st.trigger, bps, u01(&rnd[0..8]));
                }
                sealed::set(ENC, None, &stop_name(&shard, &st.coin), &serde_json::to_vec(&st).unwrap()).map_err(e)?;
                json!({ "sealed": true })
            }

            "seal_tp" => {
                let shard = shard_of(input)?;
                let tp = check_trigger(&input["tp"], "take-profit")?;
                sealed::set(ENC, None, &tp_name(&shard, &tp.coin), &serde_json::to_vec(&tp).unwrap()).map_err(e)?;
                json!({ "sealed": true })
            }

            "tick" => {
                let shard = shard_of(input)?;
                let coin = coin_of(input)?;
                let dry = input["dry"].as_bool().unwrap_or(false);
                let defend = input["defend"].as_bool().unwrap_or(false);
                let (agree, mid, info) = price_round(&coin);
                tick_report(tick_shard(&shard, &coin, agree.as_deref(), mid, dry, defend)?, &info)
            }

            // One price fetch for a coin, then every listed shard's stop, take-profit and defence.
            "tick_coin" => {
                let shards = check_shards(&input["shards"])?;
                let coin = coin_of(input)?;
                let dry = input["dry"].as_bool().unwrap_or(false);
                let defend = input["defend"].as_bool().unwrap_or(false);
                let (agree, mid, info) = price_round(&coin);
                let reports = shards
                    .iter()
                    .map(|sh| {
                        let r = tick_shard(sh, &coin, agree.as_deref(), mid, dry, defend).unwrap_or_else(|err| json!({ "error": err }));
                        (sh.clone(), r)
                    })
                    .collect();
                tick_coin_report(reports, &info)
            }

            "defend" => {
                let shard = shard_of(input)?;
                let coin = coin_of(input)?;
                let dry = input["dry"].as_bool().unwrap_or(false);
                let (_, mid, info) = price_round(&coin);
                tick_report(defence_shard(&shard, &coin, mid, dry)?, &info)
            }

            // Close the shard's whole position in a coin, read from Hyperliquid.
            "close" => {
                let shard = shard_of(input)?;
                let coin = coin_of(input)?;
                let master = master_of(&shard)?;
                match position(&master, &coin)? {
                    None => json!({ "done": "nothing_open" }),
                    Some(p) => {
                        let (_, mid, info) = price_round(&coin);
                        let a = asset(&coin).unwrap();
                        match mid.and_then(|m| close_position_order(a, p.szi, m)) {
                            None if mid.is_none() => tick_report(json!({ "done": "no_agreement" }), &info),
                            None => json!({ "done": "nothing_open" }),
                            Some(order) => tick_report(close_report(round_sz(p.szi.abs(), a.sz_decimals), send(&shard, &order)?), &info),
                        }
                    }
                }
            }

            // Verifiable random draw for a plan: anyone can check it against vrf_public_key from addr.
            "vrf" => {
                let label = input["label"].as_str().filter(|l| valid_vrf_label(l)).ok_or("label must be 1-64 of a-z, 0-9 and -")?;
                let r = vrf::random(&format!("plan-{label}"))?;
                json!({ "output_hex": r.output_hex, "proof": r.signature_hex, "alpha": r.alpha })
            }

            // Records which Hyperliquid master account a shard trades for (sealed; never echoed).
            // With "owner", the shard is counted in that trader's track record ("record") from now on.
            // A tag is taken only when the shard is first registered, so no piece can be added to or
            // left out of a record after its trades are known.
            "register" => {
                let shard = shard_of(input)?;
                let m = input["master"].as_str().ok_or("master")?.to_lowercase();
                if m.len() != 42 || !m.starts_with("0x") || hex::decode(&m[2..]).is_err() {
                    return Err("master must be a 0x address".into());
                }
                let owner = match input.get("owner") {
                    None | Some(Value::Null) => None,
                    Some(v) => Some(v.as_str().filter(|t| valid_trader_tag(t)).ok_or("owner must be 64 lowercase hex characters")?.to_string()),
                };
                let known: Vec<String> = sealed::get(ENC, None, "shards").map_err(e)?
                    .and_then(|r| serde_json::from_slice(r.plaintext()).ok()).unwrap_or_default();
                let had = sealed::get(ENC, None, &format!("owner:{shard}")).map_err(e)?
                    .map(|r| String::from_utf8_lossy(r.plaintext()).to_string());
                if let (Some(o), Some(h)) = (&owner, &had) {
                    if h != o {
                        return Err("shard belongs to another trader".into());
                    }
                }
                // A shard first registered without a tag stays untagged: nothing joins a record late.
                let tag_now = owner.is_some() && had.is_none() && !known.contains(&shard);
                sealed::set(ENC, None, &format!("master:{shard}"), m.as_bytes()).map_err(e)?;
                if let (true, Some(o)) = (tag_now, &owner) {
                    sealed::set(ENC, None, &format!("owner:{shard}"), o.as_bytes()).map_err(e)?;
                    let key = format!("trader:{o}");
                    loop {
                        let cur = sealed::get(ENC, None, &key).map_err(e)?;
                        let mut list: Vec<String> = cur.as_ref().and_then(|r| serde_json::from_slice(r.plaintext()).ok()).unwrap_or_default();
                        if list.contains(&shard) {
                            break;
                        }
                        list.push(shard.clone());
                        let bytes = serde_json::to_vec(&list).unwrap();
                        let won = match &cur {
                            Some(c) => sealed::set_if_equals(ENC, None, &key, c, &bytes).map_err(e)?.0,
                            None => sealed::set_if_absent(ENC, None, &key, &bytes).map_err(e)?,
                        };
                        if won {
                            break;
                        }
                    }
                }
                loop {
                    let cur = sealed::get(ENC, None, "shards").map_err(e)?;
                    let mut list: Vec<String> = cur.as_ref().and_then(|r| serde_json::from_slice(r.plaintext()).ok()).unwrap_or_default();
                    if list.contains(&shard) {
                        break;
                    }
                    list.push(shard.clone());
                    let bytes = serde_json::to_vec(&list).unwrap();
                    let won = match &cur {
                        Some(c) => sealed::set_if_equals(ENC, None, "shards", c, &bytes).map_err(e)?.0,
                        None => sealed::set_if_absent(ENC, None, "shards", &bytes).map_err(e)?,
                    };
                    if won {
                        break;
                    }
                }
                json!({ "registered": true, "trader": if tag_now { owner.clone() } else { had.clone() } })
            }

            // Track-record proof: totals across all registered shards, signed by the guard's keystore
            // key as an EAS off-chain attestation (Base, EAS 1.0.1). No address leaves the guard.
            "proof" => {
                let list: Vec<String> = sealed::get(ENC, None, "shards").map_err(e)?
                    .and_then(|r| serde_json::from_slice(r.plaintext()).ok()).unwrap_or_default();
                let (equity, net) = totals(&list)?;
                let micro = |x: f64| (x * 1e6).round() as i64;
                let p = Proof {
                    as_of: now_ms() / 1000,
                    shards: list.len() as u32,
                    equity_micro: micro(equity),
                    net_deposits_micro: micro(net),
                    pnl_micro: micro(equity - net),
                    call: std::env::var("OUTLAYER_CALL_ID").unwrap_or_default(),
                };
                let data = eas_data(&p);
                let salt: [u8; 32] = wasi::random::random::get_random_bytes(32).try_into().unwrap();
                let time = p.as_of;
                let sig = sign(eas_digest(time, &data, &salt))?;
                let signer = evm_address(&signing_keys::public_key(KEY, None).map_err(e)?);
                json!({
                    "eas": { "chainId": EAS_CHAIN_ID, "contract": EAS_CONTRACT, "version": EAS_VERSION, "schema": EAS_SCHEMA,
                             "schemaUid": format!("0x{}", hex::encode(eas_schema_uid())), "time": time,
                             "data": format!("0x{}", hex::encode(&data)), "salt": format!("0x{}", hex::encode(salt)),
                             "signature": sig_json(&sig), "signer": signer },
                    "totals": { "shards": p.shards, "equity_usd": equity, "net_deposits_usd": net, "pnl_usd": equity - net, "outlayer_call": p.call }
                })
            }

            // One trader's track record: every shard registered under the tag, summed and signed
            // like "proof". No address leaves the guard.
            "record" => {
                let tag = input["trader"].as_str().filter(|t| valid_trader_tag(t)).ok_or("trader must be 64 lowercase hex characters")?.to_string();
                let list: Vec<String> = sealed::get(ENC, None, &format!("trader:{tag}")).map_err(e)?
                    .and_then(|r| serde_json::from_slice(r.plaintext()).ok()).unwrap_or_default();
                let (equity, net) = totals(&list)?;
                let micro = |x: f64| (x * 1e6).round() as i64;
                let mut trader = [0u8; 32];
                trader.copy_from_slice(&hex::decode(&tag).map_err(e)?);
                let p = TraderProof {
                    as_of: now_ms() / 1000,
                    trader,
                    shards: list.len() as u32,
                    equity_micro: micro(equity),
                    net_deposits_micro: micro(net),
                    pnl_micro: micro(equity - net),
                    call: std::env::var("OUTLAYER_CALL_ID").unwrap_or_default(),
                };
                let data = trader_eas_data(&p);
                let salt: [u8; 32] = wasi::random::random::get_random_bytes(32).try_into().unwrap();
                let time = p.as_of;
                let sig = sign(eas_digest_for(&trader_schema_uid(), time, &data, &salt))?;
                let signer = evm_address(&signing_keys::public_key(KEY, None).map_err(e)?);
                json!({
                    "eas": { "chainId": EAS_CHAIN_ID, "contract": EAS_CONTRACT, "version": EAS_VERSION, "schema": TRADER_SCHEMA,
                             "schemaUid": format!("0x{}", hex::encode(trader_schema_uid())), "time": time,
                             "data": format!("0x{}", hex::encode(&data)), "salt": format!("0x{}", hex::encode(salt)),
                             "signature": sig_json(&sig), "signer": signer },
                    "totals": { "trader": tag, "shards": p.shards, "equity_usd": equity, "net_deposits_usd": net, "pnl_usd": equity - net, "outlayer_call": p.call }
                })
            }

            // Safety proof: the shard's AGENT signs a 1 USDC USD send to the guard's own
            // keystore address (fixed here). Hyperliquid must refuse it: agents cannot move funds.
            "withdraw_probe" => {
                let shard = shard_of(input)?;
                let dest = evm_address(&signing_keys::public_key(KEY, None).map_err(e)?);
                let time = now_ms();
                let sig = sign_with(&agent_secret(&shard)?, &usd_send_digest(&dest, "1", time))?;
                let body = json!({
                    "action": { "type": "usdSend", "hyperliquidChain": "Mainnet", "signatureChainId": "0x66eee",
                                "destination": dest, "amount": "1", "time": time },
                    "nonce": time, "signature": sig_json(&sig)
                });
                let (st, b) = post_json(&format!("{HL}/exchange"), &body)?;
                json!({ "agent": address_of(&agent_secret(&shard)?)?, "http": st, "body": b })
            }

            _ => return Err(format!("unknown op {op}")),
        };
        out["guard_ms"] = json!(t0.elapsed().as_millis() as u64);
        Ok(out)
    }
}
