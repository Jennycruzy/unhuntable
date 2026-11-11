//! Hyperliquid accounts controlled by NEAR Chain Signatures.
//!
//! Each piece has its own ed25519 key, made and kept in the user's browser (backed up
//! by their 12 words). The piece's Hyperliquid account is derived by NEAR's MPC network
//! (`v1.signer`) from this contract's account and a path built from that key, so no
//! private key for the Hyperliquid account exists anywhere.
//!
//! The contract signs a Hyperliquid action only when:
//! - it is one of the actions in `hl.rs` (no orders, no account conversions, and a
//!   builder fee only for the builder fixed at build time, at exactly 0.01%), and the
//!   contract built its hash itself from typed fields, and
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
pub const ERR_CONTROLLED: &str = "this piece is controlled by another account; only that account can have it signed";
pub const ERR_NOT_CONTROLLER: &str = "only the account that controls this piece can do this";
pub const ERR_HAS_CONTROLLER: &str = "this piece already has a controller; only that account can hand it on";
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
    /// piece key → the account that controls it (a DAO, for treasury mode). Kept apart from
    /// the contract's state struct, so pieces made before it need no migration.
    Controllers,
}

fn controllers() -> LookupMap<[u8; 32], AccountId> {
    LookupMap::new(Key::Controllers)
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

    /// The only builder a piece can approve a fee for, and the only rate; None when builder
    /// fees are off in this build.
    #[result_serializer(borsh)]
    pub fn builder(&self) -> Option<(String, String)> {
        hl::BUILDER.map(|b| (b.to_string(), hl::BUILDER_FEE_RATE.to_string()))
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
    /// A piece handed to a controller is signed for only through `sign_as_controller`.
    #[payable]
    pub fn sign(&mut self, #[serializer(borsh)] piece_key: PublicKey, #[serializer(borsh)] action: HlAction, #[serializer(borsh)] signature: Vec<u8>) -> Promise {
        let k = key_bytes(&piece_key);
        require!(controllers().get(&k).is_none(), ERR_CONTROLLED);
        let counter = *self.pieces.get(&k).unwrap_or_else(|| env::panic_str(ERR_NO_PIECE));
        let sig: [u8; 64] = signature.as_slice().try_into().unwrap_or_else(|_| env::panic_str(ERR_SIG_LEN));
        let msg = self.message_for(&k, counter, &action);
        require!(env::ed25519_verify(&sig, msg.as_bytes(), &k), ERR_PIECE_SIG);
        self.mpc_sign(&k, counter, &action, None)
    }

    // ---------------------------------------------------------- treasury mode

    /// The account that controls this piece, if its key handed it to one.
    #[result_serializer(borsh)]
    pub fn controller(&self, #[serializer(borsh)] piece_key: PublicKey) -> Option<AccountId> {
        controllers().get(&key_bytes(&piece_key)).cloned()
    }

    /// The exact text the piece key signs to hand the piece to `controller`:
    /// `unhuntable-controller-v1:<this contract>:<piece key hex>:<counter>:<controller>`.
    #[result_serializer(borsh)]
    pub fn controller_message(&self, #[serializer(borsh)] piece_key: PublicKey, #[serializer(borsh)] controller: AccountId) -> String {
        let k = key_bytes(&piece_key);
        let counter = *self.pieces.get(&k).unwrap_or_else(|| env::panic_str(ERR_NO_PIECE));
        format!("unhuntable-controller-v1:{}:{}:{}:{}", env::current_account_id(), hl::hex(&k), counter, controller)
    }

    /// Hand the piece to a controller, such as a DAO. Only the piece key can do this, once,
    /// with its signature over `controller_message`; it uses up one counter. From then on
    /// the piece key alone cannot get anything signed: only the controller can.
    pub fn set_controller(&mut self, #[serializer(borsh)] piece_key: PublicKey, #[serializer(borsh)] controller: AccountId, #[serializer(borsh)] signature: Vec<u8>) {
        let k = key_bytes(&piece_key);
        require!(controllers().get(&k).is_none(), ERR_HAS_CONTROLLER);
        let counter = *self.pieces.get(&k).unwrap_or_else(|| env::panic_str(ERR_NO_PIECE));
        let sig: [u8; 64] = signature.as_slice().try_into().unwrap_or_else(|_| env::panic_str(ERR_SIG_LEN));
        let msg = self.controller_message(piece_key, controller.clone());
        require!(env::ed25519_verify(&sig, msg.as_bytes(), &k), ERR_PIECE_SIG);
        self.pieces.insert(k, counter + 1);
        let mut c = controllers();
        c.insert(k, controller.clone());
        c.flush();
        event("controlled", &format!(r#"{{"controller":"{controller}","counter":{counter}}}"#));
    }

    /// The controller hands the piece to another account, or with `None` back to the piece key.
    pub fn change_controller(&mut self, #[serializer(borsh)] piece_key: PublicKey, #[serializer(borsh)] controller: Option<AccountId>) {
        let k = key_bytes(&piece_key);
        let mut c = controllers();
        let now = c.get(&k).cloned().unwrap_or_else(|| env::panic_str(ERR_NOT_CONTROLLER));
        require!(env::predecessor_account_id() == now, ERR_NOT_CONTROLLER);
        match &controller {
            Some(next) => {
                c.insert(k, next.clone());
            }
            None => {
                c.remove(&k);
            }
        }
        c.flush();
        let to = controller.map(|a| format!(r#""{a}""#)).unwrap_or_else(|| "null".into());
        event("controlled", &format!(r#"{{"controller":{to}}}"#));
    }

    /// Sign one Hyperliquid action for a controlled piece, called by its controller (for a
    /// DAO: a passed proposal). The same rules hold: only the actions in `hl.rs`, hashed here.
    #[payable]
    pub fn sign_as_controller(&mut self, #[serializer(borsh)] piece_key: PublicKey, #[serializer(borsh)] action: HlAction) -> Promise {
        let k = key_bytes(&piece_key);
        let ctl = controllers().get(&k).cloned().unwrap_or_else(|| env::panic_str(ERR_NOT_CONTROLLER));
        require!(env::predecessor_account_id() == ctl, ERR_NOT_CONTROLLER);
        let counter = *self.pieces.get(&k).unwrap_or_else(|| env::panic_str(ERR_NO_PIECE));
        self.mpc_sign(&k, counter, &action, Some(&ctl))
    }

    /// Count the action, log it and ask the MPC signer to sign its digest.
    fn mpc_sign(&mut self, k: &[u8; 32], counter: u64, action: &HlAction, by: Option<&AccountId>) -> Promise {
        require!(env::prepaid_gas() >= Gas::from_tgas(MIN_SIGN_TGAS), ERR_SIGN_GAS);
        let deposit = env::attached_deposit();
        require!(deposit >= NearToken::from_yoctonear(1), ERR_SIGN_DEPOSIT);
        let digest = hl::hex(&hl::digest(action, &self.hl_chain));
        self.pieces.insert(*k, counter + 1);
        let by = by.map(|a| format!(r#","controller":"{a}""#)).unwrap_or_default();
        event("signed", &format!(r#"{{"kind":"{}","counter":{counter}{by}}}"#, action.kind()));
        let args = format!(r#"{{"request":{{"path":"{}","payload_v2":{{"Ecdsa":"{digest}"}},"domain_id":0}}}}"#, path_of(k));
        Promise::new(self.signer.clone()).function_call_weight("sign", args.into_bytes(), deposit, Gas::from_tgas(SIGNER_GAS_TGAS), GasWeight(1))
    }
}

#[cfg(test)]
mod tests;
