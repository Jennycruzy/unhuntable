//! NEP-297 events, standard "unhuntable", version "1.0.0". Logged as
//! EVENT_JSON:{"standard":"unhuntable","version":"1.0.0","event":"...","data":{...}}.
//! pieces_registered carries a count only, never the hashes.

use near_sdk::json_types::U128;
use near_sdk::{near, AccountId};

#[near(event_json(standard = "unhuntable"))]
pub enum Event {
    #[event_version("1.0.0")]
    PiecesRegistered { count: u32 },
    #[event_version("1.0.0")]
    GuardAllowed { wasm_sha256: String },
    #[event_version("1.0.0")]
    GuardRevoked { wasm_sha256: String },
    #[event_version("1.0.0")]
    FeeRecorded { index: u64, kind: String, asset: String, amount: U128, reference: String },
    #[event_version("1.0.0")]
    TreasurySet { account: AccountId, threshold: u8, approvers: Vec<AccountId> },
    #[event_version("1.0.0")]
    OwnerTransferred { old_owner: AccountId, new_owner: AccountId },
}
