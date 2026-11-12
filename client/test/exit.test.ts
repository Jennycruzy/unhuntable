import { describe, expect, it } from "vitest";
import { ExitStopped, USDC_NEAR, fromUnits, runExit, sendableUsdc, toUnits, type ExitIO } from "../src/exit.js";
import { keyFromMnemonic, keyHash, ownerAccount, readAuthHeader, seedFor } from "../src/keys.js";
import { ed25519 } from "@noble/curves/ed25519";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToHex } from "@noble/hashes/utils";
import { base58 } from "@scure/base";
import { actionDigest, chainSigMessage, chainSigPieceKey, ethAddress, recoverSigner, type ChainSigAction } from "../src/chainsig.js";
import { USDC_SPOT_TOKEN, l1TypedData, typedDataDigest } from "../src/hyperliquid.js";

// Test-only phrase, never used for money.
const WORDS = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const KEY = keyFromMnemonic(WORDS);
const BALANCE_SEED = seedFor(KEY, "balance");
const PIECE_SEED = seedFor(KEY, "piece:0");
const PIECE_ADDR = "0x" + "11".repeat(20);
const DEPOSIT_ADDR = "0x" + "ab".repeat(20);
const SIG = "0x" + "11".repeat(32) + "22".repeat(32) + "1b";
const SERVER_KEY_HASH = keyHash("wk_" + "33".repeat(32));

interface World {
  /** sign-typed-data answers policy_denied this many times first */
  deniedSigns?: number;
  /** withdraw answers policy_denied this many times first */
  deniedWithdraws?: number;
  spotTotal?: string;
  lastKeyOnce?: boolean;
  /** PUT /wallet/v1/api-key fails like a web page's blocked request. */
  putBlocked?: boolean;
  /** No OutLayer piece wallet exists (only NEAR-controlled pieces). */
  noOutlayerPiece?: boolean;
  /** Answers NEAR RPC calls first when set (NEAR-controlled piece tests). */
  near?: (body: any) => unknown | undefined;
  /** The piece also holds a short NVDA position and 20 USDC on trade.xyz. */
  xyz?: boolean;
}

interface Call {
  method: string;
  url: string;
  auth?: string;
  body?: any;
}

/** A fake of OutLayer, Hyperliquid and NEAR RPC that answers in the shapes they use. No network. */
function world(w: World = {}) {
  const calls: Call[] = [];
  let open = true;
  let movedToSpot = false;
  let xyzOpen = w.xyz ?? false;
  let xyzBack = false;
  let privateBalance = 1_000_000n; // 1 USDC already there
  let denied = w.deniedSigns ?? 0;
  let deniedW = w.deniedWithdraws ?? 0;
  let lastKey = w.lastKeyOnce ?? false;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, auth: headers.Authorization, body });
    const seed = headers.Authorization ? readAuthHeader(headers.Authorization).seed : body?.seed;

    if (url === "https://rpc.test") {
      if (w.near) {
        const r = w.near(body);
        if (r !== undefined) return json(r);
      }
      // no NEAR-controlled pieces: the signer contract knows none of these keys
      if (body?.params?.request_type === "call_function") return json({ result: { result: [0], logs: [] } });
      return json({ result: { permission: "FullAccess", nonce: 1 } });
    }
    if (url.startsWith("https://api.hyperliquid.xyz/info")) {
      if (body.type === "allMids") return json(body.dex === "xyz" ? { "xyz:NVDA": "178.0" } : { ETH: "2000.0", BTC: "100000.0" });
      if (body.type === "clearinghouseState" && body.dex === "xyz") {
        if (!w.xyz) return json({ assetPositions: [], marginSummary: { accountValue: "0.0" }, withdrawable: "0.0" });
        return json({
          assetPositions: xyzOpen ? [{ type: "oneWay", position: { coin: "xyz:NVDA", szi: "-0.1", entryPx: "180.0" } }] : [],
          marginSummary: { accountValue: xyzBack ? "0.0" : "20.0" },
          withdrawable: xyzOpen || xyzBack ? "0.0" : "20.0",
        });
      }
      if (body.type === "clearinghouseState") {
        return json({
          assetPositions: open ? [{ type: "oneWay", position: { coin: "ETH", szi: "0.0125", entryPx: "1990.0" } }] : [],
          marginSummary: { accountValue: "25.5" },
          withdrawable: movedToSpot ? "0.0" : open ? "0.0" : xyzBack ? "45.5" : "25.5",
        });
      }
      if (body.type === "spotClearinghouseState") {
        return json({ balances: [{ coin: "USDC", token: 0, total: movedToSpot ? (w.spotTotal ?? "25.5") : "0.0", hold: "0.0" }] });
      }
    }
    if (url === "https://api.hyperliquid.xyz/exchange") {
      if (body.action.type === "order") {
        if (body.action.orders[0].a >= 110_000) xyzOpen = false;
        else open = false;
        return json({ status: "ok", response: { type: "order", data: { statuses: [{ filled: { totalSz: "0.0125", avgPx: "1999.5", oid: 1 } }] } } });
      }
      if (body.action.type === "usdClassTransfer") movedToSpot = true;
      if (body.action.type === "sendAsset") xyzBack = true;
      if (body.action.type === "spotSend") privateBalance += 24_500_000n;
      return json({ status: "ok", response: { type: "default" } });
    }
    if (url.startsWith("https://api.outlayer.ai/")) {
      const path = url.slice("https://api.outlayer.ai".length);
      if (path === "/wallet/v1/address?chain=base") {
        if (seed === BALANCE_SEED) return json({ wallet_id: "w-balance", chain: "base", address: "0x" + "22".repeat(20) });
        if (seed === PIECE_SEED && !w.noOutlayerPiece) return json({ wallet_id: "w-piece", chain: "base", address: PIECE_ADDR });
        return json({ error: "wallet_not_found", message: "Wallet not found" }, 404);
      }
      if (path === "/wallet/v1/evm/sign-typed-data") {
        if (denied > 0) {
          denied -= 1;
          return json({ error: "policy_denied", message: JSON.stringify({ error: "EVM signing is not enabled by policy (set capabilities.evm_sign.allowed = true)" }) }, 403);
        }
        return json({ signature: SIG, chain: "arbitrum", wallet_id: "w-piece" });
      }
      if (path === "/wallet/v1/confidential/deposit/cross-chain") {
        return json({ intent_id: "i-1", deposit_address: DEPOSIT_ADDR, amount: body.amount, amount_out: "24400000", min_amount_out: "24300000", expires_at: "x" });
      }
      if (path === "/wallet/v1/confidential/balance") {
        return json({ balances: [{ token: USDC_NEAR, balance: privateBalance.toString() }], account_id: "33".repeat(32) });
      }
      if (path === "/wallet/v1/confidential/withdraw/dry-run") return json({ amount_out: "25400000", min_amount_out: "25300000", time_estimate_seconds: 20 });
      if (path === "/wallet/v1/confidential/withdraw") {
        if (deniedW > 0) {
          deniedW -= 1;
          return json({ error: "policy_denied", message: `Address '${body.to}' is not in whitelist` }, 403);
        }
        return json({ request_id: "r-1", status: "pending_deposit", intent_hash: "h", deposit_address: "33".repeat(32) });
      }
      if (path.startsWith("/wallet/v1/api-key/") && method === "DELETE") {
        if (lastKey) {
          lastKey = false;
          return json({ error: "last_key", message: "Cannot revoke the last key" }, 409);
        }
        return json({});
      }
      if (path === "/wallet/v1/api-key" && method === "PUT") {
        if (w.putBlocked) throw new TypeError("Failed to fetch");
        return json({ wallet_id: "w", near_account_id: "n" });
      }
    }
    throw new Error(`unexpected request ${method} ${url}`);
  }) as typeof fetch;
  return { f, calls };
}

function io(answers: string[]) {
  const said: string[] = [];
  const asked: string[] = [];
  const io: ExitIO = {
    say: (m) => void said.push(m),
    ask: async (q) => {
      asked.push(q);
      const a = answers.shift();
      if (a === undefined) throw new Error(`unexpected question: ${q}`);
      return a;
    },
  };
  return { io, said, asked };
}

const base = (f: typeof fetch, i: ExitIO) => ({
  words: WORDS,
  destination: { chain: "near", to: "alice.near" },
  io: i,
  fetch: f,
  now: () => 1_800_000_000_000,
  sleep: async () => {},
  nearRpc: "https://rpc.test",
  pollTries: 5,
});

/** The money-moving steps, named, in the order they were sent. */
function steps(calls: Call[]): string[] {
  return calls.flatMap((c) => {
    if (c.url.endsWith("/exchange")) {
      const t = c.body.action.type;
      return [t === "order" ? "close order" : t === "usdClassTransfer" ? "class transfer" : t === "spotSend" ? "spot send" : t];
    }
    if (c.url.endsWith("/deposit/cross-chain")) return ["deposit quote"];
    if (c.url.endsWith("/withdraw/dry-run")) return ["withdraw dry-run"];
    if (c.url.endsWith("/confidential/withdraw")) return ["withdraw"];
    return [];
  });
}

describe("exit flow", () => {
  it("closes, moves to spot, deposits, sends and withdraws, in that order", async () => {
    const w = world();
    const t = io(["yes"]);
    const r = await runExit(base(w.f, t.io));
    expect(steps(w.calls)).toEqual(["close order", "class transfer", "deposit quote", "spot send", "withdraw dry-run", "withdraw"]);
    expect(r).toMatchObject({ wallets: ["balance", "piece:0"], closed: 1, movedUsdc: "24.5", withdrawal: { requestId: "r-1", amountOut: "25400000" } });

    const ex = w.calls.filter((c) => c.url.endsWith("/exchange")).map((c) => c.body);
    // reduce-only IOC sell 3% under the 2000 mid, the whole position, with vaultAddress null
    expect(ex[0].action).toEqual({
      type: "order",
      orders: [{ a: 1, b: false, p: "1940", s: "0.0125", r: true, t: { limit: { tif: "Ioc" } } }],
      grouping: "na",
    });
    expect(ex[0].vaultAddress).toBeNull();
    expect(ex[0].signature).toEqual({ r: "0x" + "11".repeat(32), s: "0x" + "22".repeat(32), v: 27 });
    // all perp USDC to spot
    expect(ex[1].action).toMatchObject({ type: "usdClassTransfer", amount: "25.5", toPerp: false, signatureChainId: "0x66eee", hyperliquidChain: "Mainnet" });
    expect("vaultAddress" in ex[1]).toBe(false);
    // spot total minus the 1 USDC new-address fee, to OutLayer's deposit address
    expect(ex[2].action).toMatchObject({ type: "spotSend", destination: DEPOSIT_ADDR, amount: "24.5", token: "USDC:0x6d1e7cde53ba9467b783cb7c530ce054" });

    const quote = w.calls.find((c) => c.url.endsWith("/deposit/cross-chain"))!;
    expect(quote.body).toEqual({ chain: "hypercore", token: "USDC", amount: "2450000000" });
    expect(readAuthHeader(quote.auth!).seed).toBe(BALANCE_SEED);
    const withdraw = w.calls.find((c) => c.url.endsWith("/confidential/withdraw"))!;
    expect(withdraw.body).toEqual({ chain: "near", to: "alice.near", amount: "25500000", token: USDC_NEAR });

    // signing went to the piece wallet, on arbitrum, with typed data
    const signs = w.calls.filter((c) => c.url.endsWith("/sign-typed-data"));
    expect(signs).toHaveLength(3);
    for (const s of signs) {
      expect(readAuthHeader(s.auth!).seed).toBe(PIECE_SEED);
      expect(s.body.chain).toBe("arbitrum");
    }
    expect(signs.map((s) => s.body.typed_data.primaryType)).toEqual(["Agent", "HyperliquidTransaction:UsdClassTransfer", "HyperliquidTransaction:SpotSend"]);
    expect(t.said.some((m) => m.includes("It arrived"))).toBe(true);
  });

  it("never sends the words or the private key anywhere", async () => {
    const w = world();
    await runExit(base(w.f, io(["yes"]).io));
    const all = JSON.stringify(w.calls);
    for (const word of new Set(WORDS.split(" "))) expect(all).not.toMatch(new RegExp(`\\b${word}\\b`));
    expect(all).not.toContain(KEY.secretKeyStr.slice(8));
    expect(all).not.toContain(Buffer.from(KEY.secret).toString("hex"));
    // only the three allowed hosts
    for (const c of w.calls) expect(new URL(c.url).host).toMatch(/^(api\.outlayer\.ai|api\.hyperliquid\.xyz|rpc\.test)$/);
  });

  it("policy_denied on signing asks the person to switch EVM signing on, and stops if they say stop", async () => {
    const w = world({ deniedSigns: 99 });
    const t = io(["stop"]);
    const err = await runExit(base(w.f, t.io)).catch((e) => e);
    expect(err).toBeInstanceOf(ExitStopped);
    expect(t.said.some((m) => m.includes("EVM signing switched off") && m.includes("app.outlayer.ai"))).toBe(true);
    expect(t.asked[0]).toMatch(/press Enter to try again/);
    expect(w.calls.filter((c) => c.url.endsWith("/exchange"))).toHaveLength(0);
    expect(steps(w.calls)).toEqual([]);
  });

  it("after the person switches signing on, it retries and goes on", async () => {
    const w = world({ deniedSigns: 1 });
    const t = io(["", "yes"]);
    await runExit(base(w.f, t.io));
    expect(steps(w.calls)).toEqual(["close order", "class transfer", "deposit quote", "spot send", "withdraw dry-run", "withdraw"]);
    expect(w.calls.filter((c) => c.url.endsWith("/sign-typed-data"))).toHaveLength(4);
  });

  it("a refused destination asks for the whitelist, then retries", async () => {
    const w = world({ deniedWithdraws: 1 });
    const t = io(["yes", "", "yes"]);
    await runExit(base(w.f, t.io));
    expect(t.said.some((m) => m.includes("whitelist") && m.includes("alice.near"))).toBe(true);
    expect(steps(w.calls).slice(-4)).toEqual(["withdraw dry-run", "withdraw", "withdraw dry-run", "withdraw"]);
  });

  it("refuses to move a piece with less than 2 USDC left after the fee, and says why", async () => {
    const w = world({ spotTotal: "2.9" });
    const t = io(["yes"]);
    await runExit(base(w.f, t.io));
    expect(steps(w.calls)).toEqual(["close order", "class transfer", "withdraw dry-run", "withdraw"]);
    expect(t.said.some((m) => m.includes("too little to move") && m.includes("1 USDC"))).toBe(true);
  });

  it("finds the wallets under the words' own implicit account, with no NEAR account asked", async () => {
    const w = world();
    await runExit(base(w.f, io(["yes"]).io));
    const outlayer = w.calls.filter((c) => c.url.startsWith("https://api.outlayer.ai/") && c.auth);
    expect(outlayer.length).toBeGreaterThan(0);
    for (const c of outlayer) expect(readAuthHeader(c.auth!).account_id).toBe(ownerAccount(KEY));
    expect(ownerAccount(KEY)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stops on bad words before any request", async () => {
    const w = world();
    await expect(runExit({ ...base(w.f, io([]).io), words: "one two three" })).rejects.toThrow(/not 12 valid words/);
    expect(w.calls).toHaveLength(0);
  });

  it("does not send without a yes", async () => {
    const w = world();
    await expect(runExit(base(w.f, io(["no"]).io))).rejects.toThrow(/Stopped before sending/);
    expect(steps(w.calls).at(-1)).toBe("withdraw dry-run");
  });

  it("removes our server's key from every wallet, adding the backup key where it is the last one", async () => {
    const w = world({ lastKeyOnce: true });
    const t = io(["yes", "yes"]);
    const r = await runExit({ ...base(w.f, t.io), serverKeyHashes: [SERVER_KEY_HASH] });
    expect(r.revoked).toBe(2);
    const keyCalls = w.calls.filter((c) => c.url.includes("/api-key"));
    expect(keyCalls.map((c) => c.method)).toEqual(["DELETE", "PUT", "DELETE", "DELETE"]);
    expect(keyCalls[0].url.endsWith(SERVER_KEY_HASH)).toBe(true);
    expect(keyCalls[1].body.key_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("exit flow on a web page", () => {
  it("points to the terminal tool when a wallet has only our key and the page cannot add the backup key", async () => {
    const w = world({ lastKeyOnce: true, putBlocked: true });
    const t = io(["yes", "yes"]);
    await expect(runExit({ ...base(w.f, t.io), serverKeyHashes: [SERVER_KEY_HASH] })).rejects.toThrow(/run the terminal tool: cd client && npm ci, then cd \.\. && npx tsx exit\/cli\.ts/);
  });
});

describe("amounts", () => {
  it("converts without floating point", () => {
    expect(toUnits("25.5", 8)).toBe(2_550_000_000n);
    expect(toUnits("0.123456789", 8)).toBe(12_345_678n);
    expect(fromUnits(2_450_000_000n, 8)).toBe("24.5");
    expect(fromUnits(5n, 8)).toBe("0.00000005");
    expect(sendableUsdc("13.45678901")).toBe(1_245_678_901n);
    expect(() => toUnits("1e5", 8)).toThrow();
  });
});

// ------------------------------------------------------------ NEAR-controlled pieces

describe("exit flow, NEAR-controlled pieces", () => {
  const key = keyFromMnemonic(WORDS);
  const piece = chainSigPieceKey(key, 0);
  const MPC = new Uint8Array(32).fill(0x42);
  const ACCOUNT_HL = ethAddress(secp256k1.getPublicKey(MPC, false));
  const RELAY_SECRET = "ed25519:99eUso3aSbE9tqGSTXzo3TLfKb9RkMTURrHKQ1K7Zh3StnzFNUx8FKCPPPPpR479qsw5zv2WNBKmgiz7WqgAJfM";

  function decodeAction(b: Uint8Array): { action: ChainSigAction; end: number } {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let o = 1;
    const str = () => {
      const n = dv.getUint32(o, true);
      const v = new TextDecoder().decode(b.subarray(o + 4, o + 4 + n));
      o += 4 + n;
      return v;
    };
    const u64 = () => {
      const v = Number(dv.getBigUint64(o, true));
      o += 8;
      return v;
    };
    if (b[0] === 0) return { action: { kind: "approveAgent", agentAddress: str(), agentName: str(), nonce: u64() }, end: o };
    if (b[0] === 1) {
      const amount = str();
      const toPerp = b[o++] === 1;
      return { action: { kind: "usdClassTransfer", amount, toPerp, nonce: u64() }, end: o };
    }
    if (b[0] === 2) return { action: { kind: "sendAsset", destination: str(), sourceDex: str(), destinationDex: str(), token: str(), amount: str(), nonce: u64() }, end: o };
    if (b[0] === 4) return { action: { kind: "spotSend", destination: str(), token: str(), amount: str(), time: u64() }, end: o };
    throw new Error(`tag ${b[0]}`);
  }

  /** The signer contract, v1.signer and the relay's NEAR RPC, faked the way they behave. */
  function nearFake() {
    let counter = 2;
    const signed: ChainSigAction[] = [];
    const near = (body: any): unknown | undefined => {
      const p = body?.params;
      if (body.method === "query" && p.request_type === "view_access_key" && p.account_id === "relay.near") {
        return { result: { nonce: 7, block_hash: base58.encode(new Uint8Array(32).fill(1)), permission: "FullAccess" } };
      }
      if (body.method === "query" && p.request_type === "call_function") {
        const args = Uint8Array.from(atob(p.args_base64), (c) => c.charCodeAt(0));
        if (p.account_id === "unhuntable.near" && p.method_name === "counter") {
          const mine = bytesToHex(args.subarray(5, 37)) === bytesToHex(piece.publicKey);
          if (!mine) return { result: { result: [0] } };
          const b = new Uint8Array(9);
          b[0] = 1;
          new DataView(b.buffer).setBigUint64(1, BigInt(counter), true);
          return { result: { result: [...b] } };
        }
        if (p.account_id === "v1.signer") {
          const a = JSON.parse(new TextDecoder().decode(args));
          expect(a).toEqual({ path: "u1/" + bytesToHex(piece.publicKey), predecessor: "unhuntable.near", domain_id: 0 });
          const pub = secp256k1.getPublicKey(MPC, false).subarray(1);
          return { result: { result: [...new TextEncoder().encode(JSON.stringify("secp256k1:" + base58.encode(pub)))] } };
        }
      }
      if (body.method === "send_tx") {
        const tx = Uint8Array.from(atob(p.signed_tx_base64), (c) => c.charCodeAt(0));
        const dv = new DataView(tx.buffer);
        let o = 0;
        const skipStr = () => (o += 4 + dv.getUint32(o, true));
        skipStr(); // signer
        o += 33 + 8; // key, nonce
        const recvLen = dv.getUint32(o, true);
        expect(new TextDecoder().decode(tx.subarray(o + 4, o + 4 + recvLen))).toBe("unhuntable.near");
        skipStr();
        o += 32 + 4 + 1; // block hash, actions count, FunctionCall tag
        skipStr(); // method
        const argsLen = dv.getUint32(o, true);
        const args = tx.subarray(o + 4, o + 4 + argsLen);
        const keyBytes = args.subarray(5, 37);
        const { action, end } = decodeAction(args.subarray(37));
        const sig = args.subarray(37 + end + 4, 37 + end + 4 + 64);
        const ok = ed25519.verify(sig, new TextEncoder().encode(chainSigMessage("unhuntable.near", keyBytes, counter, action)), keyBytes);
        if (!ok) return { result: { status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "the piece key did not sign this action" } } } } } } };
        counter += 1;
        signed.push(action);
        const s = secp256k1.sign(actionDigest(action), MPC);
        const mpc = { big_r: { affine_point: (s.recovery ? "03" : "02") + s.r.toString(16).padStart(64, "0") }, s: { scalar: s.s.toString(16).padStart(64, "0") }, recovery_id: s.recovery };
        return { result: { status: { SuccessValue: btoa(JSON.stringify(mpc)) } } };
      }
      return undefined;
    };
    return { near, signed };
  }

  it("finds the piece from the words, closes with a one-time agent, and brings the money home", async () => {
    const n = nearFake();
    const w = world({ noOutlayerPiece: true, near: n.near });
    const t = io(["yes"]);
    const r = await runExit({ ...base(w.f, t.io), relay: { account: "relay.near", key: RELAY_SECRET } });
    expect(steps(w.calls)).toEqual(["approveAgent", "close order", "class transfer", "deposit quote", "spot send", "withdraw dry-run", "withdraw"]);
    expect(n.signed.map((a) => a.kind)).toEqual(["approveAgent", "usdClassTransfer", "spotSend"]);
    expect(r).toMatchObject({ wallets: ["balance"], closed: 1, movedUsdc: "24.5" });

    const ex = w.calls.filter((c) => c.url.endsWith("/exchange")).map((c) => c.body);
    // the approval, the transfer and the send are signed by the piece's NEAR-derived account
    const digest = (a: any): Uint8Array =>
      actionDigest(
        a.type === "approveAgent"
          ? { kind: "approveAgent", agentAddress: a.agentAddress, agentName: a.agentName, nonce: a.nonce }
          : a.type === "usdClassTransfer"
            ? { kind: "usdClassTransfer", amount: a.amount, toPerp: a.toPerp, nonce: a.nonce }
            : { kind: "spotSend", destination: a.destination, token: a.token, amount: a.amount, time: a.time },
      );
    for (const i of [0, 2, 3]) expect(recoverSigner(digest(ex[i].action), ex[i].signature)).toBe(ACCOUNT_HL);
    // the close order is signed by the agent that was just approved, made on this computer
    const agent = ex[0].action.agentAddress;
    expect(recoverSigner(typedDataDigest(l1TypedData(ex[1].action, ex[1].nonce)), ex[1].signature)).toBe(agent);
    expect(ex[1].action.orders[0]).toMatchObject({ a: 1, b: false, r: true });
    expect(ex[3].action).toMatchObject({ destination: DEPOSIT_ADDR, amount: "24.5" });
    // the words and the piece key never left this computer
    const sent = JSON.stringify(w.calls);
    expect(sent).not.toContain(bytesToHex(piece.secret));
    for (const word of WORDS.split(" ")) expect(sent).not.toContain(`"${word}"`);
  });

  it("closes trade.xyz positions too and moves that money back to the main balance first", async () => {
    const n = nearFake();
    const w = world({ noOutlayerPiece: true, near: n.near, xyz: true, spotTotal: "45.5" });
    const t = io(["yes"]);
    const r = await runExit({ ...base(w.f, t.io), relay: { account: "relay.near", key: RELAY_SECRET } });
    expect(n.signed.map((a) => a.kind)).toEqual(["approveAgent", "sendAsset", "usdClassTransfer", "spotSend"]);
    expect(n.signed[1]).toMatchObject({ destination: ACCOUNT_HL, sourceDex: "xyz", destinationDex: "", token: USDC_SPOT_TOKEN, amount: "20" });
    expect(n.signed[2]).toMatchObject({ amount: "45.5", toPerp: false });
    const orders = w.calls.filter((c) => c.url.endsWith("/exchange") && c.body.action.type === "order").map((c) => c.body.action.orders[0]);
    // ETH sold, NVDA bought back on trade.xyz (asset 110002), both reduce-only
    expect(orders.map((o) => [o.a, o.b, o.r])).toEqual([
      [1, false, true],
      [110_002, true, true],
    ]);
    expect(r).toMatchObject({ closed: 2, movedUsdc: "44.5" });
  });

  it("without a relay, says what it needs and leaves the piece as it is", async () => {
    const n = nearFake();
    const w = world({ noOutlayerPiece: true, near: n.near });
    const t = io(["yes"]);
    await runExit(base(w.f, t.io));
    expect(n.signed).toEqual([]);
    expect(t.said.join(" ")).toMatch(/needs a NEAR account to pay gas/);
    expect(steps(w.calls)).toEqual(["withdraw dry-run", "withdraw"]);
  });
});
