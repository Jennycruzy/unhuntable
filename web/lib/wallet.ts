// The NEAR wallet, through wallet-selector (Meteor, HOT, MyNearWallet).
// The rest of the app talks to the small AppWallet interface below, so flows can be
// tested with an injected wallet. Transactions are handed over in the plain action form
// the API sends ({type, params}); wallet-selector wants near-api-js actions, so they are
// converted here, one to one, at the last step.
import type { PlainTransaction } from "./types";
import { NETWORK, NEAR_RPC } from "./config";

export interface SignedMessage {
  accountId: string;
  publicKey: string;
  /** base64 ed25519 signature over the NEP-413 hash */
  signature: string;
}

export interface AppWallet {
  readonly id: string;
  signIn(): Promise<{ accountId: string }>;
  /** NEP-413 sign; nonce is 32 bytes. */
  signMessage(p: { message: string; recipient: string; nonce: Uint8Array }): Promise<SignedMessage>;
  /** One wallet approval for one transaction; returns its hash. */
  signAndSendTransaction(tx: PlainTransaction): Promise<string>;
  /** One wallet approval for all transactions; returns their hashes in order. */
  signAndSendTransactions(txs: PlainTransaction[]): Promise<string[]>;
  signOut(): Promise<void>;
}

export class WalletRefused extends Error {
  constructor(message = "Your wallet did not approve. Nothing was signed.") {
    super(message);
    this.name = "WalletRefused";
  }
}

export const WALLETS = [
  { id: "meteor-wallet", name: "Meteor" },
  { id: "hot-wallet", name: "HOT" },
  { id: "my-near-wallet", name: "MyNearWallet" },
] as const;

export const TEST_WALLET_ID = "test-wallet";

/**
 * A test wallet the Playwright tests put on window before the page loads. It plugs into
 * wallet-selector as one more module, the same way a real wallet does. Nothing sets it
 * in a real browser: our pages run no inline scripts and load scripts only from our origin.
 */
export interface TestWalletHook {
  accountId: string;
  publicKey: string;
  signMessage(p: { message: string; recipient: string; nonce: number[] }): Promise<SignedMessage>;
  signAndSendTransactions(txs: { receiverId: string; actions: unknown[] }[]): Promise<string[]>;
}

declare global {
  interface Window {
    __unhuntableTestWallet?: TestWalletHook;
  }
}

function outcomeHash(o: unknown): string {
  const x = o as { transaction?: { hash?: string }; transaction_outcome?: { id?: string } } | undefined;
  const h = x?.transaction?.hash ?? x?.transaction_outcome?.id;
  if (typeof h !== "string") throw new Error("The wallet did not return a transaction hash.");
  return h;
}

export function isWrongNetwork(accountId: string): boolean {
  if (/^[0-9a-f]{64}$/.test(accountId) || /^0x[0-9a-f]{40}$/.test(accountId)) return false;
  return NETWORK === "mainnet" ? accountId.endsWith(".testnet") : !accountId.endsWith(".testnet");
}

type Selector = Awaited<ReturnType<typeof import("@near-wallet-selector/core").setupWalletSelector>>;
let selectorPromise: Promise<Selector> | undefined;

async function selector(): Promise<Selector> {
  if (!selectorPromise) {
    selectorPromise = (async () => {
      const { Buffer } = await import("buffer");
      const g = globalThis as { Buffer?: unknown };
      if (!g.Buffer) g.Buffer = Buffer;
      const core = await import("@near-wallet-selector/core");
      const [{ setupMeteorWallet }, { setupHotWallet }, { setupMyNearWallet }] = await Promise.all([
        import("@near-wallet-selector/meteor-wallet"),
        import("@near-wallet-selector/hot-wallet"),
        import("@near-wallet-selector/my-near-wallet"),
      ]);
      const modules: import("@near-wallet-selector/core").WalletModuleFactory[] = [setupMeteorWallet(), setupHotWallet(), setupMyNearWallet()];
      if (typeof window !== "undefined" && window.__unhuntableTestWallet) modules.push(setupTestWallet(core));
      return core.setupWalletSelector({
        network: NETWORK,
        fallbackRpcUrls: [NEAR_RPC],
        modules,
      });
    })();
  }
  return selectorPromise;
}

type Core = typeof import("@near-wallet-selector/core");

function setupTestWallet(core: Core): import("@near-wallet-selector/core").WalletModuleFactory {
  return async () => ({
    id: TEST_WALLET_ID,
    type: "injected",
    metadata: { name: "Test wallet", description: null, iconUrl: "", deprecated: false, available: true, downloadUrl: "" },
    init: async () => {
      const hook = () => window.__unhuntableTestWallet as TestWalletHook;
      const accounts = () => [{ accountId: hook().accountId, publicKey: hook().publicKey }];
      const send = async (txs: { receiverId?: string; actions: unknown[] }[]) => {
        const plain = txs.map((t) => ({ receiverId: t.receiverId ?? "", actions: t.actions.map((a) => core.najActionToInternal(a as never)) }));
        const hashes = await hook().signAndSendTransactions(plain);
        return hashes.map((hash) => ({ transaction: { hash } }));
      };
      return {
        signIn: async () => accounts(),
        signOut: async () => {},
        getAccounts: async () => accounts(),
        verifyOwner: async () => {
          throw new Error("not supported");
        },
        signMessage: async (p: { message: string; recipient: string; nonce: Uint8Array }) =>
          hook().signMessage({ message: p.message, recipient: p.recipient, nonce: Array.from(p.nonce) }),
        signAndSendTransaction: async (p: { receiverId?: string; actions: unknown[] }) => (await send([p]))[0],
        signAndSendTransactions: async (p: { transactions: { receiverId?: string; actions: unknown[] }[] }) => send(p.transactions),
        getPublicKey: async () => {
          throw new Error("not supported");
        },
        signNep413Message: async () => {
          throw new Error("not supported");
        },
        signTransaction: async () => {
          throw new Error("not supported");
        },
        signDelegateAction: async () => {
          throw new Error("not supported");
        },
      } as never;
    },
  });
}

/** True when the test wallet hook is present (Playwright only). */
export function testWalletPresent(): boolean {
  return typeof window !== "undefined" && !!window.__unhuntableTestWallet;
}

function refusedOr(e: unknown): Error {
  const m = e instanceof Error ? e.message : String(e ?? "");
  if (/reject|denied|cancel|closed|user/i.test(m)) return new WalletRefused();
  return e instanceof Error ? e : new Error(m || "The wallet stopped with an error.");
}

/** The wallet-selector wallet with this id, as an AppWallet. */
export async function connectWallet(id: string): Promise<AppWallet> {
  const s = await selector();
  const core = await import("@near-wallet-selector/core");
  const w = await s.wallet(id);
  return {
    id,
    async signIn() {
      try {
        const accounts = await w.signIn({} as never);
        const accountId = accounts?.[0]?.accountId;
        if (!accountId) throw new WalletRefused();
        return { accountId };
      } catch (e) {
        throw refusedOr(e);
      }
    },
    async signMessage(p) {
      if (!w.signMessage) throw new Error("This wallet cannot sign a sign-in message. Pick another wallet.");
      const { Buffer } = await import("buffer");
      let r;
      try {
        r = await w.signMessage({ message: p.message, recipient: p.recipient, nonce: Buffer.from(p.nonce) as never });
      } catch (e) {
        throw refusedOr(e);
      }
      if (!r || !r.signature) throw new WalletRefused();
      return { accountId: r.accountId, publicKey: r.publicKey, signature: r.signature };
    },
    async signAndSendTransaction(tx) {
      let out;
      try {
        out = await w.signAndSendTransaction({ receiverId: tx.receiverId, actions: tx.actions.map((a) => core.internalActionToNaj(a as never)) } as never);
      } catch (e) {
        throw refusedOr(e);
      }
      if (!out) throw new Error("The wallet did not return the transaction. Check your wallet's history.");
      return outcomeHash(out);
    },
    async signAndSendTransactions(txs) {
      const transactions = txs.map((t) => ({ receiverId: t.receiverId, actions: t.actions.map((a) => core.internalActionToNaj(a as never)) }));
      let out;
      try {
        out = await w.signAndSendTransactions({ transactions } as never);
      } catch (e) {
        throw refusedOr(e);
      }
      if (!Array.isArray(out)) throw new Error("The wallet did not return the transactions. Check your wallet's history.");
      return out.map(outcomeHash);
    },
    async signOut() {
      await w.signOut().catch(() => {});
    },
  };
}

/** The wallet chosen at sign-in, kept by wallet-selector in this browser. */
export async function currentWallet(): Promise<AppWallet | undefined> {
  const s = await selector();
  const id = s.store.getState().selectedWalletId;
  return id ? connectWallet(id) : undefined;
}
