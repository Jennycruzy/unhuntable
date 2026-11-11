// Pieces controlled by NEAR Chain Signatures, in this browser.
//
// Each piece key comes from the 12 words and never leaves this page. Before the piece key
// signs anything, this page checks for itself:
//   - the contract is our signer contract (CHAINSIG_CONTRACT), not one the server names,
//   - the piece's Hyperliquid account is the one NEAR's MPC network derives for that
//     contract and key (asked from a public NEAR RPC, not from our server),
//   - the action is what this step is for: approving an agent (which cannot move money),
//     approving the builder fee (only the builder and the 0.01% rate the contract itself
//     names, read from a public NEAR RPC),
//     moving the piece's own USDC from its main balance onto trade.xyz (same account), or,
//     going home, trade.xyz -> main balance (same account), perps -> spot and a USDC send to
//     a deposit address of the user's own private balance that this page asked OutLayer for
//     itself.
import { BUILDER_FEE_RATE, MPC_SIGNER, addressFromDerivedKey, chainSigPieceKey, mpcPath, readBuilder, signPieceAction, type ChainSigAction } from "unhuntable-client/chainsig";
import { LADDER } from "unhuntable-client/planner";
import { USDC_SPOT_TOKEN, XYZ_DEX } from "unhuntable-client/hyperliquid";
import { OutLayerDeterministic, seedFor, type PiecesKey } from "unhuntable-client/keys";
import { bytesToHex } from "@noble/hashes/utils";
import type { Api, Fetch } from "./api";
import { CHAINSIG_CONTRACT, NEAR_VIEW_RPC } from "./config";
import type { HomeChainSigPlan, HomeStart } from "./types";

export interface ChainSigDeps {
  api: Api;
  key: PiecesKey;
  account: string;
  /** fetch for NEAR RPC and OutLayer (tests inject one). */
  outlayerFetch?: Fetch;
  now?: () => number;
}

export function pieceNumber(label: string): number {
  const m = /^piece:(\d+)$/.exec(label);
  if (!m) throw new Error(`${label} is not a piece`);
  return Number(m[1]);
}

/** The piece's Hyperliquid account, asked from NEAR's MPC network directly. */
export async function derivedAccount(f: Fetch, publicKey: Uint8Array, contract = CHAINSIG_CONTRACT): Promise<string> {
  const args = JSON.stringify({ path: mpcPath(publicKey), predecessor: contract, domain_id: 0 });
  const res = await f(NEAR_VIEW_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "unhuntable",
      method: "query",
      params: { request_type: "call_function", finality: "final", account_id: MPC_SIGNER, method_name: "derived_public_key", args_base64: btoa(args) },
    }),
  });
  const j = (await res.json()) as { result?: { result?: number[] } };
  const bytes = j.result?.result;
  if (!Array.isArray(bytes)) throw new Error("NEAR did not answer with the piece's account. Try again.");
  return addressFromDerivedKey(JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes))) as string);
}

/** The builder and rate the signer contract approves, asked from a public NEAR RPC; null when its fees are off. */
export async function contractBuilder(f: Fetch, contract = CHAINSIG_CONTRACT): Promise<{ builder: string; rate: string } | null> {
  const res = await f(NEAR_VIEW_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "unhuntable",
      method: "query",
      params: { request_type: "call_function", finality: "final", account_id: contract, method_name: "builder", args_base64: "" },
    }),
  });
  const j = (await res.json()) as { result?: { result?: number[] } };
  const bytes = j.result?.result;
  if (!Array.isArray(bytes)) return null;
  return readBuilder(Uint8Array.from(bytes));
}

/** Register one chain-signature piece and sign the guard's agent approval with its key. Returns its account. */
export async function setupChainSigPiece(d: ChainSigDeps, label: string): Promise<string> {
  const piece = chainSigPieceKey(d.key, pieceNumber(label));
  const r = await d.api.chainSigRegister(label, piece.publicKeyStr);
  if (r.contract !== CHAINSIG_CONTRACT) throw new Error(`The server named contract ${r.contract}; this app signs only for ${CHAINSIG_CONTRACT}. Nothing was signed.`);
  const mine = await derivedAccount(d.outlayerFetch ?? ((...a) => fetch(...a)), piece.publicKey);
  if (mine !== r.account) throw new Error("The piece's account the server reported is not the one NEAR derives. Nothing was signed.");
  let approveSig: string | null = null;
  if (r.approve) {
    const a = r.approve.action;
    if (a.kind !== "approveAgent" || !/^0x[0-9a-f]{40}$/.test(a.agentAddress) || a.agentName !== "") throw new Error("That is not an agent approval. Nothing was signed.");
    approveSig = bytesToHex(signPieceAction(piece, CHAINSIG_CONTRACT, r.approve.counter, a));
  }
  let moveSig: string | null = null;
  if (r.move) {
    const m = r.move.action;
    const ok =
      m.kind === "sendAsset" &&
      m.destination === mine &&
      m.sourceDex === "" &&
      m.destinationDex === XYZ_DEX &&
      m.token === USDC_SPOT_TOKEN &&
      Number(m.amount) > 0 &&
      Number(m.amount) <= LADDER[LADDER.length - 1] &&
      (!r.approve || r.move.counter === r.approve.counter + 1);
    if (!ok) throw new Error("That is not a move of this piece's own USDC onto trade.xyz. Nothing was signed.");
    moveSig = bytesToHex(signPieceAction(piece, CHAINSIG_CONTRACT, r.move.counter, m));
  }
  let builderSig: string | null = null;
  if (r.builder) {
    const b = r.builder.action;
    const ours = await contractBuilder(d.outlayerFetch ?? ((...a) => fetch(...a)));
    const last = r.move ?? r.approve;
    const ok =
      b.kind === "approveBuilderFee" &&
      ours !== null &&
      b.builder === ours.builder &&
      b.maxFeeRate === BUILDER_FEE_RATE &&
      ours.rate === BUILDER_FEE_RATE &&
      last !== null &&
      last !== undefined &&
      r.builder.counter === last.counter + 1;
    if (!ok) throw new Error("That is not the builder fee the signer contract allows. Nothing was signed.");
    builderSig = bytesToHex(signPieceAction(piece, CHAINSIG_CONTRACT, r.builder.counter, b));
  }
  if (approveSig || moveSig || builderSig) await d.api.chainSigApprove(label, approveSig, moveSig, builderSig);
  return r.account;
}

/** "11.5" -> "1150000000" (Hyperliquid USDC has 8 decimals). */
export function usdcUnits8(amount: string): string {
  const m = /^(\d+)(?:\.(\d{1,8}))?$/.exec(amount);
  if (!m) throw new Error(`${amount} is not a USDC amount`);
  return (BigInt(m[1]) * 10n ** 8n + BigInt((m[2] ?? "").padEnd(8, "0"))).toString();
}

/** A deposit address of the user's own private balance, asked from OutLayer by this page with the pieces key. */
export async function ownDepositAddress(d: ChainSigDeps, sendUsdc: string): Promise<string> {
  const balance = new OutLayerDeterministic({ key: d.key, account: d.account, seed: seedFor(d.key, "balance"), fetch: d.outlayerFetch, now: d.now });
  const r = await balance.request<{ deposit_address?: unknown }>("POST", "/wallet/v1/confidential/deposit/cross-chain", {
    chain: "hypercore",
    token: "USDC",
    amount: usdcUnits8(sendUsdc),
  });
  const to = r.deposit_address;
  if (typeof to !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error("OutLayer's deposit address is not an address Hyperliquid can send to.");
  return to.toLowerCase();
}

/** The piece key's signatures for going home: trade.xyz -> main (when there is any), perps -> spot (when there is any), then the send to a deposit address of our own. */
export async function signHome(d: ChainSigDeps, plan: HomeChainSigPlan) {
  if (plan.send === null) return null;
  const piece = chainSigPieceKey(d.key, pieceNumber(plan.label));
  const mine = await derivedAccount(d.outlayerFetch ?? ((...a) => fetch(...a)), piece.publicKey);
  if (mine !== plan.account) throw new Error("A piece's account is not the one NEAR derives. Nothing was signed.");
  const to = await ownDepositAddress(d, plan.send);
  const t = (d.now ?? Date.now)();
  const signed: { counter: number; action: ChainSigAction; signature: string }[] = [];
  let c = plan.counter;
  if (plan.fromXyz && plan.fromXyz !== "0") {
    const a: ChainSigAction = { kind: "sendAsset", destination: mine, sourceDex: XYZ_DEX, destinationDex: "", token: USDC_SPOT_TOKEN, amount: plan.fromXyz, nonce: t - 1 };
    signed.push({ counter: c, action: a, signature: bytesToHex(signPieceAction(piece, CHAINSIG_CONTRACT, c++, a)) });
  }
  if (plan.toSpot !== "0") {
    const a: ChainSigAction = { kind: "usdClassTransfer", amount: plan.toSpot, toPerp: false, nonce: t };
    signed.push({ counter: c, action: a, signature: bytesToHex(signPieceAction(piece, CHAINSIG_CONTRACT, c++, a)) });
  }
  const send: ChainSigAction = { kind: "spotSend", destination: to, token: USDC_SPOT_TOKEN, amount: plan.send, time: t + 1 };
  signed.push({ counter: c, action: send, signature: bytesToHex(signPieceAction(piece, CHAINSIG_CONTRACT, c, send)) });
  return { label: plan.label, signed };
}

/** Sign every chain-signature piece of a home that has money to move, and hand the signatures to the server. */
export async function signHomeAll(d: ChainSigDeps, start: HomeStart): Promise<number> {
  const pieces = [];
  for (const p of start.chainSig ?? []) {
    const s = await signHome(d, p);
    if (s) pieces.push(s);
  }
  if (pieces.length > 0) await d.api.homeChainSig(start.homeId, pieces);
  return pieces.length;
}
