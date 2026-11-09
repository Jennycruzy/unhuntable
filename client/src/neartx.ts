// A NEAR account that relays calls to the signer contract (unhuntable.near) and pays
// their gas. Relaying grants no power: the contract signs only what a piece key signed,
// so this account can make calls happen, never change what they say. Our server relays
// with its own account; the exit tool relays with any account the user names.
//
// Transactions are built and signed here (borsh, ed25519), so neither needs a NEAR SDK.
// fetch is injected so tests use stored replies only. Runs in Node and in browsers.
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { base58, base64 } from "@scure/base";

export class RelayError extends Error {
  constructor(
    message: string,
    /** True when the transaction may still have run (the RPC timed out). */
    readonly unknown = false,
    /** True when the transaction ran and the contract refused it: trying again will not help. */
    readonly refused = false,
  ) {
    super(message);
    this.name = "RelayError";
  }
}

export interface CallResult {
  txHash: string;
  /** The final SuccessValue bytes. */
  value: Uint8Array;
}

function cat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function uint(n: bigint, size: 8 | 16): Uint8Array {
  if (n < 0n || n >= 1n << BigInt(size * 8)) throw new Error("number out of range");
  const b = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    b[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return b;
}

function str(s: string): Uint8Array {
  const b = new TextEncoder().encode(s);
  return cat([u32(b.length), b]);
}

/** One FunctionCall transaction in NEAR's borsh layout. */
export function functionCallTx(t: {
  signerId: string;
  publicKey: Uint8Array;
  nonce: bigint;
  receiverId: string;
  blockHash: Uint8Array;
  method: string;
  args: Uint8Array;
  gas: bigint;
  deposit: bigint;
}): Uint8Array {
  if (t.publicKey.length !== 32 || t.blockHash.length !== 32) throw new Error("key and block hash must be 32 bytes");
  return cat([
    str(t.signerId),
    new Uint8Array([0]),
    t.publicKey,
    uint(t.nonce, 8),
    str(t.receiverId),
    t.blockHash,
    u32(1),
    new Uint8Array([2]),
    str(t.method),
    cat([u32(t.args.length), t.args]),
    uint(t.gas, 8),
    uint(t.deposit, 16),
  ]);
}

export function signTx(tx: Uint8Array, secret: Uint8Array): { signed: Uint8Array; hash: string } {
  const h = sha256(tx);
  return { signed: cat([tx, new Uint8Array([0]), ed25519.sign(h, secret)]), hash: base58.encode(h) };
}

/** "ed25519:<base58 of 64 bytes>" (seed ‖ public key), as NEAR key files hold it. */
export function readSecretKey(s: string): { secret: Uint8Array; publicKey: Uint8Array } {
  const m = /^ed25519:([1-9A-HJ-NP-Za-km-z]+)$/.exec(s);
  if (!m) throw new Error("relay key must be ed25519:<base58>");
  const raw = base58.decode(m[1]);
  if (raw.length !== 64 && raw.length !== 32) throw new Error("relay key must be 64 bytes");
  const secret = raw.slice(0, 32);
  const publicKey = ed25519.getPublicKey(secret);
  if (raw.length === 64 && base58.encode(raw.slice(32)) !== base58.encode(publicKey)) throw new Error("relay key's public half does not match");
  return { secret, publicKey };
}

export class NearRelay {
  private readonly f: typeof fetch;
  private readonly secret: Uint8Array;
  readonly publicKey: Uint8Array;
  /** One transaction at a time, so nonces never collide. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly url: string,
    readonly account: string,
    secretKey: string,
    f?: typeof fetch,
    private readonly pollMs = 2000,
    private readonly pollTries = 30,
  ) {
    const k = readSecretKey(secretKey);
    this.secret = k.secret;
    this.publicKey = k.publicKey;
    this.f = f ?? ((...a) => fetch(...a));
  }

  private async rpc(method: string, params: unknown): Promise<any> {
    let res: Response;
    try {
      res = await this.f(this.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "unhuntable", method, params }) });
    } catch {
      throw new RelayError("NEAR RPC did not answer.", method === "send_tx");
    }
    let j: any;
    try {
      j = await res.json();
    } catch {
      throw new RelayError(`NEAR RPC answered HTTP ${res.status} with a body that is not JSON.`, method === "send_tx");
    }
    if (j?.error) {
      const name = String(j.error?.cause?.name ?? j.error?.name ?? "");
      const timeout = name === "TIMEOUT_ERROR" || name === "TimeoutError";
      throw new RelayError(`NEAR RPC refused it: ${name || String(j.error?.message ?? "error")}`, timeout);
    }
    return j?.result;
  }

  /** Call a contract method with borsh args; waits for the final result. */
  call(receiverId: string, method: string, args: Uint8Array, gas: bigint, deposit: bigint): Promise<CallResult> {
    const run = this.queue.then(() => this.send(receiverId, method, args, gas, deposit));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async send(receiverId: string, method: string, args: Uint8Array, gas: bigint, deposit: bigint): Promise<CallResult> {
    const pk = "ed25519:" + base58.encode(this.publicKey);
    const key = await this.rpc("query", { request_type: "view_access_key", finality: "final", account_id: this.account, public_key: pk });
    if (typeof key?.nonce !== "number" || typeof key?.block_hash !== "string") throw new RelayError("NEAR RPC gave no nonce for the relay key.");
    const tx = functionCallTx({
      signerId: this.account,
      publicKey: this.publicKey,
      nonce: BigInt(key.nonce) + 1n,
      receiverId,
      blockHash: base58.decode(key.block_hash),
      method,
      args,
      gas,
      deposit,
    });
    const { signed, hash } = signTx(tx, this.secret);
    let out: any;
    try {
      out = await this.rpc("send_tx", { signed_tx_base64: base64.encode(signed), wait_until: "FINAL" });
    } catch (e) {
      if (!(e instanceof RelayError) || !e.unknown) throw e;
      out = await this.waitFor(hash);
    }
    return this.outcome(hash, out);
  }

  private async waitFor(hash: string): Promise<any> {
    for (let i = 0; i < this.pollTries; i++) {
      await new Promise((r) => setTimeout(r, this.pollMs));
      try {
        const out = await this.rpc("tx", { tx_hash: hash, sender_account_id: this.account, wait_until: "FINAL" });
        if (out?.status) return out;
      } catch {
        // not there yet
      }
    }
    throw new RelayError(`NEAR transaction ${hash} has no final result yet.`, true);
  }

  private outcome(hash: string, out: any): CallResult {
    const st = out?.status;
    if (st && typeof st.SuccessValue === "string") return { txHash: hash, value: base64.decode(st.SuccessValue) };
    const failure = st?.Failure;
    const exec = failure?.ActionError?.kind?.FunctionCallError?.ExecutionError;
    throw new RelayError(typeof exec === "string" ? exec : `NEAR transaction ${hash} failed.`, false, true);
  }
}
