// Test helpers. No network: every request goes to a recording fetch that answers from a script.
import type { AppWallet } from "../lib/wallet";
import type { PlainTransaction } from "../lib/types";

export interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

type Answer = { status?: number; body: unknown } | ((s: Sent) => { status?: number; body: unknown });

/** A fetch that records each request and answers by matching "METHOD url-substring" in order. */
export function scriptedFetch(routes: [string, Answer][]) {
  const sent: Sent[] = [];
  const left = [...routes];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const s: Sent = {
      url: String(url),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? init.body : "",
    };
    sent.push(s);
    const i = left.findIndex(([m]) => {
      const [method, part] = m.split(" ");
      return method === s.method && s.url.includes(part);
    });
    if (i < 0) throw new Error(`unexpected request ${s.method} ${s.url}`);
    const [, a] = left.splice(i, 1)[0];
    const r = typeof a === "function" ? a(s) : a;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { fetch: f, sent, left };
}

/** A wallet that records what it is asked to sign. */
export function testWallet(account = "alice.near") {
  const calls: { kind: string; arg: unknown }[] = [];
  let n = 0;
  const w: AppWallet = {
    id: "test-wallet",
    async signIn() {
      calls.push({ kind: "signIn", arg: null });
      return { accountId: account };
    },
    async signMessage(p) {
      calls.push({ kind: "signMessage", arg: p });
      return { accountId: account, publicKey: "ed25519:11111111111111111111111111111111", signature: Buffer.alloc(64, 0x11).toString("base64") };
    },
    async signAndSendTransaction(tx: PlainTransaction) {
      calls.push({ kind: "signAndSendTransaction", arg: tx });
      return `hash${++n}`;
    },
    async signAndSendTransactions(txs: PlainTransaction[]) {
      calls.push({ kind: "signAndSendTransactions", arg: txs });
      return txs.map(() => `hash${++n}`);
    },
    async signOut() {},
  };
  return { wallet: w, calls };
}
