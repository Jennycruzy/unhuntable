// The shapes of our HTTP API. Amounts are decimal strings in USDC, times are unix milliseconds.
import type { Plan } from "unhuntable-client/planner";

export type Coin = "BTC" | "ETH" | "SOL";
export type Side = "long" | "short";
export type Hiding = "normal" | "whale";

export interface ApiFailure {
  error: string;
  message: string;
}

export interface Me {
  accountId: string;
  piecesKey: "missing" | "on_account";
  wallets: { label: string; kind: "balance" | "piece"; ready: boolean }[];
}

export interface WalletKey {
  requestId: string;
  keyHash: string;
}

export interface WalletConfirmed {
  ok: true;
  label: string;
  address: string;
}

export interface Balance {
  privateUsdc: string;
  pieces: { label: string; shard: string; perpUsd: string; spotUsd: string }[];
}

export type Route = "near" | "aurora";

export interface QuoteRequest {
  route: Route;
  chain: string;
  token: string;
  amount: string;
  refundTo: string;
}

export interface Quote {
  id: string;
  depositAddress: string;
  amountIn: string;
  amountOut: string;
  feeUsd: string;
  ourFeeBps: number;
  expiresMs: number;
  minAmount: string;
}

export type DepositStatus = "waiting" | "seen" | "done" | "refunded" | "expired";

export interface DepositState {
  id: string;
  status: DepositStatus;
  amountIn?: string;
  amountOut?: string;
}

export interface TradeRequest {
  coin: Coin;
  side: Side;
  notionalUsd: number;
  leverage: number;
  hiding: Hiding;
}

export interface PlanAnswer {
  plan: Plan;
  feesUsd: string;
  exitFeeUsd: string;
  world: { name: string; sizeUsd: string; side: Side }[];
  newPiecesNeeded: number;
}

/** One action in the plain form the API sends: wallet-selector's internal action shape. */
export interface PlainAction {
  type: string;
  params?: Record<string, unknown>;
}

export interface PlainTransaction {
  receiverId: string;
  actions: PlainAction[];
}

export interface PolicyBatch {
  summary: string[];
  transactions: PlainTransaction[];
}

export type PositionState = "planned" | "funding" | "policy_wait" | "opening" | "open" | "closing" | "closed" | "failed";

export interface PositionAnswer {
  positionId: string;
  state: PositionState;
  needWallets: string[];
  policyBatch: PolicyBatch | null;
}

export interface PolicyConfirmed {
  ok: true;
  locked: string[];
  unlocked: string[];
}

export interface PositionPiece {
  label: string;
  shard: string;
  size: number | string;
  entryPx: number | string | null;
  liqDistance: number | string | null;
  hasStop: boolean;
  hasTp: boolean;
  guard: "ok" | "unreachable";
}

export interface Alert {
  text: string;
  ms: number;
}

export interface Position {
  id: string;
  coin: Coin;
  side: Side;
  notionalUsd: number;
  leverage: number;
  hiding: Hiding;
  state: PositionState;
  createdMs: number;
  pieces: PositionPiece[];
  fillSavingsUsd?: string | number;
  alerts: Alert[];
}

export interface SealedBox {
  epk: string;
  nonce: string;
  ct: string;
}

export interface HomeStart {
  homeId: string;
  feeUsd: string;
  unlockBatch: PolicyBatch;
}

export type HomeStateName = "unlock_wait" | "moving" | "relock_wait" | "done" | "failed";

export interface HomeState {
  homeId: string;
  state: HomeStateName;
  steps: { label: string; step: string; status: string; ms: number }[];
  relockBatch: PolicyBatch | null;
  arrivedUsdc?: string;
}
