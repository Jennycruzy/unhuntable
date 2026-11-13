// Exit without us: with only the 12 words and OutLayer's public API,
// find every wallet, close positions, bring the USDC into the private balance and send it
// to the user's own destination. Used by the command line tool and the static page in exit/.
//
// The words stay on the user's machine: only signatures made with the pieces key are sent.
// Network calls go only to OutLayer, Hyperliquid and a NEAR RPC.
//
// Pieces controlled by NEAR Chain Signatures are found from the same words: each piece key
// is checked on the signer contract. Their moves are signed here with the piece key and
// signed for Hyperliquid by NEAR's MPC network through the contract. A position on such a
// piece is closed with a fresh agent key made here and approved through the contract. A
// NEAR account named by the user relays those calls and pays their gas; it cannot change
// them.
import {
  asset,
  closeOrder,
  exchangeBody,
  HL_API,
  l1TypedData,
  spotSend,
  splitSignature,
  typedDataJson,
  usdClassTransfer,
  type TypedData,
  type Value,
} from "./hyperliquid.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import {
  MPC_SIGNER,
  SIGNER_CONTRACT,
  SIGN_GAS,
  addressFromDerivedKey,
  chainSigExchangeBody,
  chainSigPieceKey,
  ethAddress,
  mpcPath,
  pieceKeyArgs,
  readCounter,
  signArgs,
  signPieceAction,
  type ChainSigAction,
  type MpcAnswer,
} from "./chainsig.js";
import { NearRelay, RelayError } from "./neartx.js";
import { USDC_SPOT_TOKEN, XYZ_DEX, typedDataDigest } from "./hyperliquid.js";
import {
  DeterministicWalletError,
  OUTLAYER_API,
  OutLayerDeterministic,
  backupKeyFor,
  keyFromMnemonic,
  keyHash,
  GAP_LIMIT,
  ownerAccount,
  rediscover,
  type PiecesKey,
} from "./keys.js";

export const NEAR_RPC = "https://rpc.mainnet.near.org";
/** USDC on NEAR, the token of the private balance (6 decimals). */
export const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
/** Hyperliquid charges this much (USDC) to send to a new address. */
export const NEW_ADDRESS_FEE = 1;
export const MIN_SEND_USDC = 2;
export const CLOSE_SLIP = 0.03;

/** How the flow talks to the person running it. */
export interface ExitIO {
  /** Show one plain sentence. */
  say(message: string): void;
  /** Ask and wait for an answer. */
  ask(question: string): Promise<string>;
}

export interface Destination {
  /** OutLayer withdraw chain, such as "near" or "base". */
  chain: string;
  to: string;
}

export interface ExitOptions {
  words: string;
  destination: Destination;
  io: ExitIO;
  /** Hashes of our server's delegate keys; when given, the tool offers to revoke them. */
  serverKeyHashes?: string[];
  /** A NEAR account (and its ed25519 key) that pays gas for NEAR-controlled pieces' moves. */
  relay?: { account: string; key: string };
  /** The signer contract of NEAR-controlled pieces. */
  chainsigContract?: string;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  nearRpc?: string;
  outlayerUrl?: string;
  hyperliquidUrl?: string;
  pollEveryMs?: number;
  pollTries?: number;
}

export interface ExitResult {
  wallets: string[];
  closed: number;
  movedUsdc: string;
  withdrawal: { requestId: string; status: string; amountOut: string } | null;
  revoked: number;
}

/** The person chose to stop, or a step cannot go on. The message says why in plain words. */
export class ExitStopped extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExitStopped";
  }
}

// ------------------------------------------------------------ amounts

/** Decimal string → whole units at `decimals`, rounded down. */
export function toUnits(amount: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!m) throw new Error(`not an amount: ${amount}`);
  const frac = (m[2] ?? "").slice(0, decimals).padEnd(decimals, "0");
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac || "0");
}

/** Whole units → decimal string, trailing zeros trimmed. */
export function fromUnits(units: bigint, decimals: number): string {
  const s = units.toString().padStart(decimals + 1, "0");
  const int = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}

/** What to send from spot USDC: total minus Hyperliquid's 1 USDC new-address fee, floored to 8 decimals. */
export function sendableUsdc(spotTotal: string): bigint {
  return toUnits(spotTotal, 8) - BigInt(NEW_ADDRESS_FEE) * 10n ** 8n;
}

// ------------------------------------------------------------ the flow

interface Piece {
  label: string;
  wallet: OutLayerDeterministic;
  address?: string;
}

const yes = (a: string) => /^\s*y(es)?\s*$/i.test(a);
const stop = (a: string) => /^\s*(stop|no|n|q|quit)\s*$/i.test(a);

/** Space between OutLayer calls while looking for wallets, so OutLayer does not refuse them. */
export const PACE_MS = 250;

export async function runExit(o: ExitOptions): Promise<ExitResult> {
  const f = o.fetch ?? ((...a) => fetch(...a));
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const hl = (o.hyperliquidUrl ?? HL_API).replace(/\/+$/, "");
  const { io } = o;
  const result: ExitResult = { wallets: [], closed: 0, movedUsdc: "0", withdrawal: null, revoked: 0 };

  // ---- the key from the words
  let key: PiecesKey;
  try {
    key = keyFromMnemonic(o.words);
  } catch {
    throw new ExitStopped("Those are not 12 valid words. Check each word and their order.");
  }
  if (!o.destination.chain || !o.destination.to) throw new ExitStopped("Name where the money should go: a chain and an address.");

  const owner = ownerAccount(key);
  const wallet = (seed: string) => new OutLayerDeterministic({ key, account: owner, seed, fetch: f, baseUrl: o.outlayerUrl ?? OUTLAYER_API, now });

  const info = async (body: Record<string, unknown>): Promise<any> => {
    let res: Response;
    try {
      res = await f(`${hl}/info`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    } catch {
      throw new ExitStopped("Hyperliquid is not answering. Try again later.");
    }
    if (!res.ok) throw new ExitStopped(`Hyperliquid answered HTTP ${res.status} when asked for ${body.type}.`);
    return res.json();
  };

  /** One OutLayer call, spaced out, and tried again when OutLayer says it is getting too many. */
  const paced = async <T>(fn: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      await sleep(PACE_MS);
      try {
        return await fn();
      } catch (e) {
        if (e instanceof DeterministicWalletError && e.status === 429 && attempt < 6) {
          await sleep(2000 * (attempt + 1));
          continue;
        }
        throw e;
      }
    }
  };
  /**
   * OutLayer answers an address for any seed, used or not. A piece counts as yours once its
   * Hyperliquid account has ever moved money; the private balance always counts.
   */
  const used = async (seed: string, label: string): Promise<boolean> => {
    if (label === "balance") return paced(() => wallet(seed).exists());
    let addr: string;
    try {
      addr = await paced(() => wallet(seed).evmAddress());
    } catch (e) {
      if (e instanceof DeterministicWalletError && e.code !== "unreachable" && e.code !== "bad_reply" && e.status !== 429) return false;
      throw e;
    }
    const led = await info({ type: "userNonFundingLedgerUpdates", user: addr, startTime: 0 });
    return Array.isArray(led) && led.length > 0;
  };

  // ---- 1. find the wallets
  io.say("Looking for your wallets on OutLayer. This asks about each one in turn.");
  let found;
  try {
    found = await rediscover(owner, key, used);
  } catch (e) {
    if (e instanceof ExitStopped) throw e;
    throw new ExitStopped(`OutLayer is not answering (${(e as Error).message}). Try again later.`);
  }
  const balanceFound = found.find((w) => w.label === "balance");
  const pieces: Piece[] = found.filter((w) => w.label !== "balance").map((w) => ({ label: w.label, wallet: wallet(w.seed) }));
  result.wallets = found.map((w) => w.label);
  if (!balanceFound) throw new ExitStopped("No private-balance wallet was found for these words. Check each word and their order.");
  const balance = wallet(balanceFound.seed);
  io.say(`Found your private-balance wallet and ${pieces.length} piece wallet${pieces.length === 1 ? "" : "s"}.`);

  const post = async (body: unknown): Promise<any> => {
    let res: Response;
    try {
      res = await f(`${hl}/exchange`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    } catch {
      throw new ExitStopped("Hyperliquid is not answering. Nothing was sent. Try again later.");
    }
    const text = await res.text();
    let j: any;
    try {
      j = JSON.parse(text);
    } catch {
      throw new ExitStopped(`Hyperliquid answered HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    if (!res.ok || j?.status !== "ok") throw new ExitStopped(`Hyperliquid refused it: ${typeof j?.response === "string" ? j.response : text.slice(0, 200)}`);
    const statuses: any[] = j?.response?.data?.statuses ?? [];
    const err = statuses.find((s) => s && typeof s.error === "string");
    if (err) throw new ExitStopped(`Hyperliquid refused the order: ${err.error}`);
    return j;
  };

  /** Sign typed data with a piece wallet's own key, asking the person to switch EVM signing on if needed. */
  const signWith = async (p: Piece, td: TypedData): Promise<ReturnType<typeof splitSignature>> => {
    for (;;) {
      try {
        const r = await p.wallet.request<{ signature?: string }>("POST", "/wallet/v1/evm/sign-typed-data", { chain: "arbitrum", typed_data: typedDataJson(td) });
        if (typeof r.signature !== "string") throw new ExitStopped("OutLayer's signing answer has no signature.");
        return splitSignature(r.signature);
      } catch (e) {
        if (e instanceof DeterministicWalletError && e.code === "policy_denied") {
          io.say(
            `Wallet ${p.label} is not allowed to sign yet: its wallet policy has EVM signing switched off. ` +
              "Open app.outlayer.ai, go to Wallets, choose this wallet and switch EVM signing on in its policy.",
          );
          const a = await io.ask("When EVM signing is on, press Enter to try again, or type stop to end here.");
          if (stop(a)) throw new ExitStopped("Stopped before signing. Nothing was sent for this wallet.");
          continue;
        }
        if (e instanceof DeterministicWalletError) throw new ExitStopped(`OutLayer would not sign for wallet ${p.label}: ${e.message}`);
        throw e;
      }
    }
  };

  const privateUsdc = async (): Promise<bigint> => {
    const r = await balance.request<{ balances?: { token: string; balance: string }[] }>("GET", "/wallet/v1/confidential/balance");
    const b = (r.balances ?? []).find((x) => x.token === USDC_NEAR);
    return BigInt(b?.balance ?? "0");
  };

  // ---- 2 to 6. each piece wallet
  let moved = 0n;
  for (const p of pieces) {
    io.say(`Wallet ${p.label}: reading its Hyperliquid account.`);
    try {
      p.address = await p.wallet.evmAddress();
    } catch (e) {
      throw new ExitStopped(`Could not read the address of wallet ${p.label}: ${(e as Error).message}`);
    }
    let perp = await info({ type: "clearinghouseState", user: p.address });

    // close open positions
    const open = (perp?.assetPositions ?? []).map((x: any) => x.position).filter((x: any) => x && Number(x.szi) !== 0);
    if (open.length > 0) {
      const mids = await info({ type: "allMids" });
      for (const pos of open) {
        const a = asset(pos.coin);
        const mid = Number(mids?.[pos.coin]);
        if (!a) throw new ExitStopped(`Wallet ${p.label} holds ${pos.coin}, which this tool does not know how to close. Close it on Hyperliquid first.`);
        if (!(mid > 0)) throw new ExitStopped(`Hyperliquid gave no price for ${pos.coin}, so the position was left open. Try again in a moment.`);
        const action = closeOrder(a, Number(pos.szi), mid, CLOSE_SLIP);
        io.say(`Closing the ${pos.coin} position of ${Math.abs(Number(pos.szi))} with a reduce-only order 3% through the price ${mid}.`);
        const nonce = now();
        const sig = await signWith(p, l1TypedData(action, nonce));
        await post(exchangeBody(action, nonce, sig, true));
        result.closed += 1;
      }
      perp = await info({ type: "clearinghouseState", user: p.address });
      if ((perp?.assetPositions ?? []).some((x: any) => Number(x?.position?.szi) !== 0)) {
        throw new ExitStopped(`A position in wallet ${p.label} did not close fully, maybe because the price moved. Run the tool again.`);
      }
      io.say("Positions closed.");
    }

    // perp → spot, everything
    const withdrawable = String(perp?.withdrawable ?? "0");
    if (toUnits(withdrawable, 8) > 0n) {
      io.say(`Moving ${withdrawable} USDC from perps to spot.`);
      const t = usdClassTransfer(withdrawable, false, now());
      const sig = await signWith(p, t.typed);
      await post(exchangeBody(t.action as unknown as Value, t.nonce, sig, false));
    }

    // spot → private balance
    const spot = await info({ type: "spotClearinghouseState", user: p.address });
    const usdc = String((spot?.balances ?? []).find((b: any) => b.coin === "USDC")?.total ?? "0");
    const send = sendableUsdc(usdc);
    if (send < BigInt(MIN_SEND_USDC) * 10n ** 8n) {
      io.say(
        `Wallet ${p.label} has ${usdc} USDC on Hyperliquid. Hyperliquid charges 1 USDC to send to a new address, ` +
          `so less than ${MIN_SEND_USDC} USDC would arrive. It is too little to move, so it stays there.`,
      );
      continue;
    }
    const sendStr = fromUnits(send, 8);
    io.say(`Asking OutLayer for a deposit address for ${sendStr} USDC into your private balance.`);
    let deposit: { deposit_address?: string };
    try {
      deposit = await balance.request("POST", "/wallet/v1/confidential/deposit/cross-chain", { chain: "hypercore", token: "USDC", amount: send.toString() });
    } catch (e) {
      throw new ExitStopped(`OutLayer gave no deposit address: ${(e as Error).message}`);
    }
    const to = deposit.deposit_address;
    if (typeof to !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(to)) throw new ExitStopped("OutLayer's deposit address is not an address Hyperliquid can send to.");

    const before = await privateUsdc();
    io.say(`Sending ${sendStr} USDC from Hyperliquid to that deposit address (Hyperliquid keeps 1 USDC as its fee).`);
    const s = spotSend(to, sendStr, now());
    const sig = await signWith(p, s.typed);
    await post(exchangeBody(s.action as unknown as Value, s.nonce, sig, false));
    moved += send;

    io.say("Waiting for it to arrive in your private balance.");
    let arrived = false;
    for (let i = 0; i < (o.pollTries ?? 60); i++) {
      if ((await privateUsdc()) > before) {
        arrived = true;
        break;
      }
      await sleep(o.pollEveryMs ?? 10_000);
    }
    if (!arrived) throw new ExitStopped("The USDC was sent but has not reached your private balance yet. Run the tool again in a few minutes; it will pick up from there.");
    io.say("It arrived.");
  }

  // ---- NEAR-controlled pieces: found from the same words, moved through the signer contract
  moved += await nearPieces({ o, key, f, now, sleep, info, post, balance, privateUsdc, result });
  result.movedUsdc = fromUnits(moved, 8);

  // ---- 7. private balance → the destination
  const total = await privateUsdc();
  if (total === 0n) throw new ExitStopped("Your private balance holds no USDC, so there is nothing to send home.");
  const body = { chain: o.destination.chain, to: o.destination.to, amount: total.toString(), token: USDC_NEAR };
  for (;;) {
    try {
      const dry = await balance.request<{ amount_out?: string; time_estimate_seconds?: number }>("POST", "/wallet/v1/confidential/withdraw/dry-run", body);
      io.say(
        `Sending ${fromUnits(total, 6)} USDC to ${o.destination.to} on ${o.destination.chain}: about ${dry.amount_out ?? "?"} arrives ` +
          `(in that chain's units) in about ${dry.time_estimate_seconds ?? "?"} seconds.`,
      );
      if (!yes(await io.ask("Send it? Type yes to send, anything else to stop."))) throw new ExitStopped("Stopped before sending. Your USDC is in your private balance.");
      const w = await balance.request<{ request_id?: string; status?: string }>("POST", "/wallet/v1/confidential/withdraw", body);
      result.withdrawal = { requestId: String(w.request_id ?? ""), status: String(w.status ?? ""), amountOut: String(dry.amount_out ?? "") };
      io.say(`Sent. OutLayer request ${w.request_id} is ${w.status}.`);
      break;
    } catch (e) {
      if (e instanceof DeterministicWalletError && e.code === "policy_denied") {
        io.say(
          `Your private-balance wallet's policy refused this: ${e.message}. ` +
            `Open app.outlayer.ai, go to Wallets, choose the private-balance wallet and add ${o.destination.to} to its address whitelist.`,
        );
        const a = await io.ask("When it is added, press Enter to try again, or type stop to end here.");
        if (stop(a)) throw new ExitStopped("Stopped before sending. Your USDC is in your private balance.");
        continue;
      }
      if (e instanceof DeterministicWalletError) throw new ExitStopped(`OutLayer refused the withdrawal: ${e.message}`);
      throw e;
    }
  }

  // ---- 8. revoke our server's access
  const hashes = (o.serverKeyHashes ?? []).filter((h) => /^[0-9a-f]{64}$/.test(h));
  if (hashes.length === 0) {
    io.say("To also remove our server's access to your wallets, run this again with our server key hash.");
    return result;
  }
  if (!yes(await io.ask(`Remove our server's access to all ${found.length} wallets? Type yes to remove it.`))) return result;
  for (const w of found) {
    const ww = wallet(w.seed);
    for (const h of hashes) {
      try {
        await ww.revokeDelegateKey(h);
      } catch (e) {
        if (e instanceof DeterministicWalletError && e.code === "last_key") {
          // keep the wallet usable: add the backup key, then remove ours
          // Wallets made before the backup key was added at setup. OutLayer takes this only as PUT,
          // which a web page cannot send, so the page points to the terminal tool for it.
          try {
            await ww.addDelegateKey(keyHash(backupKeyFor(key, w.seed)));
          } catch (e2) {
            if (e2 instanceof DeterministicWalletError && e2.code === "unreachable") {
              throw new ExitStopped(
                `Wallet ${w.label} has only our key on it, and OutLayer does not let a web page add your backup key. Your money is already out. To remove our key too, run the terminal tool: cd client && npm ci, then cd .. && npx tsx exit/cli.ts`,
              );
            }
            throw e2;
          }
          await ww.revokeDelegateKey(h);
        } else if (e instanceof DeterministicWalletError && e.status === 404) {
          continue; // that key was not on this wallet
        } else {
          throw new ExitStopped(`Could not remove our server's key from wallet ${w.label}: ${(e as Error).message}`);
        }
      }
      result.revoked += 1;
    }
  }
  io.say(`Our server's access is removed from your wallets.`);
  return result;
}

// ------------------------------------------------------------ NEAR-controlled pieces

interface NearCtx {
  o: ExitOptions;
  key: PiecesKey;
  f: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  info: (body: Record<string, unknown>) => Promise<any>;
  post: (body: unknown) => Promise<any>;
  balance: OutLayerDeterministic;
  privateUsdc: () => Promise<bigint>;
  result: ExitResult;
}

async function nearView(f: typeof fetch, rpc: string, contract: string, method: string, args: Uint8Array): Promise<Uint8Array | null> {
  let j: any;
  try {
    const res = await f(rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "exit",
        method: "query",
        params: { request_type: "call_function", finality: "final", account_id: contract, method_name: method, args_base64: b64(args) },
      }),
    });
    j = await res.json();
  } catch {
    throw new ExitStopped("The NEAR RPC is not answering. Try again later.");
  }
  if (j?.error || j?.result?.error) return null;
  if (!Array.isArray(j?.result?.result)) throw new ExitStopped("The NEAR RPC gave an answer this tool does not understand.");
  return Uint8Array.from(j.result.result as number[]);
}

function b64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

/** Every NEAR-controlled piece of these words: its number, key and Hyperliquid account. */
export async function findNearPieces(f: typeof fetch, rpc: string, contract: string, key: PiecesKey, gap = GAP_LIMIT) {
  const found: { label: string; piece: PiecesKey; account: string }[] = [];
  let missing = 0;
  for (let n = 0; missing < gap; n++) {
    const piece = chainSigPieceKey(key, n);
    const c = await nearView(f, rpc, contract, "counter", pieceKeyArgs(piece.publicKey));
    if (!c || readCounter(c) === null) {
      missing += 1;
      continue;
    }
    missing = 0;
    const args = new TextEncoder().encode(JSON.stringify({ path: mpcPath(piece.publicKey), predecessor: contract, domain_id: 0 }));
    const d = await nearView(f, rpc, MPC_SIGNER, "derived_public_key", args);
    if (!d) throw new ExitStopped("NEAR's MPC network did not give a piece's account. Try again later.");
    found.push({ label: `piece:${n}`, piece, account: addressFromDerivedKey(JSON.parse(new TextDecoder().decode(d)) as string) });
  }
  return found;
}

async function nearPieces(c: NearCtx): Promise<bigint> {
  const o = c.o;
  const io = o.io;
  const rpc = c.o.nearRpc ?? NEAR_RPC;
  const contract = o.chainsigContract ?? SIGNER_CONTRACT;
  io.say(`Looking for NEAR-controlled pieces on ${contract}.`);
  const pieces = await findNearPieces(c.f, rpc, contract, c.key);
  if (pieces.length === 0) {
    io.say("No NEAR-controlled pieces.");
    return 0n;
  }
  io.say(`Found ${pieces.length} NEAR-controlled piece${pieces.length === 1 ? "" : "s"}. Their Hyperliquid accounts have no private key: NEAR's MPC network signs for them when the piece key approves.`);
  let relay: NearRelay | null = null;
  if (o.relay) {
    try {
      relay = new NearRelay(rpc, o.relay.account, o.relay.key, c.f);
    } catch (e) {
      throw new ExitStopped(`That relay key cannot be used: ${(e as Error).message}`);
    }
  }

  /** The piece key signs; the relay asks the contract; NEAR signs for Hyperliquid; checked, then posted. */
  const step = async (p: { piece: PiecesKey; account: string }, a: ChainSigAction): Promise<void> => {
    if (!relay) throw new ExitStopped("no relay");
    const cnt = await nearView(c.f, rpc, contract, "counter", pieceKeyArgs(p.piece.publicKey));
    const counter = cnt ? readCounter(cnt) : null;
    if (counter === null) throw new ExitStopped("The piece key is not on the signer contract any more.");
    const sig = signPieceAction(p.piece, contract, counter, a);
    let out;
    try {
      out = await relay.call(contract, "sign", signArgs(p.piece.publicKey, a, sig), BigInt(SIGN_GAS), 1n);
    } catch (e) {
      if (e instanceof RelayError) throw new ExitStopped(`NEAR did not sign it: ${e.message}`);
      throw e;
    }
    const mpc = JSON.parse(new TextDecoder().decode(out.value)) as MpcAnswer;
    await c.post(chainSigExchangeBody(a, mpc, p.account));
  };

  // Hyperliquid's own perps and trade.xyz (stocks) keep separate balances and positions.
  const read = async (account: string) => {
    const main = await c.info({ type: "clearinghouseState", user: account });
    const xyz = await c.info({ type: "clearinghouseState", user: account, dex: XYZ_DEX });
    const positions = [main, xyz].flatMap((st: any) => (st?.assetPositions ?? []).map((x: any) => x.position).filter((x: any) => x && Number(x.szi) !== 0));
    return { main, xyz, positions };
  };

  let moved = 0n;
  for (const p of pieces) {
    let st = await read(p.account);
    const spot0 = await c.info({ type: "spotClearinghouseState", user: p.account });
    const spotUsdc0 = String((spot0?.balances ?? []).find((b: any) => b.coin === "USDC")?.total ?? "0");
    const open = st.positions;
    const total =
      toUnits(String(st.main?.marginSummary?.accountValue ?? "0"), 8) + toUnits(String(st.xyz?.marginSummary?.accountValue ?? "0"), 8) + toUnits(spotUsdc0, 8);
    if (open.length === 0 && sendableUsdc(fromUnits(total, 8)) < BigInt(MIN_SEND_USDC) * 10n ** 8n) {
      io.say(`${p.label} (${p.account}) holds too little to move; it stays.`);
      continue;
    }
    if (!relay) {
      io.say(
        `${p.label} (${p.account}) holds money. Moving it needs a NEAR account to pay gas, about 0.01 NEAR per step. ` +
          "Run again and name one (any account works: it can only pass on what your piece key signed). This piece was left as it is.",
      );
      continue;
    }

    if (open.length > 0) {
      // a fresh agent key, made here, approved through the contract, used once to close
      const agentKey = secp256k1.utils.randomPrivateKey();
      const agent = ethAddress(secp256k1.getPublicKey(agentKey, false));
      io.say(`${p.label}: approving a one-time agent key made on this computer, so it can close the open position.`);
      await step(p, { kind: "approveAgent", agentAddress: agent, agentName: "", nonce: c.now() });
      const mids = { ...(await c.info({ type: "allMids" })), ...(await c.info({ type: "allMids", dex: XYZ_DEX })) };
      for (const pos of open) {
        const a = asset(pos.coin);
        const mid = Number(mids?.[pos.coin]);
        if (!a) throw new ExitStopped(`${p.label} holds ${pos.coin}, which this tool does not know how to close. Close it on Hyperliquid first.`);
        if (!(mid > 0)) throw new ExitStopped(`Hyperliquid gave no price for ${pos.coin}, so the position was left open. Try again in a moment.`);
        const action = closeOrder(a, Number(pos.szi), mid, CLOSE_SLIP);
        io.say(`Closing the ${pos.coin} position of ${Math.abs(Number(pos.szi))} with a reduce-only order 3% through the price ${mid}.`);
        const nonce = c.now();
        const s = secp256k1.sign(typedDataDigest(l1TypedData(action, nonce)), agentKey);
        const sig = { r: "0x" + s.r.toString(16).padStart(64, "0"), s: "0x" + s.s.toString(16).padStart(64, "0"), v: 27 + s.recovery };
        await c.post(exchangeBody(action, nonce, sig, true));
        c.result.closed += 1;
      }
      st = await read(p.account);
      if (st.positions.length > 0) {
        throw new ExitStopped(`A position on ${p.label} did not close fully, maybe because the price moved. Run the tool again.`);
      }
    }

    // trade.xyz -> Hyperliquid's own perps, inside the piece's own account
    const fromXyz = String(st.xyz?.withdrawable ?? "0");
    if (toUnits(fromXyz, 8) > 0n) {
      io.say(`${p.label}: moving ${fromXyz} USDC back from trade.xyz, signed by NEAR Chain Signatures.`);
      await step(p, { kind: "sendAsset", destination: p.account, sourceDex: XYZ_DEX, destinationDex: "", token: USDC_SPOT_TOKEN, amount: fromUnits(toUnits(fromXyz, 8), 8), nonce: c.now() });
      st = await read(p.account);
    }
    const perp = st.main;
    const withdrawable = String(perp?.withdrawable ?? "0");
    if (toUnits(withdrawable, 8) > 0n) {
      io.say(`${p.label}: moving ${withdrawable} USDC from perps to spot, signed by NEAR Chain Signatures.`);
      await step(p, { kind: "usdClassTransfer", amount: fromUnits(toUnits(withdrawable, 8), 8), toPerp: false, nonce: c.now() });
    }
    const spot = await c.info({ type: "spotClearinghouseState", user: p.account });
    const usdc = String((spot?.balances ?? []).find((b: any) => b.coin === "USDC")?.total ?? "0");
    const send = sendableUsdc(usdc);
    if (send < BigInt(MIN_SEND_USDC) * 10n ** 8n) {
      io.say(`${p.label} has ${usdc} USDC on spot; less than ${MIN_SEND_USDC} USDC would arrive, so it stays.`);
      continue;
    }
    const sendStr = fromUnits(send, 8);
    let deposit: { deposit_address?: string };
    try {
      deposit = await c.balance.request("POST", "/wallet/v1/confidential/deposit/cross-chain", { chain: "hypercore", token: "USDC", amount: send.toString() });
    } catch (e) {
      throw new ExitStopped(`OutLayer gave no deposit address: ${(e as Error).message}`);
    }
    const to = deposit.deposit_address;
    if (typeof to !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(to)) throw new ExitStopped("OutLayer's deposit address is not an address Hyperliquid can send to.");
    const before = await c.privateUsdc();
    io.say(`${p.label}: sending ${sendStr} USDC to your private balance's deposit address, signed by NEAR Chain Signatures (Hyperliquid keeps 1 USDC).`);
    await step(p, { kind: "spotSend", destination: to.toLowerCase(), token: USDC_SPOT_TOKEN, amount: sendStr, time: c.now() });
    moved += send;
    let arrived = false;
    for (let i = 0; i < (o.pollTries ?? 60); i++) {
      if ((await c.privateUsdc()) > before) {
        arrived = true;
        break;
      }
      await c.sleep(o.pollEveryMs ?? 10_000);
    }
    if (!arrived) throw new ExitStopped("The USDC was sent but has not reached your private balance yet. Run the tool again in a few minutes; it will pick up from there.");
    io.say("It arrived.");
  }
  return moved;
}
