//! Pure logic of the guard: Hyperliquid action encoding and signing digests,
//! price agreement, stop, take-profit and defence decisions, wake bands and
//! the reports the guard answers with. No host calls here, so
//! every rule is tested natively (`cargo test`) against the reference SDK.

use sha3::{Digest, Keccak256};

pub fn keccak(data: &[u8]) -> [u8; 32] {
    let mut h = Keccak256::new();
    h.update(data);
    h.finalize().into()
}

// ---------------------------------------------------------------- msgpack

/// Ordered value, so the msgpack bytes match the reference SDK's dict order.
#[derive(Clone, Debug)]
pub enum V {
    S(String),
    U(u64),
    B(bool),
    A(Vec<V>),
    M(Vec<(String, V)>),
}

pub fn s(x: &str) -> V {
    V::S(x.to_string())
}

pub fn pack(v: &V, out: &mut Vec<u8>) {
    match v {
        V::S(x) => rmp::encode::write_str(out, x).unwrap(),
        V::U(x) => {
            rmp::encode::write_uint(out, *x).unwrap();
        }
        V::B(x) => rmp::encode::write_bool(out, *x).unwrap(),
        V::A(xs) => {
            rmp::encode::write_array_len(out, xs.len() as u32).unwrap();
            for x in xs {
                pack(x, out);
            }
        }
        V::M(kv) => {
            rmp::encode::write_map_len(out, kv.len() as u32).unwrap();
            for (k, x) in kv {
                rmp::encode::write_str(out, k).unwrap();
                pack(x, out);
            }
        }
    }
}

pub fn to_json(v: &V) -> serde_json::Value {
    match v {
        V::S(x) => serde_json::Value::String(x.clone()),
        V::U(x) => serde_json::json!(x),
        V::B(x) => serde_json::Value::Bool(*x),
        V::A(xs) => serde_json::Value::Array(xs.iter().map(to_json).collect()),
        V::M(kv) => {
            let mut m = serde_json::Map::new();
            for (k, x) in kv {
                m.insert(k.clone(), to_json(x));
            }
            serde_json::Value::Object(m)
        }
    }
}

// ---------------------------------------------------------------- numbers

/// Hyperliquid `float_to_wire`: 8 decimals, trailing zeros stripped.
pub fn float_to_wire(x: f64) -> String {
    let mut r = format!("{:.8}", x);
    if r.contains('.') {
        while r.ends_with('0') {
            r.pop();
        }
        if r.ends_with('.') {
            r.pop();
        }
    }
    if r == "-0" {
        r = "0".into();
    }
    r
}

/// Perp price rule: at most 5 significant figures and at most
/// `6 - sz_decimals` decimals; integer prices are always valid.
pub fn round_px(px: f64, sz_decimals: u32) -> f64 {
    if px >= 100_000.0 {
        return px.round(); // integer prices are always valid
    }
    let sig: f64 = format!("{:.4e}", px).parse().unwrap();
    let p = 10f64.powi(6 - sz_decimals as i32);
    (sig * p).round() / p
}

/// Size rounded down to sz_decimals. The small nudge keeps an exact size such as
/// 0.0051 from flooring to 0.005 through float noise.
pub fn round_sz(sz: f64, sz_decimals: u32) -> f64 {
    let p = 10f64.powi(sz_decimals as i32);
    (sz * p + 1e-7).floor() / p
}

// ---------------------------------------------------------------- actions

pub struct Asset {
    pub coin: &'static str,
    pub index: u64,
    pub sz_decimals: u32,
}

/// Perp universe indexes, checked against Hyperliquid /info meta.
pub const ASSETS: &[Asset] = &[
    Asset { coin: "BTC", index: 0, sz_decimals: 5 },
    Asset { coin: "ETH", index: 1, sz_decimals: 4 },
    Asset { coin: "SOL", index: 5, sz_decimals: 2 },
];

pub fn asset(coin: &str) -> Option<&'static Asset> {
    ASSETS.iter().find(|a| a.coin == coin)
}

/// One reduce-only IOC order. The guard composes every field itself; no
/// caller bytes are ever signed.
pub fn order_action(a: &Asset, is_buy: bool, px: f64, sz: f64, builder: Option<(&str, u64)>) -> V {
    let order = V::M(vec![
        ("a".into(), V::U(a.index)),
        ("b".into(), V::B(is_buy)),
        ("p".into(), V::S(float_to_wire(round_px(px, a.sz_decimals)))),
        ("s".into(), V::S(float_to_wire(round_sz(sz, a.sz_decimals)))),
        ("r".into(), V::B(true)),
        ("t".into(), V::M(vec![("limit".into(), V::M(vec![("tif".into(), s("Ioc"))]))])),
    ]);
    let mut kv = vec![
        ("type".into(), s("order")),
        ("orders".into(), V::A(vec![order])),
        ("grouping".into(), s("na")),
    ];
    if let Some((b, f)) = builder {
        kv.push(("builder".into(), V::M(vec![("b".into(), V::S(b.to_lowercase())), ("f".into(), V::U(f))])));
    }
    V::M(kv)
}

pub fn action_hash(action: &V, nonce: u64) -> [u8; 32] {
    let mut d = Vec::new();
    pack(action, &mut d);
    d.extend_from_slice(&nonce.to_be_bytes());
    d.push(0); // no vault
    keccak(&d)
}

fn u256(x: u64) -> [u8; 32] {
    let mut o = [0u8; 32];
    o[24..].copy_from_slice(&x.to_be_bytes());
    o
}

fn domain_sep(name: &str, chain_id: u64) -> [u8; 32] {
    let th = keccak(b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    let mut d = Vec::new();
    d.extend_from_slice(&th);
    d.extend_from_slice(&keccak(name.as_bytes()));
    d.extend_from_slice(&keccak(b"1"));
    d.extend_from_slice(&u256(chain_id));
    d.extend_from_slice(&[0u8; 32]);
    keccak(&d)
}

fn eip712(domain: [u8; 32], struct_hash: [u8; 32]) -> [u8; 32] {
    let mut d = vec![0x19, 0x01];
    d.extend_from_slice(&domain);
    d.extend_from_slice(&struct_hash);
    keccak(&d)
}

/// Digest the key signs for an L1 action (orders), mainnet source "a".
pub fn l1_digest(action: &V, nonce: u64) -> [u8; 32] {
    let th = keccak(b"Agent(string source,bytes32 connectionId)");
    let mut d = Vec::new();
    d.extend_from_slice(&th);
    d.extend_from_slice(&keccak(b"a"));
    d.extend_from_slice(&action_hash(action, nonce));
    eip712(domain_sep("Exchange", 1337), keccak(&d))
}

pub const SIG_CHAIN: u64 = 0x66eee;

/// Digest for approveBuilderFee (user-signed action), mainnet.
pub fn builder_fee_digest(max_fee_rate: &str, builder: &str, nonce: u64) -> [u8; 32] {
    let th = keccak(b"HyperliquidTransaction:ApproveBuilderFee(string hyperliquidChain,string maxFeeRate,address builder,uint64 nonce)");
    let mut addr = [0u8; 32];
    addr[12..].copy_from_slice(&hex::decode(builder.trim_start_matches("0x")).unwrap());
    let mut d = Vec::new();
    d.extend_from_slice(&th);
    d.extend_from_slice(&keccak(b"Mainnet"));
    d.extend_from_slice(&keccak(max_fee_rate.as_bytes()));
    d.extend_from_slice(&addr);
    d.extend_from_slice(&u256(nonce));
    eip712(domain_sep("HyperliquidSignTransaction", SIG_CHAIN), keccak(&d))
}

/// 65-byte r‖s‖v (v = 0/1) → Hyperliquid's {r, s, v} with v + 27.
pub fn sig_json(sig: &[u8]) -> serde_json::Value {
    serde_json::json!({
        "r": format!("0x{}", hex::encode(&sig[0..32])),
        "s": format!("0x{}", hex::encode(&sig[32..64])),
        "v": sig[64] as u64 + 27,
    })
}

/// EVM address from a 64-byte x‖y public key.
pub fn evm_address(pk64: &[u8]) -> String {
    format!("0x{}", hex::encode(&keccak(pk64)[12..]))
}

// ---------------------------------------------------------------- prices

pub const MAX_SPREAD: f64 = 0.005; // a source counts only within 0.5% of the median
pub const MIN_AGREE: usize = 3;

pub fn median(xs: &[f64]) -> f64 {
    let mut v = xs.to_vec();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = v.len();
    if n % 2 == 1 { v[n / 2] } else { (v[n / 2 - 1] + v[n / 2]) / 2.0 }
}

/// Sources that agree with the median. None if fewer than MIN_AGREE agree.
pub fn agreed(prices: &[f64]) -> Option<Vec<f64>> {
    let ok: Vec<f64> = prices.iter().cloned().filter(|p| p.is_finite() && *p > 0.0).collect();
    if ok.len() < MIN_AGREE {
        return None;
    }
    let m = median(&ok);
    let a: Vec<f64> = ok.into_iter().filter(|p| ((p - m) / m).abs() <= MAX_SPREAD).collect();
    if a.len() >= MIN_AGREE { Some(a) } else { None }
}

// ---------------------------------------------------------------- stops

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct Stop {
    pub coin: String,
    /// side of the POSITION: "long" stop fires when price falls to trigger
    pub side: String,
    pub trigger: f64,
    pub size: f64,
    #[serde(default)]
    pub fired: bool,
}

/// Fires only when at least MIN_AGREE agreeing sources are ALL past the
/// trigger, so one bad (or bribed) feed can never fire a stop.
pub fn should_fire(stop: &Stop, agreeing: &[f64]) -> bool {
    if stop.fired || agreeing.len() < MIN_AGREE {
        return false;
    }
    match stop.side.as_str() {
        "long" => agreeing.iter().all(|p| *p <= stop.trigger),
        "short" => agreeing.iter().all(|p| *p >= stop.trigger),
        _ => false,
    }
}

/// A take-profit has the same fields as a stop. side is the side of the POSITION:
/// a long take-profit fires when the price rises to trigger, a short one when it falls.
pub type TakeProfit = Stop;

/// Fires only when at least MIN_AGREE agreeing sources are ALL past the trigger
/// in the profit direction, and never twice.
pub fn should_take_profit(tp: &TakeProfit, agreeing: &[f64]) -> bool {
    if tp.fired || agreeing.len() < MIN_AGREE {
        return false;
    }
    match tp.side.as_str() {
        "long" => agreeing.iter().all(|p| *p >= tp.trigger),
        "short" => agreeing.iter().all(|p| *p <= tp.trigger),
        _ => false,
    }
}

/// Wake band: a price range with no live stop or take-profit inside, padded by two
/// VRF draws (u1, u2 in [0,1)) so its edges never point at a trigger.
/// Returns (low, high). With no trigger: ±(0.5%..2.5%). A trigger below the price
/// pulls the low edge to a random 25–75% of the way towards it (u1), one above
/// pulls the high edge the same way (u2).
pub fn wake_band(price: f64, stop: Option<&Stop>, tp: Option<&TakeProfit>, u1: f64, u2: f64) -> (f64, f64) {
    let mut lo = price * (1.0 - (0.005 + 0.02 * u1));
    let mut hi = price * (1.0 + (0.005 + 0.02 * u2));
    for t in [stop, tp].into_iter().flatten().filter(|t| !t.fired) {
        if t.trigger < price {
            lo = lo.max(price - (price - t.trigger) * (0.25 + 0.5 * u1));
        }
        if t.trigger > price {
            hi = hi.min(price + (t.trigger - price) * (0.25 + 0.5 * u2));
        }
    }
    (lo, hi)
}

/// Reduce-only IOC order 3% through the mid. Reduce-only means Hyperliquid will only
/// ever let it make the position smaller.
pub fn reduce_order(a: &Asset, is_buy: bool, mid: f64, sz: f64, builder: Option<(&str, u64)>) -> V {
    let px = if is_buy { mid * 1.03 } else { mid * 0.97 };
    order_action(a, is_buy, px, sz, builder)
}

/// Close order for a fired stop or take-profit: reduce-only IOC 3% through the market.
pub fn close_order(stop: &Stop, mid: f64, builder: Option<(&str, u64)>) -> Option<V> {
    let a = asset(&stop.coin)?;
    Some(reduce_order(a, stop.side == "short", mid, stop.size, builder))
}

/// Close a whole position of signed size szi (Hyperliquid's szi: positive long,
/// negative short). None when there is nothing to close.
pub fn close_position_order(a: &Asset, szi: f64, mid: f64) -> Option<V> {
    let sz = round_sz(szi.abs(), a.sz_decimals);
    if !(sz > 0.0) || !mid.is_finite() || !(mid > 0.0) {
        return None;
    }
    Some(reduce_order(a, szi < 0.0, mid, sz, None))
}

// ---------------------------------------------------------------- input checks

/// A sealed call may carry a plain "shard" next to "box" so the caller can route it.
/// When it does, it must be the shard inside the box.
pub fn check_outer_shard(outer: &serde_json::Value, inner: &serde_json::Value) -> Result<(), String> {
    match outer.get("shard") {
        None | Some(serde_json::Value::Null) => Ok(()),
        Some(o) => {
            if o.as_str().is_some() && o.as_str() == inner.get("shard").and_then(|s| s.as_str()) {
                Ok(())
            } else {
                Err("shard does not match the sealed call".into())
            }
        }
    }
}

/// A stop or take-profit from input: supported coin, long or short, positive trigger and size.
pub fn check_trigger(v: &serde_json::Value, what: &str) -> Result<Stop, String> {
    let mut st: Stop = serde_json::from_value(v.clone()).map_err(|_| format!("{what} missing or malformed"))?;
    st.coin = st.coin.to_uppercase();
    asset(&st.coin).ok_or("unsupported coin")?;
    if (st.side != "long" && st.side != "short") || !(st.trigger > 0.0 && st.trigger.is_finite()) || !(st.size > 0.0 && st.size.is_finite()) {
        return Err(format!("bad {what}"));
    }
    st.fired = false;
    Ok(st)
}

pub const MAX_JITTER_BPS: u64 = 100;

/// Optional stop jitter in whole basis points, 0-100. Missing means 0.
pub fn check_jitter_bps(v: &serde_json::Value) -> Result<u64, String> {
    match v {
        serde_json::Value::Null => Ok(0),
        _ => v.as_u64().filter(|b| *b <= MAX_JITTER_BPS).ok_or_else(|| "jitter_bps must be a whole number 0-100".into()),
    }
}

/// Move a trigger by (2u - 1) * jitter_bps basis points, u in [0,1).
pub fn jitter_trigger(trigger: f64, jitter_bps: u64, u: f64) -> f64 {
    if jitter_bps == 0 {
        return trigger;
    }
    trigger * (1.0 + (2.0 * u - 1.0) * jitter_bps as f64 / 10_000.0)
}

pub const MAX_TICK_SHARDS: usize = 32;

/// Shard list for tick_coin: 1-32 valid shard ids, no repeats.
pub fn check_shards(v: &serde_json::Value) -> Result<Vec<String>, String> {
    let a = v.as_array().ok_or("shards must be a list")?;
    if a.is_empty() || a.len() > MAX_TICK_SHARDS {
        return Err(format!("shards must hold 1-{MAX_TICK_SHARDS} shard ids"));
    }
    let mut out: Vec<String> = Vec::with_capacity(a.len());
    for x in a {
        let s = x.as_str().filter(|s| valid_shard(s)).ok_or("shard must be 1-16 lowercase letters/digits")?;
        if out.iter().any(|o| o == s) {
            return Err("duplicate shard".into());
        }
        out.push(s.to_string());
    }
    Ok(out)
}

/// VRF labels for plans: 1-64 characters of a-z, 0-9 and "-".
pub fn valid_vrf_label(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

// ---------------------------------------------------------------- one decision per shard

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Fire {
    Nothing,
    Stop,
    TakeProfit,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ShardDecision {
    /// false when fewer than MIN_AGREE sources agree; then nothing fires.
    pub agree: bool,
    pub fire: Fire,
    pub band: Option<(f64, f64)>,
}

impl ShardDecision {
    pub fn done(&self, dry: bool) -> &'static str {
        match (self.agree, self.fire, dry) {
            (false, _, _) => "no_agreement",
            (true, Fire::Nothing, _) => "watch",
            (true, Fire::Stop, false) => "fired",
            (true, Fire::Stop, true) => "would_fire",
            (true, Fire::TakeProfit, false) => "took_profit",
            (true, Fire::TakeProfit, true) => "would_take_profit",
        }
    }
}

/// The one decision tick and tick_coin both make for a shard. A stop wins over a
/// take-profit if both are hit. The band is drawn around the triggers as they were
/// before this decision, so even a dry run never shows a band holding a live trigger.
pub fn decide_shard(stop: Option<&Stop>, tp: Option<&TakeProfit>, agreeing: Option<&[f64]>, mid: Option<f64>, u1: f64, u2: f64) -> ShardDecision {
    let fire = match agreeing {
        Some(a) if stop.is_some_and(|s| should_fire(s, a)) => Fire::Stop,
        Some(a) if tp.is_some_and(|t| should_take_profit(t, a)) => Fire::TakeProfit,
        _ => Fire::Nothing,
    };
    let band = match (agreeing, mid) {
        (Some(_), Some(m)) => Some(wake_band(m, stop, tp, u1, u2)),
        _ => None,
    };
    ShardDecision { agree: agreeing.is_some(), fire, band }
}

/// Whether a trigger is still live after this tick: null when there is none.
pub fn still_live(t: Option<&Stop>, fired_now: bool) -> Option<bool> {
    t.map(|t| !t.fired && !fired_now)
}

// ---------------------------------------------------------------- positions and defence

#[derive(Clone, Debug, PartialEq)]
pub struct Position {
    /// signed size: positive long, negative short
    pub szi: f64,
    pub liquidation_px: Option<f64>,
}

fn num_of(v: &serde_json::Value) -> Option<f64> {
    v.as_str().and_then(|s| s.parse().ok()).or_else(|| v.as_f64()).filter(|x: &f64| x.is_finite())
}

/// The position for a coin from Hyperliquid's clearinghouseState answer.
pub fn position_of(state: &serde_json::Value, coin: &str) -> Option<Position> {
    let ps = state["assetPositions"].as_array()?;
    let p = ps.iter().map(|x| &x["position"]).find(|p| p["coin"].as_str() == Some(coin))?;
    let szi = num_of(&p["szi"])?;
    let liquidation_px = num_of(&p["liquidationPx"]).filter(|x| *x > 0.0);
    Some(Position { szi, liquidation_px })
}

/// |mark - liquidation| / mark.
pub fn liq_distance(mark: f64, liquidation_px: f64) -> Option<f64> {
    if !(mark > 0.0) || !mark.is_finite() || !liquidation_px.is_finite() {
        return None;
    }
    Some((mark - liquidation_px).abs() / mark)
}

/// Defence ladder: under 12% from liquidation cut 25%, under 8% cut another 25%,
/// under 5% close. Each rung fires once; rungs only go up and go back to 0 at 15% or more.
pub const DEFENCE_RUNGS: [f64; 3] = [0.12, 0.08, 0.05];
pub const DEFENCE_RESET: f64 = 0.15;
pub const DEFENCE_CUT: f64 = 0.25;
/// Hyperliquid refuses orders under $10: a smaller cut, or a cut that leaves less, closes instead.
pub const MIN_ORDER_USD: f64 = 10.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum DefenceKind {
    Nothing,
    Cut,
    Close,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DefenceAction {
    pub kind: DefenceKind,
    /// rung to store after this step (0-3)
    pub rung: u8,
    /// size of the reduce-only order to send (0 when nothing)
    pub size: f64,
}

/// One defence step for liquidation distance d, stored rung, current position size
/// (unsigned) and the agreed mid. Never returns an order bigger than the position.
pub fn defence_step(d: f64, rung: u8, size: f64, mid: f64, sz_decimals: u32) -> DefenceAction {
    let rung = rung.min(3);
    let none = |r: u8| DefenceAction { kind: DefenceKind::Nothing, rung: r, size: 0.0 };
    if !d.is_finite() || !(size > 0.0) || !size.is_finite() || !(mid > 0.0) || !mid.is_finite() {
        return none(rung);
    }
    if d >= DEFENCE_RESET {
        return none(0);
    }
    let target = DEFENCE_RUNGS.iter().filter(|r| d < **r).count() as u8;
    if target <= rung {
        return none(rung);
    }
    let full = round_sz(size, sz_decimals).min(size);
    let close = DefenceAction { kind: DefenceKind::Close, rung: target, size: full };
    if target == 3 {
        return close;
    }
    // each rung climbed cuts 25% of what is left
    let keep = (1.0 - DEFENCE_CUT).powi((target - rung) as i32);
    let cut = round_sz(size * (1.0 - keep), sz_decimals).min(full);
    if cut * mid < MIN_ORDER_USD || (size - cut) * mid < MIN_ORDER_USD {
        return close;
    }
    DefenceAction { kind: DefenceKind::Cut, rung: target, size: cut }
}

// ---------------------------------------------------------------- reports

/// Every 0x-and-40-hex run inside string values becomes "0x(address)", so no
/// account address from a Hyperliquid reply reaches an output.
pub fn redact_addresses(v: &serde_json::Value) -> serde_json::Value {
    use serde_json::Value;
    match v {
        Value::String(s) => Value::String(redact_str(s)),
        Value::Array(xs) => Value::Array(xs.iter().map(redact_addresses).collect()),
        Value::Object(m) => Value::Object(m.iter().map(|(k, x)| (redact_str(k), redact_addresses(x))).collect()),
        x => x.clone(),
    }
}

fn redact_str(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < b.len() {
        if i + 42 <= b.len() && b[i] == b'0' && (b[i + 1] == b'x' || b[i + 1] == b'X') && b[i + 2..i + 42].iter().all(|c| c.is_ascii_hexdigit()) {
            out.push_str("0x(address)");
            i += 42;
            while i < b.len() && b[i].is_ascii_hexdigit() {
                i += 1;
            }
        } else {
            let c = s[i..].chars().next().unwrap();
            out.push(c);
            i += c.len_utf8();
        }
    }
    out
}

/// Price fetch summary shared by every report.
#[derive(Clone, Debug, Default)]
pub struct PriceInfo {
    pub sources_ok: usize,
    pub sources_agree: Option<usize>,
    pub source_errors: Vec<String>,
    pub price_ms: u64,
}

impl PriceInfo {
    fn put(&self, out: &mut serde_json::Value) {
        out["sources_ok"] = serde_json::json!(self.sources_ok);
        out["sources_agree"] = serde_json::json!(self.sources_agree);
        out["source_errors"] = serde_json::json!(self.source_errors);
        out["price_ms"] = serde_json::json!(self.price_ms);
    }
}

/// One shard's part of a tick: done state, band, whether a stop and a take-profit are
/// still live, the defence report and the Hyperliquid reply to any order sent.
pub fn shard_report(done: &str, band: Option<(f64, f64)>, has_stop: Option<bool>, has_tp: Option<bool>, defence: serde_json::Value, order: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "done": done,
        "band": band.map(|(lo, hi)| serde_json::json!([lo, hi])),
        "has_stop": has_stop,
        "has_tp": has_tp,
        "defence": defence,
        "order": redact_addresses(&order),
    })
}

/// tick: one shard report with the price summary next to it.
pub fn tick_report(shard: serde_json::Value, info: &PriceInfo) -> serde_json::Value {
    let mut out = shard;
    info.put(&mut out);
    out
}

/// tick_coin: every shard's report keyed by shard, one price summary.
pub fn tick_coin_report(shards: Vec<(String, serde_json::Value)>, info: &PriceInfo) -> serde_json::Value {
    let mut m = serde_json::Map::new();
    for (k, v) in shards {
        m.insert(k, v);
    }
    let mut out = serde_json::json!({ "shards": m });
    info.put(&mut out);
    out
}

pub fn defend_report(a: &DefenceAction, distance: Option<f64>, hl: Option<serde_json::Value>) -> serde_json::Value {
    let action = match a.kind {
        DefenceKind::Nothing => "none",
        DefenceKind::Cut => "cut",
        DefenceKind::Close => "close",
    };
    let mut out = serde_json::json!({ "action": action, "rung": a.rung, "distance": distance });
    if a.kind != DefenceKind::Nothing {
        out["size"] = serde_json::json!(a.size);
    }
    if let Some(h) = hl {
        out["hl"] = redact_addresses(&h);
    }
    out
}

pub fn close_report(size: f64, hl: serde_json::Value) -> serde_json::Value {
    serde_json::json!({ "done": "closed", "size": size, "hl": redact_addresses(&hl) })
}

pub fn u01(bytes: &[u8]) -> f64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&bytes[..8]);
    (u64::from_be_bytes(b) >> 11) as f64 / (1u64 << 53) as f64
}

// ---------------------------------------------------------------- agents, opens, leverage, sealed box

pub fn update_leverage_action(a: &Asset, leverage: u64) -> V {
    V::M(vec![
        ("type".into(), s("updateLeverage")),
        ("asset".into(), V::U(a.index)),
        ("isCross".into(), V::B(true)),
        ("leverage".into(), V::U(leverage)),
    ])
}

/// Opening order (not reduce-only), IOC 3% through the market.
pub fn open_order(a: &Asset, is_buy: bool, mid: f64, sz: f64, builder: Option<(&str, u64)>) -> V {
    let px = if is_buy { mid * 1.03 } else { mid * 0.97 };
    let mut v = order_action(a, is_buy, px, sz, builder);
    if let V::M(kv) = &mut v {
        if let V::A(os) = &mut kv[1].1 {
            if let V::M(o) = &mut os[0] {
                o[4].1 = V::B(false);
            }
        }
    }
    v
}

/// Hard caps the guard enforces on anything it opens, whatever the input says.
pub const MAX_NOTIONAL_USD: f64 = 5000.0;
pub const MAX_LEVERAGE: u64 = 10;

/// Refuse an open whose notional at the agreed mid is over MAX_NOTIONAL_USD.
pub fn check_open_cap(size: f64, mid: f64) -> Result<(), String> {
    let n = size * mid;
    if !n.is_finite() || n > MAX_NOTIONAL_USD {
        return Err(format!("notional over the {MAX_NOTIONAL_USD} USD cap"));
    }
    Ok(())
}

/// Sign a 32-byte digest with a raw secp256k1 secret (per-shard agent key).
pub fn sign_with(secret: &[u8; 32], digest: &[u8; 32]) -> Result<Vec<u8>, String> {
    let k = k256::ecdsa::SigningKey::from_slice(secret).map_err(|e| e.to_string())?;
    let (sig, rid) = k.sign_prehash_recoverable(digest).map_err(|e| e.to_string())?;
    let mut o = sig.to_bytes().to_vec();
    o.push(rid.to_byte());
    Ok(o)
}

pub fn address_of(secret: &[u8; 32]) -> Result<String, String> {
    let k = k256::ecdsa::SigningKey::from_slice(secret).map_err(|e| e.to_string())?;
    let p = k.verifying_key().to_encoded_point(false);
    Ok(evm_address(&p.as_bytes()[1..]))
}

/// Sealed box: client makes an ephemeral X25519 key, key = sha256(tag ‖ shared ‖ epk ‖ gpk),
/// ChaCha20-Poly1305 with a random 12-byte nonce. Every guard call except addr/box_pub is
/// one such box with aad "unhuntable-call-v1"; the op, shard, fields (a stop too) and a
/// random salt are inside it. Only ciphertext reaches OutLayer's input, so the public
/// input_hash reveals nothing.
pub const BOX_TAG: &[u8] = b"unhuntable-box-v1";

pub fn box_public(secret: &[u8; 32]) -> [u8; 32] {
    x25519_dalek::PublicKey::from(&x25519_dalek::StaticSecret::from(*secret)).to_bytes()
}

pub fn box_open(secret: &[u8; 32], epk: &[u8], nonce: &[u8], ct: &[u8], aad: &[u8]) -> Result<Vec<u8>, String> {
    use chacha20poly1305::aead::{Aead, KeyInit, Payload};
    use sha2::Digest as _;
    let epk: [u8; 32] = epk.try_into().map_err(|_| "epk length")?;
    let sk = x25519_dalek::StaticSecret::from(*secret);
    let shared = sk.diffie_hellman(&x25519_dalek::PublicKey::from(epk));
    let mut h = sha2::Sha256::new();
    h.update(BOX_TAG);
    h.update(shared.as_bytes());
    h.update(epk);
    h.update(box_public(secret));
    let key = h.finalize();
    let c = chacha20poly1305::ChaCha20Poly1305::new_from_slice(&key).map_err(|e| e.to_string())?;
    if nonce.len() != 12 {
        return Err("nonce length".into());
    }
    c.decrypt(chacha20poly1305::Nonce::from_slice(nonce), Payload { msg: ct, aad })
        .map_err(|_| "box does not open".into())
}

/// Shard names: short, lowercase, so storage names stay fixed-shape.
pub fn valid_shard(s: &str) -> bool {
    !s.is_empty() && s.len() <= 16 && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// Digest for a USD send (user-signed). Used ONLY by the withdraw probe, which
/// proves Hyperliquid refuses a transfer signed by an agent key.
pub fn usd_send_digest(destination: &str, amount: &str, time: u64) -> [u8; 32] {
    let th = keccak(b"HyperliquidTransaction:UsdSend(string hyperliquidChain,string destination,string amount,uint64 time)");
    let mut d = Vec::new();
    d.extend_from_slice(&th);
    d.extend_from_slice(&keccak(b"Mainnet"));
    d.extend_from_slice(&keccak(destination.as_bytes()));
    d.extend_from_slice(&keccak(amount.as_bytes()));
    d.extend_from_slice(&u256(time));
    eip712(domain_sep("HyperliquidSignTransaction", SIG_CHAIN), keccak(&d))
}

// ---------------------------------------------------------------- EAS off-chain attestation

pub const EAS_SCHEMA: &str = "uint64 asOf,uint32 shards,int64 equityMicroUsd,int64 netDepositsMicroUsd,int64 pnlMicroUsd,string outlayerCall";
pub const EAS_CHAIN_ID: u64 = 8453; // Base
pub const EAS_CONTRACT: &str = "0x4200000000000000000000000000000000000021";
pub const EAS_VERSION: &str = "1.0.1"; // as reported by the Base EAS contract

pub fn eas_schema_uid() -> [u8; 32] {
    // keccak256(abi.encodePacked(schema, resolver = 0x0, revocable = false))
    let mut d = EAS_SCHEMA.as_bytes().to_vec();
    d.extend_from_slice(&[0u8; 20]);
    d.push(0);
    keccak(&d)
}

fn i256(x: i64) -> [u8; 32] {
    let mut o = if x < 0 { [0xffu8; 32] } else { [0u8; 32] };
    o[24..].copy_from_slice(&x.to_be_bytes());
    o
}

pub struct Proof {
    pub as_of: u64,
    pub shards: u32,
    pub equity_micro: i64,
    pub net_deposits_micro: i64,
    pub pnl_micro: i64,
    pub call: String,
}

/// abi.encode of the schema fields.
pub fn eas_data(p: &Proof) -> Vec<u8> {
    let mut d = Vec::new();
    d.extend_from_slice(&u256(p.as_of));
    d.extend_from_slice(&u256(p.shards as u64));
    d.extend_from_slice(&i256(p.equity_micro));
    d.extend_from_slice(&i256(p.net_deposits_micro));
    d.extend_from_slice(&i256(p.pnl_micro));
    d.extend_from_slice(&u256(6 * 32)); // offset of the string
    let s = p.call.as_bytes();
    d.extend_from_slice(&u256(s.len() as u64));
    d.extend_from_slice(s);
    while d.len() % 32 != 0 {
        d.push(0);
    }
    d
}

/// EIP-712 digest of an EAS off-chain attestation (version 2, with salt).
pub fn eas_digest(time: u64, data: &[u8], salt: &[u8; 32]) -> [u8; 32] {
    let th = keccak(b"Attest(uint16 version,bytes32 schema,address recipient,uint64 time,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,bytes32 salt)");
    let mut m = Vec::new();
    m.extend_from_slice(&th);
    m.extend_from_slice(&u256(2));
    m.extend_from_slice(&eas_schema_uid());
    m.extend_from_slice(&[0u8; 32]); // recipient 0x0
    m.extend_from_slice(&u256(time));
    m.extend_from_slice(&u256(0)); // expirationTime
    m.extend_from_slice(&u256(0)); // revocable false
    m.extend_from_slice(&[0u8; 32]); // refUID
    m.extend_from_slice(&keccak(data));
    m.extend_from_slice(salt);
    let dth = keccak(b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    let mut dm = Vec::new();
    dm.extend_from_slice(&dth);
    dm.extend_from_slice(&keccak(b"EAS Attestation"));
    dm.extend_from_slice(&keccak(EAS_VERSION.as_bytes()));
    dm.extend_from_slice(&u256(EAS_CHAIN_ID));
    let mut a = [0u8; 32];
    a[12..].copy_from_slice(&hex::decode(&EAS_CONTRACT[2..]).unwrap());
    dm.extend_from_slice(&a);
    eip712(keccak(&dm), keccak(&m))
}
