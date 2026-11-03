//! Public, checkable records for unhuntable. The contract holds only hashes,
//! amounts and treasury settings, never an address that could tie pieces together.
//!
//! - Piece registry: sha256(owner salt ‖ piece id). A user can later prove a piece was
//!   registered by us; nobody else learns which pieces belong together.
//! - Guard allowlist: sha256 of every guard wasm build we publish.
//! - Fee ledger: every fee we earn, so revenue is public and adds up.
//! - Treasury mirror: approvers and threshold a fund or DAO set in its wallet policy.

use near_sdk::store::{IterableMap, IterableSet, LookupMap, LookupSet, Vector};
use near_sdk::json_types::U128;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, PanicOnDefault, Promise};
use std::collections::BTreeMap;

mod events;
use events::Event;

pub const FEE_KINDS: [&str; 4] = ["aurora", "oneclick", "agent_call", "builder"];
pub const MAX_REFERENCE_CHARS: usize = 128;
pub const MAX_ASSET_CHARS: usize = 64;
pub const MAX_APPROVERS: usize = 10;
pub const MAX_PAGE: u32 = 100;

pub const ERR_PIECE_HASH: &str = "piece hash must be 64 lowercase hex characters";
pub const ERR_GUARD_HASH: &str = "wasm hash must be 64 lowercase hex characters";
pub const ERR_OWNER: &str = "only the owner can do this";
pub const ERR_OPERATOR: &str = "only an operator can do this";

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum Key {
    Operators,
    Pieces,
    Guards,
    Fees,
    FeeTotals,
    Treasuries,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct FeeRecord {
    pub index: u64,
    pub kind: String,
    pub asset: String,
    pub amount: U128,
    pub reference: String,
    pub recorded_ms: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Treasury {
    pub threshold: u8,
    pub approvers: Vec<AccountId>,
    pub updated_ms: u64,
}

/// What a storage-paying call charged and gave back, in yoctoNEAR.
#[near(serializers = [json])]
#[derive(Debug, PartialEq)]
pub struct StoragePaid {
    pub cost: U128,
    pub refund: U128,
}

#[near(serializers = [json])]
#[derive(Debug, PartialEq)]
pub struct Registered {
    pub added: u32,
    pub ignored: u32,
    pub storage: StoragePaid,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    operators: IterableSet<AccountId>,
    pieces: LookupSet<[u8; 32]>,
    guards: IterableSet<String>,
    fees: Vector<FeeRecord>,
    /// (kind, asset) → total
    fee_totals: IterableMap<(String, String), u128>,
    treasuries: LookupMap<AccountId, Treasury>,
}

/// 64 lowercase hex characters → 32 bytes.
fn parse_hash(s: &str) -> Option<[u8; 32]> {
    let b = s.as_bytes();
    if b.len() != 64 || !b.iter().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(c)) {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, pair) in b.chunks(2).enumerate() {
        let hi = (pair[0] as char).to_digit(16)? as u8;
        let lo = (pair[1] as char).to_digit(16)? as u8;
        out[i] = hi << 4 | lo;
    }
    Some(out)
}

fn guard_hash(s: &str) -> String {
    if parse_hash(s).is_none() {
        env::panic_str(ERR_GUARD_HASH);
    }
    s.to_string()
}

fn now_ms() -> u64 {
    env::block_timestamp() / 1_000_000
}

fn page<T>(items: impl Iterator<Item = T>, from_index: u32, limit: u32) -> Vec<T> {
    items.skip(from_index as usize).take(limit.min(MAX_PAGE) as usize).collect()
}

/// Charge the attached deposit for the bytes `f` adds and send the rest back.
/// `f` must flush the collections it changes, so their writes are counted.
fn charge_storage<R>(f: impl FnOnce() -> R) -> (R, StoragePaid) {
    let before = env::storage_usage();
    let r = f();
    let used = env::storage_usage().saturating_sub(before);
    let cost = env::storage_byte_cost().saturating_mul(used as u128);
    let attached = env::attached_deposit();
    if attached < cost {
        env::panic_str(&format!("attach at least {} yoctoNEAR to pay for storage", cost.as_yoctonear()));
    }
    let refund = attached.saturating_sub(cost);
    if !refund.is_zero() {
        Promise::new(env::predecessor_account_id()).transfer(refund).detach();
    }
    (r, StoragePaid { cost: U128(cost.as_yoctonear()), refund: U128(refund.as_yoctonear()) })
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        Self {
            owner,
            operators: IterableSet::new(Key::Operators),
            pieces: LookupSet::new(Key::Pieces),
            guards: IterableSet::new(Key::Guards),
            fees: Vector::new(Key::Fees),
            fee_totals: IterableMap::new(Key::FeeTotals),
            treasuries: LookupMap::new(Key::Treasuries),
        }
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, ERR_OWNER);
    }

    fn assert_operator(&self) {
        require!(self.operators.contains(&env::predecessor_account_id()), ERR_OPERATOR);
    }

    // ------------------------------------------------------------ owner

    pub fn owner(&self) -> AccountId {
        self.owner.clone()
    }

    pub fn transfer_owner(&mut self, new_owner: AccountId) {
        self.assert_owner();
        let old_owner = std::mem::replace(&mut self.owner, new_owner.clone());
        Event::OwnerTransferred { old_owner, new_owner }.emit();
    }

    pub fn add_operator(&mut self, account: AccountId) {
        self.assert_owner();
        self.operators.insert(account);
    }

    pub fn remove_operator(&mut self, account: AccountId) {
        self.assert_owner();
        self.operators.remove(&account);
    }

    pub fn operators(&self) -> Vec<AccountId> {
        self.operators.iter().cloned().collect()
    }

    // ------------------------------------------------------------ pieces

    /// Record piece hashes. Duplicates are ignored. Storage is paid from the attached deposit.
    #[payable]
    pub fn register_pieces(&mut self, hashes: Vec<String>) -> Registered {
        self.assert_operator();
        let parsed: Vec<[u8; 32]> = hashes.iter().map(|h| parse_hash(h).unwrap_or_else(|| env::panic_str(ERR_PIECE_HASH))).collect();
        let ((added, ignored), storage) = charge_storage(|| {
            let (mut added, mut ignored) = (0u32, 0u32);
            for h in &parsed {
                if self.pieces.insert(*h) {
                    added += 1;
                } else {
                    ignored += 1;
                }
            }
            (added, ignored)
        });
        // count only: the hashes themselves are never listed (LookupSet writes straight to storage)
        Event::PiecesRegistered { count: added }.emit();
        Registered { added, ignored, storage }
    }

    pub fn is_registered(&self, hash: String) -> bool {
        let h = parse_hash(&hash).unwrap_or_else(|| env::panic_str(ERR_PIECE_HASH));
        self.pieces.contains(&h)
    }

    // ------------------------------------------------------------ guards

    pub fn allow_guard(&mut self, wasm_sha256: String) {
        self.assert_owner();
        let h = guard_hash(&wasm_sha256);
        self.guards.insert(h.clone());
        Event::GuardAllowed { wasm_sha256: h }.emit();
    }

    pub fn revoke_guard(&mut self, wasm_sha256: String) {
        self.assert_owner();
        let h = guard_hash(&wasm_sha256);
        require!(self.guards.remove(&h), "that wasm hash is not on the guard list");
        Event::GuardRevoked { wasm_sha256: h }.emit();
    }

    /// True when a run's wasm hash is one of our published guard builds.
    pub fn check_guard(&self, wasm_sha256: String) -> bool {
        self.guards.contains(&guard_hash(&wasm_sha256))
    }

    pub fn list_guards(&self, from_index: u32, limit: u32) -> Vec<String> {
        page(self.guards.iter().cloned(), from_index, limit)
    }

    // ------------------------------------------------------------ fees

    #[payable]
    pub fn record_fee(&mut self, kind: String, asset: String, amount: U128, reference: String) -> StoragePaid {
        self.assert_operator();
        require!(FEE_KINDS.contains(&kind.as_str()), "fee kind must be aurora, oneclick, agent_call or builder");
        require!(!asset.is_empty() && asset.chars().count() <= MAX_ASSET_CHARS, "asset must be 1 to 64 characters");
        require!(reference.chars().count() <= MAX_REFERENCE_CHARS, "reference must be at most 128 characters");
        require!(amount.0 > 0, "fee amount must be above zero");
        let (rec, storage) = charge_storage(|| {
            let key = (kind.clone(), asset.clone());
            let total = self.fee_totals.get(&key).copied().unwrap_or(0).checked_add(amount.0).unwrap_or_else(|| env::panic_str("fee total overflows"));
            self.fee_totals.insert(key, total);
            let rec = FeeRecord { index: self.fees.len() as u64, kind, asset, amount, reference, recorded_ms: now_ms() };
            self.fees.push(rec.clone());
            self.fee_totals.flush();
            self.fees.flush();
            rec
        });
        Event::FeeRecorded { index: rec.index, kind: rec.kind, asset: rec.asset, amount: rec.amount, reference: rec.reference }.emit();
        storage
    }

    pub fn fees(&self, from_index: u32, limit: u32) -> Vec<FeeRecord> {
        page(self.fees.iter().cloned(), from_index, limit)
    }

    pub fn fee_count(&self) -> u64 {
        self.fees.len() as u64
    }

    /// kind → asset → total
    pub fn fee_totals(&self) -> BTreeMap<String, BTreeMap<String, U128>> {
        let mut out: BTreeMap<String, BTreeMap<String, U128>> = BTreeMap::new();
        for ((kind, asset), total) in self.fee_totals.iter() {
            out.entry(kind.clone()).or_default().insert(asset.clone(), U128(*total));
        }
        out
    }

    // ------------------------------------------------------------ treasuries

    /// The caller mirrors its own wallet policy: who approves and how many must.
    #[payable]
    pub fn set_treasury(&mut self, threshold: u8, approvers: Vec<AccountId>) -> StoragePaid {
        require!(approvers.len() <= MAX_APPROVERS, "at most 10 approvers");
        require!(threshold >= 1 && (threshold as usize) <= approvers.len(), "threshold must be between 1 and the number of approvers");
        let mut sorted = approvers.clone();
        sorted.sort();
        sorted.dedup();
        require!(sorted.len() == approvers.len(), "approvers must be different accounts");
        let account = env::predecessor_account_id();
        let t = Treasury { threshold, approvers, updated_ms: now_ms() };
        let (_, storage) = charge_storage(|| {
            self.treasuries.insert(account.clone(), t.clone());
            self.treasuries.flush();
        });
        Event::TreasurySet { account, threshold, approvers: t.approvers }.emit();
        storage
    }

    pub fn get_treasury(&self, account: AccountId) -> Option<Treasury> {
        self.treasuries.get(&account).cloned()
    }
}

#[cfg(test)]
mod tests;
