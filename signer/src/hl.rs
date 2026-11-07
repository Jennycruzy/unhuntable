//! Hyperliquid user-signed actions, hashed exactly as Hyperliquid checks them
//! (EIP-712, domain "HyperliquidSignTransaction", chain id 0x66eee).
//!
//! The contract builds every hash itself from typed fields. It never signs a hash
//! a caller hands it, so the only things it can ever sign are the actions below.
//! Orders are not here: trading goes through the guard's agent key, which
//! Hyperliquid forbids from moving money.

use near_sdk::{env, near};

/// `signatureChainId` the client must send with every action (0x66eee).
pub const SIGNATURE_CHAIN_ID: u64 = 421614;
pub const MAX_NAME_CHARS: usize = 64;
pub const MAX_TOKEN_CHARS: usize = 80;
pub const MAX_DEX_CHARS: usize = 16;
pub const MAX_AMOUNT_CHARS: usize = 24;

pub const ERR_ADDRESS: &str = "address must be 0x and 40 lowercase hex characters";
pub const ERR_AMOUNT: &str = "amount must be a plain decimal like 12.5";
pub const ERR_NAME: &str = "agent name must be at most 64 printable characters";
pub const ERR_TOKEN: &str = "token must be 1 to 80 printable characters";
pub const ERR_DEX: &str = "market list name must be empty or up to 16 lowercase letters and digits";
pub const ERR_CHAIN: &str = "hyperliquid chain must be Mainnet or Testnet";

/// Every action the contract will sign for a piece. Borsh on the wire (keeps the
/// contract small); the variant order below is the borsh tag and never changes.
#[near(serializers = [borsh])]
#[cfg_attr(test, derive(near_sdk::serde::Deserialize), serde(crate = "near_sdk::serde"))]
#[derive(Clone, Debug, PartialEq)]
pub enum HlAction {
    /// Let an agent key (the guard's) trade for this piece. Agents cannot move money.
    ApproveAgent { agent_address: String, agent_name: String, nonce: u64 },
    /// Move USDC between this piece's spot and perp balances.
    UsdClassTransfer { amount: String, to_perp: bool, nonce: u64 },
    /// Move a token between market lists (e.g. main → trade.xyz) or to another address.
    SendAsset { destination: String, source_dex: String, destination_dex: String, token: String, amount: String, nonce: u64 },
    /// Withdraw USDC from Hyperliquid to an address on Arbitrum.
    Withdraw { destination: String, amount: String, time: u64 },
    /// Send a spot token to another Hyperliquid address.
    SpotSend { destination: String, token: String, amount: String, time: u64 },
    /// Send perp USDC to another Hyperliquid address.
    UsdSend { destination: String, amount: String, time: u64 },
}

impl HlAction {
    pub fn kind(&self) -> &'static str {
        match self {
            HlAction::ApproveAgent { .. } => "approve_agent",
            HlAction::UsdClassTransfer { .. } => "usd_class_transfer",
            HlAction::SendAsset { .. } => "send_asset",
            HlAction::Withdraw { .. } => "withdraw",
            HlAction::SpotSend { .. } => "spot_send",
            HlAction::UsdSend { .. } => "usd_send",
        }
    }
}

fn kc(b: impl AsRef<[u8]>) -> [u8; 32] {
    env::keccak256_array(b)
}

fn printable(s: &str) -> bool {
    s.bytes().all(|c| (0x20..0x7f).contains(&c))
}

pub fn check_address(s: &str) -> [u8; 20] {
    let b = s.as_bytes();
    let ok = b.len() == 42 && b[0] == b'0' && b[1] == b'x' && b[2..].iter().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(c));
    if !ok {
        env::panic_str(ERR_ADDRESS);
    }
    let mut out = [0u8; 20];
    for (i, pair) in b[2..].chunks(2).enumerate() {
        let hi = (pair[0] as char).to_digit(16).unwrap() as u8;
        let lo = (pair[1] as char).to_digit(16).unwrap() as u8;
        out[i] = hi << 4 | lo;
    }
    out
}

/// Plain decimal: digits, at most one dot with digits on both sides, no sign, no exponent.
pub fn check_amount(s: &str) {
    let mut parts = s.split('.');
    let int = parts.next().unwrap_or("");
    let frac = parts.next();
    let ok = !s.is_empty()
        && s.len() <= MAX_AMOUNT_CHARS
        && parts.next().is_none()
        && !int.is_empty()
        && int.bytes().all(|c| c.is_ascii_digit())
        && frac.map_or(true, |f| !f.is_empty() && f.bytes().all(|c| c.is_ascii_digit()));
    if !ok {
        env::panic_str(ERR_AMOUNT);
    }
}

fn check_token(s: &str) {
    if s.is_empty() || s.len() > MAX_TOKEN_CHARS || !printable(s) {
        env::panic_str(ERR_TOKEN);
    }
}

fn check_dex(s: &str) {
    if s.len() > MAX_DEX_CHARS || !s.bytes().all(|c| c.is_ascii_digit() || c.is_ascii_lowercase()) {
        env::panic_str(ERR_DEX);
    }
}

pub fn check_chain(s: &str) {
    if s != "Mainnet" && s != "Testnet" {
        env::panic_str(ERR_CHAIN);
    }
}

/// Validate every field; panics with a plain sentence on the first bad one.
pub fn validate(a: &HlAction) {
    match a {
        HlAction::ApproveAgent { agent_address, agent_name, .. } => {
            check_address(agent_address);
            if agent_name.len() > MAX_NAME_CHARS || !printable(agent_name) {
                env::panic_str(ERR_NAME);
            }
        }
        HlAction::UsdClassTransfer { amount, .. } => check_amount(amount),
        HlAction::SendAsset { destination, source_dex, destination_dex, token, amount, .. } => {
            check_address(destination);
            check_dex(source_dex);
            check_dex(destination_dex);
            check_token(token);
            check_amount(amount);
        }
        HlAction::Withdraw { destination, amount, .. } | HlAction::UsdSend { destination, amount, .. } => {
            check_address(destination);
            check_amount(amount);
        }
        HlAction::SpotSend { destination, token, amount, .. } => {
            check_address(destination);
            check_token(token);
            check_amount(amount);
        }
    }
}

enum Field<'a> {
    Str(&'a str),
    Addr(&'a str),
    U64(u64),
    Bool(bool),
}

fn word_u64(v: u64) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[24..].copy_from_slice(&v.to_be_bytes());
    w
}

fn encode(f: &Field) -> [u8; 32] {
    match f {
        Field::Str(s) => kc(s.as_bytes()),
        Field::Addr(s) => {
            let mut w = [0u8; 32];
            w[12..].copy_from_slice(&check_address(s));
            w
        }
        Field::U64(v) => word_u64(*v),
        Field::Bool(b) => word_u64(*b as u64),
    }
}

fn struct_hash(type_string: &str, fields: &[Field]) -> [u8; 32] {
    let mut buf = Vec::with_capacity(32 * (fields.len() + 1));
    buf.extend_from_slice(&kc(type_string.as_bytes()));
    for f in fields {
        buf.extend_from_slice(&encode(f));
    }
    kc(buf)
}

fn domain_separator() -> [u8; 32] {
    let mut buf = Vec::with_capacity(32 * 5);
    buf.extend_from_slice(&kc(b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
    buf.extend_from_slice(&kc(b"HyperliquidSignTransaction"));
    buf.extend_from_slice(&kc(b"1"));
    buf.extend_from_slice(&word_u64(SIGNATURE_CHAIN_ID));
    buf.extend_from_slice(&[0u8; 32]);
    kc(buf)
}

/// The 32-byte digest Hyperliquid recovers the signer from.
pub fn digest(a: &HlAction, chain: &str) -> [u8; 32] {
    validate(a);
    check_chain(chain);
    use Field::*;
    let sh = match a {
        HlAction::ApproveAgent { agent_address, agent_name, nonce } => struct_hash(
            "HyperliquidTransaction:ApproveAgent(string hyperliquidChain,address agentAddress,string agentName,uint64 nonce)",
            &[Str(chain), Addr(agent_address), Str(agent_name), U64(*nonce)],
        ),
        HlAction::UsdClassTransfer { amount, to_perp, nonce } => struct_hash(
            "HyperliquidTransaction:UsdClassTransfer(string hyperliquidChain,string amount,bool toPerp,uint64 nonce)",
            &[Str(chain), Str(amount), Bool(*to_perp), U64(*nonce)],
        ),
        HlAction::SendAsset { destination, source_dex, destination_dex, token, amount, nonce } => struct_hash(
            "HyperliquidTransaction:SendAsset(string hyperliquidChain,string destination,string sourceDex,string destinationDex,string token,string amount,string fromSubAccount,uint64 nonce)",
            &[Str(chain), Str(destination), Str(source_dex), Str(destination_dex), Str(token), Str(amount), Str(""), U64(*nonce)],
        ),
        HlAction::Withdraw { destination, amount, time } => struct_hash(
            "HyperliquidTransaction:Withdraw(string hyperliquidChain,string destination,string amount,uint64 time)",
            &[Str(chain), Str(destination), Str(amount), U64(*time)],
        ),
        HlAction::SpotSend { destination, token, amount, time } => struct_hash(
            "HyperliquidTransaction:SpotSend(string hyperliquidChain,string destination,string token,string amount,uint64 time)",
            &[Str(chain), Str(destination), Str(token), Str(amount), U64(*time)],
        ),
        HlAction::UsdSend { destination, amount, time } => struct_hash(
            "HyperliquidTransaction:UsdSend(string hyperliquidChain,string destination,string amount,uint64 time)",
            &[Str(chain), Str(destination), Str(amount), U64(*time)],
        ),
    };
    let mut buf = Vec::with_capacity(66);
    buf.extend_from_slice(&[0x19, 0x01]);
    buf.extend_from_slice(&domain_separator());
    buf.extend_from_slice(&sh);
    kc(buf)
}

pub fn hex(b: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(b.len() * 2);
    for x in b {
        s.push(H[(x >> 4) as usize] as char);
        s.push(H[(x & 15) as usize] as char);
    }
    s
}
