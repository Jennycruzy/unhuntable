//! Hyperliquid accounts controlled by NEAR Chain Signatures.
//!
//! Each piece has its own ed25519 key, made and kept in the user's browser (backed up
//! by their 12 words). The piece's Hyperliquid account is derived by NEAR's MPC network
//! (`v1.signer`) from this contract's account and a path built from that key, so no
//! private key for the Hyperliquid account exists anywhere.
//!
//! The contract signs a Hyperliquid action only when:
//! - it is one of the actions in `hl.rs` (no orders, no builder fees, no account
//!   conversions), and the contract built its hash itself from typed fields, and
//! - the piece key signed that exact action with the piece's current counter.
//!
//! Anyone may relay a call (our server does), but nobody without the piece key can get
//! a signature, change an amount or a destination, or replay an old request. The
//! user's NEAR account never appears in these calls. There is no owner and no admin
//! method.
//!
//! Arguments and results are borsh, which keeps the contract small enough to deploy
//! cheaply. Events are NEP-297 JSON logs.

use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, CurveType, Gas, GasWeight, NearToken, PanicOnDefault, Promise, PublicKey};

pub mod hl;
use hl::HlAction;

pub const ERR_PIECE_KEY: &str = "piece key must be an ed25519 key";
pub const ERR_NO_PIECE: &str = "that piece key is not registered here";
pub const ERR_KNOWN_PIECE: &str = "that piece key is already registered";
pub const ERR_PIECE_SIG: &str = "the piece key did not sign this action";
pub const ERR_SIG_LEN: &str = "signature must be 64 bytes";
pub const ERR_SIGN_GAS: &str = "attach at least 50 TGas to sign";
pub const ERR_SIGN_DEPOSIT: &str = "attach at least 1 yoctoNEAR to sign";
pub const ERR_STORAGE: &str = "attach enough NEAR to pay for this piece's storage";
pub const DEFAULT_SIGNER: &str = "v1.signer";
pub const DEFAULT_HL_CHAIN: &str = "Mainnet";
/// The MPC path is this prefix followed by the piece key as 64 hex characters.
pub const PATH_PREFIX: &str = "u1/";
/// Gas the MPC signer needs at least; the rest of the call's gas is forwarded to it too.
pub const SIGNER_GAS_TGAS: u64 = 15;
pub const MIN_SIGN_TGAS: u64 = 50;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum Key {
    Pieces,
}

/// What `add_piece` charged for storage and gave back, in yoctoNEAR.
#[near(serializers = [borsh])]
#[derive(Debug, PartialEq)]
pub struct Added {
    pub path: String,
    pub cost: u128,
    pub refund: u128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    /// piece key → number of actions signed so far (the counter the next message must name)
    pieces: LookupMap<[u8; 32], u64>,
    /// NEAR's MPC signer contract
    signer: AccountId,
    /// "Mainnet" or "Testnet": the Hyperliquid chain named inside every action
    hl_chain: String,
}

fn key_bytes(k: &PublicKey) -> [u8; 32] {
    if k.curve_type() != CurveType::ED25519 {
        env::panic_str(ERR_PIECE_KEY);
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&k.as_bytes()[1..33]);
    out
}

fn path_of(k: &[u8; 32]) -> String {
    let mut p = String::from(PATH_PREFIX);
    p.push_str(&hl::hex(k));
    p
}

fn event(name: &str, data: &str) {
    env::log_str(&format!(r#"EVENT_JSON:{{"standard":"unhuntable","version":"1.0.0","event":"{name}","data":{data}}}"#));
}

#[near]
impl Contract {
    #[init]
    pub fn new(#[serializer(borsh)] signer: Option<AccountId>, #[serializer(borsh)] hl_chain: Option<String>) -> Self {
        let hl_chain = hl_chain.unwrap_or_else(|| DEFAULT_HL_CHAIN.to_string());
        hl::check_chain(&hl_chain);
        Self { pieces: LookupMap::new(Key::Pieces), signer: signer.unwrap_or_else(|| DEFAULT_SIGNER.parse().unwrap()), hl_chain }
    }

    #[result_serializer(borsh)]
    pub fn signer(&self) -> AccountId {
        self.signer.clone()
    }

    #[result_serializer(borsh)]
    pub fn hl_chain(&self) -> String {
        self.hl_chain.clone()
    }

    /// The MPC path for a piece key. Anyone can derive the piece's Hyperliquid address with
    /// `v1.signer.derived_public_key({path, predecessor: <this contract>, domain_id: 0})`.
    #[result_serializer(borsh)]
    pub fn path(&self, #[serializer(borsh)] piece_key: PublicKey) -> String {
        path_of(&key_bytes(&piece_key))
    }

    /// Register a piece key. Anyone may call; it grants no power, because only the piece
    /// key can authorise a signature. Storage is paid from the attached deposit.
    #[payable]
    #[result_serializer(borsh)]
    pub fn add_piece(&mut self, #[serializer(borsh)] piece_key: PublicKey) -> Added {
        let k = key_bytes(&piece_key);
        require!(!self.pieces.contains_key(&k), ERR_KNOWN_PIECE);
        let before = env::storage_usage();
        self.pieces.insert(k, 0);
        self.pieces.flush();
        let used = env::storage_usage().saturating_sub(before);
        let cost = env::storage_byte_cost().saturating_mul(used as u128);
        let attached = env::attached_deposit();
        require!(attached >= cost, ERR_STORAGE);
        let refund = attached.saturating_sub(cost);
        if !refund.is_zero() {
            Promise::new(env::predecessor_account_id()).transfer(refund).detach();
        }
        event("piece_added", "{}");
        Added { path: path_of(&k), cost: cost.as_yoctonear(), refund: refund.as_yoctonear() }
    }

    /// Actions signed so far for this piece; the next message must name this counter.
    #[result_serializer(borsh)]
    pub fn counter(&self, #[serializer(borsh)] piece_key: PublicKey) -> Option<u64> {
        self.pieces.get(&key_bytes(&piece_key)).copied()
    }

    /// The EIP-712 digest Hyperliquid recovers the signer from, as hex.
    #[result_serializer(borsh)]
    pub fn digest(&self, #[serializer(borsh)] action: HlAction) -> String {
        hl::hex(&hl::digest(&action, &self.hl_chain))
    }

    /// The exact text the piece key must sign (ed25519 over these UTF-8 bytes):
    /// `unhuntable-hl-v1:<this contract>:<piece key hex>:<counter>:<digest hex>`.
    #[result_serializer(borsh)]
    pub fn message(&self, #[serializer(borsh)] piece_key: PublicKey, #[serializer(borsh)] action: HlAction) -> String {
        let k = key_bytes(&piece_key);
        let counter = *self.pieces.get(&k).unwrap_or_else(|| env::panic_str(ERR_NO_PIECE));
        self.message_for(&k, counter, &action)
    }

    fn message_for(&self, k: &[u8; 32], counter: u64, action: &HlAction) -> String {
        format!("unhuntable-hl-v1:{}:{}:{}:{}", env::current_account_id(), hl::hex(k), counter, hl::hex(&hl::digest(action, &self.hl_chain)))
    }

    /// Sign one Hyperliquid action for a piece with NEAR Chain Signatures.
    /// `signature` is the piece key's ed25519 signature over `message(piece_key, action)`.
    /// The call's result is the MPC signer's answer: `{big_r, s, recovery_id}` (JSON).
    #[payable]
    pub fn sign(&mut self, #[serializer(borsh)] piece_key: PublicKey, #[serializer(borsh)] action: HlAction, #[serializer(borsh)] signature: Vec<u8>) -> Promise {
        require!(env::prepaid_gas() >= Gas::from_tgas(MIN_SIGN_TGAS), ERR_SIGN_GAS);
        let deposit = env::attached_deposit();
        require!(deposit >= NearToken::from_yoctonear(1), ERR_SIGN_DEPOSIT);
        let k = key_bytes(&piece_key);
        let counter = *self.pieces.get(&k).unwrap_or_else(|| env::panic_str(ERR_NO_PIECE));
        let sig: [u8; 64] = signature.as_slice().try_into().unwrap_or_else(|_| env::panic_str(ERR_SIG_LEN));
        let msg = self.message_for(&k, counter, &action);
        require!(env::ed25519_verify(&sig, msg.as_bytes(), &k), ERR_PIECE_SIG);
        self.pieces.insert(k, counter + 1);
        let digest = hl::hex(&hl::digest(&action, &self.hl_chain));
        event("signed", &format!(r#"{{"kind":"{}","counter":{counter}}}"#, action.kind()));
        let args = format!(r#"{{"request":{{"path":"{}","payload_v2":{{"Ecdsa":"{digest}"}},"domain_id":0}}}}"#, path_of(&k));
        Promise::new(self.signer.clone()).function_call_weight("sign", args.into_bytes(), deposit, Gas::from_tgas(SIGNER_GAS_TGAS), GasWeight(1))
    }
}

#[cfg(test)]
mod tests;
