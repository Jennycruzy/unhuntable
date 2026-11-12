// The shapes of our HTTP API. Amounts are decimal strings in USDC, times are unix milliseconds.
import type { Plan } from "unhuntable-client/planner";

/** Hyperliquid's market name: "BTC", "ETH", "SOL", or trade.xyz's "xyz:NVDA" and so on. */
export type Coin = string;
export type Side = "long" | "short";
export type Hiding = "normal" | "whale";

export interface ApiFailure {
  error: string;
  message: string;
}

export interface Me {
  accountId: string;
  piecesKey: "missing" | "set";
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

/** GET /api/hunt-map: the visible liquidation prices of the largest Hyperliquid accounts. */
export interface MapLevel {
  account: string;
  side: "long" | "short";
  valueUsd: number;
  liqPx: number;
  /** Distance from the price as a signed percent: below the price is negative. */
  awayPct: number;
  leverage: number | null;
}

export interface MapCoin {
  coin: string;
  markPx: number;
  usd: number;
  bands: { pct: number; usd: number; count: number }[];
  nearest: MapLevel[];
}

export interface HuntTouch {
  account: string;
  coin: string;
  side: "long" | "short";
  valueUsd: number;
  liqPx: number;
  seenPx: number;
  seenMs: number;
  touchedMs: number;
  cameBack: boolean;
}

/** A real liquidation of a tracked account, with five-minute candles around it. */
export interface Replay {
  account: string;
  coin: string;
  side: "long" | "short";
  valueUsd: number;
  px: number;
  ms: number;
  beforePx: number;
  afterPx: number;
  extremePx: number;
  cameBack: boolean;
  candles: { t: number; h: number; l: number; c: number }[];
}

export interface HuntMap {
  asOfMs: number;
  sinceMs: number;
  rounds: number;
  accounts: number;
  positions: number;
  usd: number;
  stops: number;
  coins: MapCoin[];
  followed: { levels: number; reached: number; mirrorReached: number; cameBack: number };
  touches: HuntTouch[];
  replays?: { days: number; minUsd: number; events: number; cameBack: number; items: Replay[] };
}

/** GET /api/whale: a public Hyperliquid position, read from Hyperliquid's own API. */
export interface Whale {
  address: string;
  coin: string;
  side: "long" | "short";
  sizeUsd: number;
  entryPx: number;
  liqPx: number;
  markPx: number;
  stopPx: number | null;
  asOfMs: number;
}

/** GET /api/positions/{id}/hunter: one piece's account as Hyperliquid's public API shows it. */
export interface PublicAccount {
  address: string;
  /** Null when the account holds nothing in this market. */
  side: Side | null;
  size: number | null;
  valueUsd: number | null;
  entryPx: number | null;
  liqPx: number | null;
  leverage: number | null;
  restingOrders: number;
  triggerPxs: number[];
}

export interface HunterView {
  asOfMs: number;
  coin: Coin;
  markPx: number | null;
  accounts: PublicAccount[];
}

/** GET /api/positions/{id}/ai-hunt: the NEAR AI hunter's latest try at this position. */
export interface AiHuntLineupEntry {
  label: string;
  address: string;
  /** One of the owner's own pieces. The model was never told. */
  yours: boolean;
}

export interface AiHuntAnswer {
  picks: { label: string; confidence: number | null; why: string }[];
  combined: { side: string | null; usd: number | null };
  stopGuess: number | null;
  stopWhy: string;
  summary: string;
}

export interface AiHuntScore {
  verdict: "held" | "partly" | "caught";
  found: number;
  pieces: number;
  wrong: number;
  lineup: number;
  chanceHits: number;
}

export interface AiHuntProof {
  model: string;
  chatId: string;
  requestSha256: string;
  responseSha256: string;
  signed: { text: string; signature: string; signingAddress: string } | null;
  checks: { hashesMatch: boolean; signatureValid: boolean; inAttestation: boolean };
}

export interface AiHunt {
  id: string;
  state: "running" | "done" | "failed";
  createdMs: number;
  doneMs: number | null;
  error: string | null;
  lineup: AiHuntLineupEntry[] | null;
  answer: AiHuntAnswer | null;
  score: AiHuntScore | null;
  proof: AiHuntProof | null;
  truth: { side: Side; usd: number };
  hunts: { today: number; perDay: number };
}

/** GET /api/hunt-us */
export interface HuntUsChallenge {
  coin: string;
  count: number;
  shown: string;
  seconds: number;
}

/** GET /api/hunt-us/reveal: every piece as Hyperliquid's public API shows it. */
export interface HuntUsReveal {
  coin: string;
  asOfMs: number;
  pieces: (PublicAccount & { fundedBy: string | null; fundedAtMs: number | null; payerAccounts: number | null })[];
  restingOrders: number;
  sendsBetweenPieces: number;
  payerWindowHours: number;
}

/** GET and POST /api/settings */
export interface Settings {
  autoRefill: boolean;
  refillCapUsdPerDay: number;
  refilledTodayUsd: number;
}

/** POST /api/agents: the key is in this answer only. */
export interface NewAgentKey {
  id: string;
  key: string;
  name: string;
}

/** GET /api/agents */
export interface AgentKeys {
  keys: {
    id: string;
    name: string;
    maxNotionalUsd: number;
    coins: string[];
    dailyOpens: number;
    createdMs: number;
    revoked: boolean;
    calls: number;
    paidCalls: number;
    recent: { op: string; result: string; paidTx: string | null; ms: number }[];
  }[];
  /** Price of one agent call in USDC, or null when calls are free. */
  price: string | null;
  payTo: string | null;
  network: string | null;
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
  /** The builder fee on opening, when it is on: rate "0.01%" and the most it can be, in dollars. */
  builderFee?: { rate: string; usd: string } | null;
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
  /** Pieces controlled by NEAR Chain Signatures whose key this browser must register and sign for. */
  needChainSig: string[];
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
  /** True when NEAR Chain Signatures control this piece's Hyperliquid account. */
  nearControlled?: boolean;
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
  /** NEAR-controlled pieces whose key must sign again in this browser. */
  needChainSig?: string[];
  fillSavingsUsd?: string | number;
  alerts: Alert[];
}

export interface SealedBox {
  epk: string;
  nonce: string;
  ct: string;
}

export interface HomeChainSigPlan {
  label: string;
  account: string;
  counter: number;
  /** USDC to move back from trade.xyz first ("0" when none). */
  fromXyz?: string;
  toSpot: string;
  send: string | null;
}

export interface HomeStart {
  homeId: string;
  feeUsd: string;
  /** Null when every piece is controlled by NEAR Chain Signatures (nothing to unlock). */
  unlockBatch: PolicyBatch | null;
  chainSig: HomeChainSigPlan[];
}

export type HomeStateName = "unlock_wait" | "moving" | "relock_wait" | "done" | "failed";

export interface HomeState {
  homeId: string;
  state: HomeStateName;
  steps: { label: string; step: string; status: string; ms: number }[];
  relockBatch: PolicyBatch | null;
  needChainSig?: boolean;
  arrivedUsdc?: string;
}
