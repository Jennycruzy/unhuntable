// This device's own records, in IndexedDB: the pieces key and the stop and take-profit levels.
// Each record is encrypted with AES-GCM under a key WebCrypto makes non-extractable, so the
// raw key can't be read back out of the browser, only used here. Nothing here is ever sent.
import { keyFromSecret, type PiecesKey } from "unhuntable-client/keys";

const DB = "unhuntable";
const STORE = "kv";
const AES = "aes-key";

interface Sealed {
  iv: Uint8Array;
  ct: ArrayBuffer;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = run(t.objectStore(STORE));
      t.oncomplete = () => resolve(req.result as T);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

const get = <T>(k: string) => tx<T | undefined>("readonly", (s) => s.get(k));
const put = (k: string, v: unknown) => tx<unknown>("readwrite", (s) => s.put(v, k));
const del = (k: string) => tx<unknown>("readwrite", (s) => s.delete(k));

async function aesKey(): Promise<CryptoKey> {
  const have = await get<CryptoKey>(AES);
  if (have) return have;
  const k = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  await put(AES, k);
  return k;
}

async function seal(name: string, plainIn: Uint8Array): Promise<void> {
  const plain = new Uint8Array(plainIn);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(name) }, await aesKey(), plain);
  await put(name, { iv, ct } satisfies Sealed);
}

async function unseal(name: string): Promise<Uint8Array | undefined> {
  const s = await get<Sealed>(name);
  if (!s) return undefined;
  const key = await get<CryptoKey>(AES);
  if (!key) return undefined;
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(s.iv), additionalData: new TextEncoder().encode(name) }, key, s.ct);
  return new Uint8Array(pt);
}

const piecesName = (account: string) => `pieces:${account}`;
const recordName = (account: string) => `record:${account}`;

export async function savePiecesKey(account: string, key: PiecesKey): Promise<void> {
  await seal(piecesName(account), key.secret);
}

export async function loadPiecesKey(account: string): Promise<PiecesKey | undefined> {
  const secret = await unseal(piecesName(account));
  return secret ? keyFromSecret(secret) : undefined;
}

/** Forget the pieces key on this device. The 12 words bring it back. */
export async function forgetPiecesKey(account: string): Promise<void> {
  await del(piecesName(account));
}

/** Levels per position and shard, and each piece's Hyperliquid account. */
export interface DeviceRecord {
  levels: Record<string, Record<string, { stop?: number; tp?: number; jitterBps?: number }>>;
  addresses: Record<string, string>;
  /** Levels chosen at confirm, kept until the position opens and they are sealed. */
  waitingLevels: Record<string, { stop?: number; tp?: number; jitterBps?: number }>;
}

export async function loadRecord(account: string): Promise<DeviceRecord> {
  const b = await unseal(recordName(account));
  const r = b ? (JSON.parse(new TextDecoder().decode(b)) as Partial<DeviceRecord>) : {};
  return { levels: r.levels ?? {}, addresses: r.addresses ?? {}, waitingLevels: r.waitingLevels ?? {} };
}

export async function updateRecord(account: string, change: (r: DeviceRecord) => void): Promise<DeviceRecord> {
  const r = await loadRecord(account);
  change(r);
  await seal(recordName(account), new TextEncoder().encode(JSON.stringify(r)));
  return r;
}
