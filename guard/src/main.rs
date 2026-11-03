//! Unhuntable guard (OutLayer WASI P2).
//!
//! Each shard's Hyperliquid account is owned by that shard's own wallet key
//! (OutLayer custody). The guard holds one Hyperliquid AGENT key per shard,
//! made from WASI randomness and sealed; the shard approves it once. Hyperliquid
//! itself refuses withdrawals signed by an agent, so this code can trade and
//! can never move money out.
//!
//! Stops arrive encrypted to the guard's sealed X25519 key (the public input
//! hash of an OutLayer call reveals nothing), are stored sealed, and fire only
//! when at least three of seven price sources agree. Answers never contain a
//! stop level.

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
    /// input can only switch it on. f = 10 → 1 bp (0.01%). No address set → no builder fee.
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

    /// Seven public sources. Each failure is reported, not fatal.
    fn prices(coin: &str) -> (Vec<(String, f64)>, Vec<String>, u64) {
        let t = Instant::now();
        let mut ok = Vec::new();
        let mut bad = Vec::new();
        let mut take = |name: &str, r: Result<Option<f64>, String>| match r {
            Ok(Some(p)) => ok.push((name.to_string(), p)),
            Ok(None) => bad.push(format!("{name}: no price")),
            Err(err) => bad.push(format!("{name}: {err}")),
        };
        take("hyperliquid", post_json(&format!("{HL}/info"), &json!({"type": "allMids"}))
            .and_then(|(_, b)| serde_json::from_str::<Value>(&b).map_err(e))
            .map(|v| num(&v[coin])));
        take("binance", get_json(&format!("https://api.binance.com/api/v3/ticker/price?symbol={coin}USDT")).map(|v| num(&v["price"])));
        take("okx", get_json(&format!("https://www.okx.com/api/v5/market/ticker?instId={coin}-USDT")).map(|v| num(&v["data"][0]["last"])));
        take("coinbase", get_json(&format!("https://api.coinbase.com/v2/prices/{coin}-USD/spot")).map(|v| num(&v["data"]["amount"])));
        take("bybit", get_json(&format!("https://api.bybit.com/v5/market/tickers?category=linear&symbol={coin}USDT")).map(|v| num(&v["result"]["list"][0]["lastPrice"])));
        // Kraken and Bitstamp answer from every worker region (Binance 451 / Bybit 403 on some)
        take("kraken", get_json(&format!("https://api.kraken.com/0/public/Ticker?pair={coin}USD"))
            .map(|v| v["result"].as_object().and_then(|m| m.values().next()).and_then(|t| num(&t["c"][0]))));
        take("bitstamp", get_json(&format!("https://www.bitstamp.net/api/v2/ticker/{}usd/", coin.to_lowercase())).map(|v| num(&v["last"])));
        (ok, bad, t.elapsed().as_millis() as u64)
    }

    fn agreed_mid(coin: &str) -> Result<(f64, Vec<f64>, Value), String> {
        let (ps, bad, ms) = prices(coin);
        let vals: Vec<f64> = ps.iter().map(|p| p.1).collect();
        let a = agreed(&vals).ok_or(format!("fewer than {MIN_AGREE} price sources agree"))?;
        let info = json!({ "sources_ok": ps.len(), "sources_agree": a.len(), "source_errors": bad, "price_ms": ms });
        Ok((median(&a), a, info))
    }

    /// Sign an L1 action with the shard's agent key and send it.
    fn send(shard: &str, action: &V) -> Result<Value, String> {
        let nonce = now_ms();
        let sig = sign_with(&agent_secret(shard)?, &l1_digest(action, nonce))?;
        let body = json!({ "action": to_json(action), "nonce": nonce, "signature": sig_json(&sig), "vaultAddress": null });
        let (st, b) = post_json(&format!("{HL}/exchange"), &body)?;
        Ok(json!({ "http": st, "body": serde_json::from_str::<Value>(&b).unwrap_or(Value::String(b)) }))
    }

    fn coin_of(v: &Value) -> Result<String, String> {
        let c = v["coin"].as_str().unwrap_or("ETH").to_uppercase();
        asset(&c).ok_or(format!("unsupported coin {c}"))?;
        Ok(c)
    }

    fn stop_name(shard: &str, coin: &str) -> String {
        format!("stop:{shard}:{coin}")
    }

    fn hexf(v: &Value, k: &str) -> Result<Vec<u8>, String> {
        hex::decode(v[k].as_str().ok_or(format!("box.{k}"))?).map_err(e)
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
                json!({ "hl_address": evm_address(&pk), "vrf_public_key": vrf::public_key().ok() })
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
                if size * mid > MAX_NOTIONAL_USD {
                    return Err(format!("notional over the {MAX_NOTIONAL_USD} USD cap"));
                }
                let order = open_order(asset(&coin).unwrap(), is_buy, mid, size, builder);
                json!({ "mid": mid, "prices": info, "action": to_json(&order), "hl": send(&shard, &order)? })
            }

            // The stop travels inside the one sealed call (aad "unhuntable-call-v1") as input["stop"].
            "seal" => {
                let shard = shard_of(input)?;
                let mut st: Stop = serde_json::from_value(input["stop"].clone()).map_err(|_| "stop missing or malformed")?;
                st.coin = st.coin.to_uppercase();
                asset(&st.coin).ok_or("unsupported coin")?;
                if (st.side != "long" && st.side != "short") || !(st.trigger > 0.0) || !(st.size > 0.0) {
                    return Err("bad stop".into());
                }
                st.fired = false;
                sealed::set(ENC, None, &stop_name(&shard, &st.coin), &serde_json::to_vec(&st).unwrap()).map_err(e)?;
                json!({ "sealed": true })
            }

            "tick" => {
                let shard = shard_of(input)?;
                let coin = coin_of(input)?;
                let dry = input["dry"].as_bool().unwrap_or(false);
                let (ps, bad, price_ms) = prices(&coin);
                let vals: Vec<f64> = ps.iter().map(|p| p.1).collect();
                let agree = agreed(&vals);
                let name = stop_name(&shard, &coin);
                let rec = sealed::get(ENC, None, &name).map_err(e)?;
                let stop: Option<Stop> = rec.as_ref().and_then(|r| serde_json::from_slice(r.plaintext()).ok());
                let (rnd, _, _) = vrf::random_bytes(&format!("band-{shard}-{coin}-{}", now_ms()))?;
                let mid = agree.as_ref().map(|a| median(a));
                let mut order = Value::Null;
                let mut done = if agree.is_none() { "no_agreement" } else { "watch" };
                if let (Some(a), Some(st)) = (agree.as_ref(), stop.as_ref()) {
                    if should_fire(st, a) {
                        done = if dry { "would_fire" } else { "fired" };
                        if !dry {
                            // at most once: mark fired BEFORE sending
                            let mut f = st.clone();
                            f.fired = true;
                            let (won, _) = sealed::set_if_equals(ENC, None, &name, rec.as_ref().unwrap(), &serde_json::to_vec(&f).unwrap()).map_err(e)?;
                            if !won {
                                return Ok(json!({ "done": "already_fired_elsewhere" }));
                            }
                            let close = close_order(st, mid.unwrap(), builder).ok_or("asset")?;
                            order = send(&shard, &close)?;
                        }
                    }
                }
                let band = mid.map(|m| {
                    let (lo, hi) = wake_band(m, stop.as_ref(), u01(&rnd[0..8]), u01(&rnd[8..16]));
                    json!([lo, hi])
                });
                json!({
                    "done": done,
                    "band": band,
                    "has_stop": stop.as_ref().map(|s| !s.fired && done != "fired"),
                    "sources_ok": ps.len(),
                    "sources_agree": agree.as_ref().map(|a| a.len()),
                    "source_errors": bad,
                    "price_ms": price_ms,
                    "order": order,
                })
            }

            // Records which Hyperliquid master account a shard trades for (sealed; never echoed).
            "register" => {
                let shard = shard_of(input)?;
                let m = input["master"].as_str().ok_or("master")?.to_lowercase();
                if m.len() != 42 || !m.starts_with("0x") || hex::decode(&m[2..]).is_err() {
                    return Err("master must be a 0x address".into());
                }
                sealed::set(ENC, None, &format!("master:{shard}"), m.as_bytes()).map_err(e)?;
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
                json!({ "registered": true })
            }

            // Track-record proof: totals across all registered shards, signed by the guard's keystore
            // key as an EAS off-chain attestation (Base, EAS 1.0.1). No address leaves the guard.
            "proof" => {
                let list: Vec<String> = sealed::get(ENC, None, "shards").map_err(e)?
                    .and_then(|r| serde_json::from_slice(r.plaintext()).ok()).unwrap_or_default();
                let (mut equity, mut net) = (0f64, 0f64);
                for sh in &list {
                    let m = String::from_utf8(sealed::get(ENC, None, &format!("master:{sh}")).map_err(e)?.ok_or("master missing")?.into_plaintext()).map_err(e)?;
                    let perp: Value = serde_json::from_str(&post_json(&format!("{HL}/info"), &json!({"type":"clearinghouseState","user": m}))?.1).map_err(e)?;
                    equity += num(&perp["marginSummary"]["accountValue"]).ok_or("perp equity")?;
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

            // Safety proof: the shard's AGENT signs a 1 USDC usdSend to the guard's own
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
