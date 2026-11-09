// A fake outside world for the money flow tests: OutLayer, NEAR RPC, Hyperliquid, the
// guard and Aurora (1Click), all behind one injected fetch. Every reply starts from a stored
// fixture (test/fixtures, each with the docs page it came from); tests change only values.
// No network.
import { boxOpen, boxPublic, CALL_AAD, keyHash, type Box } from "unhuntable-client";
import type { Ctx } from "../src/ctx.js";
import { hashToken } from "../src/auth.js";
import { newId, newShardId, type Db } from "../src/db.js";
import { GuardAdapter } from "../src/guard.js";
import { Hyperliquid } from "../src/hl.js";
import { JobRunner } from "../src/jobs.js";
import { KeyStore } from "../src/keystore.js";
import { NearRpc } from "../src/near.js";
import { OneClick } from "../src/oneclick.js";
import { OutLayerWallet } from "../src/outlayer.js";
import { registerMoneyJobs } from "../src/routes.js";
import { fixture, memoryDb } from "./helpers.js";

/** Throwaway guard box key: 0x33 repeated. */
export const BOX_SECRET = new Uint8Array(32).fill(0x33);
export const BOX_PUB = boxPublic(BOX_SECRET);
export const KEYSTORE_KEY = "44".repeat(32);
export const T0 = 1_800_000_000_000;

/** A fixture reply without its "source" field. */
export function reply(name: string): any {
  const { source: _s, ...rest } = fixture(name) as Record<string, unknown>;
  return JSON.parse(JSON.stringify(rest));
}

export interface Call {
  host: string;
  method: string;
  path: string;
  body: any;
  /** Wallet id the OutLayer call was made for (by its key). */
  walletId?: string;
  /** For guard calls: the opened inner JSON, or the outer input of a forward. */
  inner?: any;
  outer?: any;
}

interface Wallet {
  id: string;
  near: string;
  evm: string;
  pubkey: string;
}

export class World {
  calls: Call[] = [];
  /** OutLayer: key -> wallet. */
  keys = new Map<string, Wallet>();
  wallets = new Map<string, Wallet>();
  privateUnits = 100_000_000n;
  /** Wallet ids whose stored policy has evm_sign on. */
  evmOn = new Set<string>();
  /** Wallet ids with no stored policy (signing allowed). */
  noPolicy = new Set<string>();
  policyOwner = "alice.near";
  accessKeys = new Set<string>();
  perp = new Map<string, any>();
  spot = new Map<string, string>();
  mids: Record<string, string> = reply("hl-all-mids");
  guardOpen: string[] = [];
  guardClose: string[] = [];
  guardTick: any = null;
  guardDown = false;
  vrfHex = "ab".repeat(32);
  ocStatus = "PENDING_DEPOSIT";
  ocQuote: any = reply("oc-quote");
  ocQuoteStatus = 200;
  depositReply: any = reply("ol-deposit-cross-chain");
  depositStatus = 200;
  /** When a withdraw to an address happens, its perp account gains this much. */
  fundOnWithdraw = true;
  /** When a spotSend happens, the private balance grows by the sent amount. */
  arriveOnSend = true;
  /** Called for every withdraw before it answers. */
  onWithdraw?: (walletId: string, body: any) => void;

  addWallet(id: string, n: number): Wallet {
    const hex = n.toString(16).padStart(2, "0");
    const w = {
      id,
      near: hex.repeat(32),
      evm: "0x" + hex.repeat(20),
      pubkey: `ed25519:${hex.repeat(32)}`,
    };
    this.wallets.set(id, w);
    return w;
  }

  /** Give a wallet an API key the fake OutLayer accepts. */
  addKey(key: string, walletId: string): void {
    this.keys.set(key, this.wallets.get(walletId)!);
  }

  perpOf(addr: string): any {
    return this.perp.get(addr.toLowerCase()) ?? reply("hl-clearinghouse-empty");
  }

  setPerp(addr: string, accountValue: number, withdrawable = accountValue, positions: any[] = []): void {
    const p = reply("hl-clearinghouse-empty");
    p.marginSummary.accountValue = String(accountValue);
    p.crossMarginSummary.accountValue = String(accountValue);
    p.withdrawable = String(withdrawable);
    p.assetPositions = positions;
    this.perp.set(addr.toLowerCase(), p);
  }

  fetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    const headers = new Headers(init?.headers);
    const call: Call = { host: url.host, method, path: url.pathname + url.search, body };
    this.calls.push(call);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (url.host === "outlayer.test" && url.pathname.startsWith("/call/")) return this.guard(call, json);
    if (url.host === "outlayer.test") {
      const w = this.keys.get((headers.get("authorization") ?? "").replace(/^Bearer /, ""));
      if (!w) return json(reply("ol-key-refused"), 401);
      call.walletId = w.id;
      return this.outlayer(w, call, json);
    }
    if (url.host === "near.test") return this.near(body, json);
    if (url.host === "hl.test") return this.hl(call, json);
    if (url.host === "oneclick.test") {
      if (url.pathname === "/v0/quote") return json(this.ocQuote, this.ocQuoteStatus);
      const s = reply("oc-status-PENDING_DEPOSIT");
      s.status = this.ocStatus;
      return json(s);
    }
    throw new Error(`unexpected request to ${url.host}`);
  }) as typeof fetch;

  private outlayer(w: Wallet, call: Call, json: (b: unknown, s?: number) => Response): Response {
    const p = call.path;
    if (p.startsWith("/wallet/v1/address")) {
      const chain = new URL("http://x" + p).searchParams.get("chain");
      const a = reply(chain === "near" ? "ol-address-near" : "ol-address-base");
      a.wallet_id = w.id;
      a.address = chain === "near" ? w.near : w.evm;
      if (chain === "near") a.public_key = w.pubkey;
      return json(a);
    }
    if (p === "/wallet/v1/confidential/balance") {
      const b = reply("ol-balance");
      b.balances[0].balance = this.privateUnits.toString();
      return json(b);
    }
    if (p === "/wallet/v1/confidential/withdraw") {
      this.onWithdraw?.(w.id, call.body);
      if (this.fundOnWithdraw) {
        const to = String(call.body.to).toLowerCase();
        const cur = Number(this.perpOf(to).marginSummary.accountValue);
        const add = Number(call.body.amount) / 1e6 - 0.32;
        this.setPerp(to, cur + add, cur + add, this.perpOf(to).assetPositions);
        this.privateUnits -= BigInt(call.body.amount);
      }
      return json(reply("ol-withdraw"));
    }
    if (p === "/wallet/v1/confidential/deposit/cross-chain") {
      if (this.depositStatus !== 200) return json(reply("ol-deposit-too-low"), this.depositStatus);
      const d = { ...this.depositReply, amount: call.body.amount };
      return json(d);
    }
    if (p === "/wallet/v1/encrypt-policy") return json({ ...reply("ol-encrypt-policy"), wallet_pubkey: w.pubkey });
    if (p === "/wallet/v1/sign-policy") return json({ ...reply("ol-sign-policy"), wallet_pubkey: w.pubkey });
    if (p === "/wallet/v1/policy") {
      const r = reply(this.evmOn.has(w.id) ? "ol-policy-unlocked" : "ol-policy-locked");
      r.wallet_id = w.id;
      return json(r);
    }
    if (p === "/wallet/v1/evm/sign-typed-data") {
      if (!this.evmOn.has(w.id) && !this.noPolicy.has(w.id)) return json(reply("ol-sign-typed-data-locked"), 403);
      return json({ ...reply("ol-sign-typed-data"), wallet_id: w.id });
    }
    throw new Error(`unexpected OutLayer path ${p}`);
  }

  /** Answers NEAR view calls first when set (the chain-signature tests' fake contract). */
  nearHook?: (params: any) => unknown | undefined;
  /** Who signed a posted /exchange action, when it was not an OutLayer wallet. */
  exchangeSigner?: (body: any) => string | undefined;

  private near(body: any, json: (b: unknown, s?: number) => Response): Response {
    const params = body.params;
    const hooked = this.nearHook?.(params);
    if (hooked !== undefined) return json(hooked);
    if (params.request_type === "view_access_key") {
      return json(reply(this.accessKeys.has(`${params.account_id} ${params.public_key}`) ? "near-view-access-key" : "near-view-access-key-missing"));
    }
    const r = reply("near-call-function");
    const view = { ...reply("near-wallet-policy-view"), owner: this.policyOwner };
    r.result.result = [...Buffer.from(JSON.stringify(view))];
    return json(r);
  }

  private hl(call: Call, json: (b: unknown, s?: number) => Response): Response {
    if (call.path === "/exchange") {
      const a = call.body.action;
      const signer = this.exchangeSigner?.(call.body) ?? this.lastSigner;
      if (a.type === "usdClassTransfer") {
        const addr = signer ?? "";
        const p = this.perpOf(addr);
        this.setPerp(addr, 0, 0, p.assetPositions);
        this.spot.set(addr, String(Number(this.spot.get(addr) ?? "0") + Number(a.amount)));
      }
      if (a.type === "spotSend") {
        const addr = signer ?? "";
        this.spot.set(addr, "0");
        if (this.arriveOnSend) this.privateUnits += BigInt(Math.floor(Number(a.amount) * 1e6));
      }
      return json(reply("hl-exchange-ok"));
    }
    const b = call.body;
    if (b.type === "allMids") return json({ ...this.mids });
    if (b.type === "meta") return json(reply("hl-meta"));
    if (b.type === "clearinghouseState") return json(this.perpOf(b.user));
    if (b.type === "spotClearinghouseState") {
      const s = reply("hl-spot");
      s.balances[0].total = this.spot.get(String(b.user).toLowerCase()) ?? "0.0";
      return json(s);
    }
    throw new Error(`unexpected Hyperliquid info ${b.type}`);
  }

  /** Address of the last wallet that signed typed data (the piece whose action is posted next). */
  get lastSigner(): string | undefined {
    for (let i = this.calls.length - 1; i >= 0; i--) {
      const c = this.calls[i];
      if (c.path === "/wallet/v1/evm/sign-typed-data" && c.walletId) return this.wallets.get(c.walletId)!.evm;
    }
    return undefined;
  }

  private guard(call: Call, json: (b: unknown, s?: number) => Response): Response {
    if (this.guardDown) return new Response("bad gateway", { status: 502 });
    const input = call.body.input;
    if (input.op === "box_pub") return json({ output: { box_pub: BOX_PUB } });
    if (input.shard !== undefined) {
      call.outer = input;
      return json(reply("guard-sealed"));
    }
    const inner = JSON.parse(boxOpen(BOX_SECRET, input.box as Box, CALL_AAD).toString("utf8"));
    call.inner = inner;
    switch (inner.op) {
      case "agent":
        return json({ output: { ...reply("guard-agent").output, shard: inner.shard } });
      case "register":
        return json(reply("guard-register"));
      case "leverage":
        return json(reply("guard-leverage"));
      case "open": {
        const name = this.guardOpen.shift() ?? "guard-open";
        const r = reply(name);
        if (name === "guard-open") r.output.hl.body.response.data.statuses[0].filled.totalSz = String(inner.size);
        return json(r);
      }
      case "close":
        return json(reply(this.guardClose.shift() ?? "guard-close"));
      case "vrf":
        return json({ output: { ...reply("guard-vrf").output, output_hex: this.vrfHex, alpha: inner.label } });
      case "tick_coin":
        return json(this.guardTick ?? reply("guard-tick-coin"));
      case "defend":
        return json(reply("guard-sealed"));
    }
    throw new Error(`unexpected guard op ${inner.op}`);
  }

  ofHost(host: string): Call[] {
    return this.calls.filter((c) => c.host === host);
  }
}

export interface Harness {
  world: World;
  ctx: Ctx;
  db: Db;
  jobs: JobRunner;
  clock: { t: number };
  keystore: KeyStore;
}

export function harness(): Harness {
  const clock = { t: T0 };
  const now = () => clock.t;
  const db = memoryDb(now);
  const world = new World();
  const keystore = new KeyStore({ key: KEYSTORE_KEY, now });
  const jobs = new JobRunner(db, { network: "mainnet", now });
  const ctx: Ctx = {
    db,
    network: "mainnet",
    now,
    wallet: new OutLayerWallet({ baseUrl: "https://outlayer.test", walletKeys: {}, keystore, fetch: world.fetch }),
    keystore,
    near: new NearRpc("https://near.test", world.fetch),
    hl: new Hyperliquid("https://hl.test", world.fetch),
    oneClick: new OneClick("https://oneclick.test", "aurora-test-key", world.fetch),
    guard: new GuardAdapter({
      db,
      network: "mainnet",
      owner: "guard.near",
      project: "guard",
      paymentKey: "pk_" + "11".repeat(16),
      baseUrl: "https://outlayer.test",
      fetch: world.fetch,
      boxPub: BOX_PUB,
      now,
    }),
    jobs,
    policyContract: "outlayer.near",
    appFeeAccount: "fees.near",
    random: (n) => new Uint8Array(n).fill(0x5a),
  };
  registerMoneyJobs(jobs, ctx);
  return { world, ctx, db, jobs, clock, keystore };
}

/** A user with a session token. */
export function addUser(h: Harness, account = "alice.near"): { userId: string; cookie: string } {
  const userId = newId();
  const token = `token-${account}`;
  h.db.prepare("INSERT INTO users (id, near_account, created_ms, network) VALUES (?, ?, ?, 'mainnet')").run(userId, account, T0);
  h.db.prepare("INSERT INTO sessions (id, user_id, expires_ms, created_ms, network) VALUES (?, ?, ?, ?, 'mainnet')").run(hashToken(token), userId, T0 + 1e12, T0);
  return { userId, cookie: `sid=${token}` };
}

let walletN = 0x60;

/** A ready wallet (key in the store, row in pieces). state: the policy state to start in. */
export function addWallet(h: Harness, userId: string, label: string, state: "none" | "locked" = "locked", opts: { agent?: boolean } = {}) {
  const walletId = newId();
  const w = h.world.addWallet(walletId, walletN++);
  const { requestId, keyHash: kh } = h.keystore.newWalletKey(label, userId);
  h.keystore.confirm(requestId, walletId);
  // the fake OutLayer needs the plain key: read it back through the store
  void h.keystore.withRequestKey(requestId, async (k) => h.world.addKey(k, walletId));
  const kind = label === "balance" ? "balance" : "piece";
  const id = newId();
  const policy = kind === "balance" ? JSON.stringify({ rules: { addresses: { mode: "whitelist", list: [] } } }) : null;
  h.db
    .prepare(
      `INSERT INTO pieces (id, user_id, label, seed, kind, shard_id, wallet_id, wallet_pubkey, key_hash, hl_address, agent, policy_state, policy_json, created_ms, network)
       VALUES (?, ?, ?, 'unh-seed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'mainnet')`,
    )
    .run(
      id,
      userId,
      label,
      kind,
      kind === "piece" ? newShardId() : null,
      walletId,
      w.pubkey,
      kh,
      kind === "piece" ? w.evm : null,
      kind === "piece" && (opts.agent ?? state === "locked") ? "0x" + "55".repeat(20) : null,
      state,
      state === "locked" ? policy : null,
      h.clock.t,
    );
  if (state === "none") h.world.noPolicy.add(walletId);
  return { id, walletId, address: w.evm, keyHash: kh, pubkey: w.pubkey };
}

/** Advance the clock in steps, running due jobs after each. */
export async function runFor(h: Harness, ms: number, stepMs = 5_000): Promise<void> {
  const end = h.clock.t + ms;
  while (h.clock.t < end) {
    await h.jobs.runDue();
    h.clock.t = Math.min(end, h.clock.t + stepMs);
  }
  await h.jobs.runDue();
}

export { keyHash };
