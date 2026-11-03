// Wallet API keys made by the server. Each key is "wk_" + 64 random hex characters, kept
// only inside this store, encrypted with AES-256-GCM under secrets.keystoreKey. The file
// must not be readable by group or others, same as the secrets file. Only the key's hash
// (keyHash from the client library) ever leaves the store.
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { keyHash } from "unhuntable-client";
import { ConfigError } from "./config.js";

export class KeyStoreError extends Error {
  constructor(
    /** unknown_request, already_confirmed or bad_file. */
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "KeyStoreError";
  }
}

interface Entry {
  owner: string;
  label: string;
  keyHash: string;
  walletId: string | null;
  iv: string;
  ct: string;
  tag: string;
  createdMs: number;
}

interface FileBody {
  entries: Record<string, Entry>;
}

export interface KeyInfo {
  requestId: string;
  owner: string;
  label: string;
  keyHash: string;
  walletId: string | null;
}

export interface KeyStoreOptions {
  /** Path of the file; leave out to keep keys only in memory (tests). */
  path?: string;
  /** 32 bytes hex. */
  key: string;
  now?: () => number;
}

export class KeyStore {
  private readonly key: Buffer;
  private readonly now: () => number;
  private body: FileBody = { entries: {} };

  constructor(private readonly opts: KeyStoreOptions) {
    if (!/^[0-9a-fA-F]{64}$/.test(opts.key)) throw new ConfigError("keystoreKey must be 32 bytes of hex");
    this.key = Buffer.from(opts.key, "hex");
    this.now = opts.now ?? Date.now;
    if (opts.path && existsSync(opts.path)) {
      const mode = statSync(opts.path).mode;
      if ((mode & 0o077) !== 0) {
        throw new ConfigError(`wallet key file ${opts.path} is readable by group or others; run chmod 600 on it`);
      }
      try {
        const raw = JSON.parse(readFileSync(opts.path, "utf8")) as FileBody;
        if (!raw || typeof raw.entries !== "object") throw new Error("shape");
        this.body = raw;
      } catch {
        throw new ConfigError(`wallet key file ${opts.path} is not a wallet key file`);
      }
    }
    // Printing the store never shows anything inside it.
    Object.defineProperty(this, "toJSON", { value: () => "[redacted]", enumerable: false });
    Object.defineProperty(this, Symbol.for("nodejs.util.inspect.custom"), { value: () => "[redacted]", enumerable: false });
  }

  private save(): void {
    if (!this.opts.path) return;
    const tmp = `${this.opts.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.body), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.opts.path);
  }

  private open(e: Entry, requestId: string): string {
    try {
      const d = createDecipheriv("aes-256-gcm", this.key, Buffer.from(e.iv, "hex"));
      d.setAAD(Buffer.from(requestId));
      d.setAuthTag(Buffer.from(e.tag, "hex"));
      return Buffer.concat([d.update(Buffer.from(e.ct, "hex")), d.final()]).toString("utf8");
    } catch {
      throw new KeyStoreError("bad_file", "A stored wallet key does not decrypt with this keystore key.");
    }
  }

  /** Make a fresh key for a wallet label. Returns only its request id and hash. */
  newWalletKey(label: string, owner = ""): { requestId: string; keyHash: string } {
    const apiKey = "wk_" + randomBytes(32).toString("hex");
    const requestId = randomUUID();
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    c.setAAD(Buffer.from(requestId));
    const ct = Buffer.concat([c.update(apiKey, "utf8"), c.final()]);
    const hash = keyHash(apiKey);
    this.body.entries[requestId] = {
      owner,
      label,
      keyHash: hash,
      walletId: null,
      iv: iv.toString("hex"),
      ct: ct.toString("hex"),
      tag: c.getAuthTag().toString("hex"),
      createdMs: this.now(),
    };
    this.save();
    return { requestId, keyHash: hash };
  }

  /** What is known about a request, without its key. */
  info(requestId: string): KeyInfo {
    const e = this.body.entries[requestId];
    if (!e) throw new KeyStoreError("unknown_request", "There is no wallet key request with this id.");
    return { requestId, owner: e.owner, label: e.label, keyHash: e.keyHash, walletId: e.walletId };
  }

  /** Run fn with the key of a request that is not confirmed yet (to prove it works). */
  async withRequestKey<T>(requestId: string, fn: (apiKey: string) => Promise<T>): Promise<T> {
    const e = this.body.entries[requestId];
    if (!e) throw new KeyStoreError("unknown_request", "There is no wallet key request with this id.");
    return fn(this.open(e, requestId));
  }

  /** Tie a request's key to the wallet it works for. */
  confirm(requestId: string, walletId: string): void {
    const e = this.body.entries[requestId];
    if (!e) throw new KeyStoreError("unknown_request", "There is no wallet key request with this id.");
    if (e.walletId && e.walletId !== walletId) throw new KeyStoreError("already_confirmed", "This key is already tied to another wallet.");
    e.walletId = walletId;
    this.save();
  }

  /** The key for a wallet id, or undefined. The newest confirmed key wins. */
  get(walletId: string): string | undefined {
    let best: [string, Entry] | undefined;
    for (const [id, e] of Object.entries(this.body.entries)) {
      if (e.walletId === walletId && (!best || e.createdMs >= best[1].createdMs)) best = [id, e];
    }
    return best ? this.open(best[1], best[0]) : undefined;
  }

  /** Every request, without keys. */
  list(): KeyInfo[] {
    return Object.keys(this.body.entries).map((id) => this.info(id));
  }

}
