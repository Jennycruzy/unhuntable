//! Pure logic of the guard: Hyperliquid action encoding and signing digests,
//! price agreement, stop decisions and wake bands. No host calls here, so
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

pub fn round_sz(sz: f64, sz_decimals: u32) -> f64 {
    let p = 10f64.powi(sz_decimals as i32);
    (sz * p).floor() / p
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

/// Wake band: a price range with no stop inside, padded by two VRF draws
/// (u1, u2 in [0,1)) so its edges never point at the stop.
/// Returns (low, high). With no stop: ±(0.5%..2.5%).
pub fn wake_band(price: f64, stop: Option<&Stop>, u1: f64, u2: f64) -> (f64, f64) {
    let mut lo = price * (1.0 - (0.005 + 0.02 * u1));
    let mut hi = price * (1.0 + (0.005 + 0.02 * u2));
    if let Some(st) = stop.filter(|s| !s.fired) {
        // edge sits a random 25–75% of the way from price towards the stop
        let f = 0.25 + 0.5 * u1;
        if st.side == "long" && st.trigger < price {
            lo = lo.max(price - (price - st.trigger) * f);
        }
        if st.side == "short" && st.trigger > price {
            hi = hi.min(price + (st.trigger - price) * (0.25 + 0.5 * u2));
        }
    }
    (lo, hi)
}

/// Close order for a fired stop: reduce-only IOC 3% through the market.
pub fn close_order(stop: &Stop, mid: f64, builder: Option<(&str, u64)>) -> Option<V> {
    let a = asset(&stop.coin)?;
    let is_buy = stop.side == "short";
    let px = if is_buy { mid * 1.03 } else { mid * 0.97 };
    Some(order_action(a, is_buy, px, stop.size, builder))
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
pub const MAX_NOTIONAL_USD: f64 = 25.0;
pub const MAX_LEVERAGE: u64 = 10;

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
/// ChaCha20-Poly1305 with a random 12-byte nonce, aad = shard name.
/// Only ciphertext reaches OutLayer's input, so the public input_hash reveals nothing.
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

/// Digest for a usdSend (user-signed). Used ONLY by the withdraw probe, which
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
