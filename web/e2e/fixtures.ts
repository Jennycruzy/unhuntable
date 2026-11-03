import { test as base, expect, type Page, type Request } from "@playwright/test";

export const ORIGIN = "http://127.0.0.1:4173";
/** The BIP39 test phrase: a throwaway key, never used for money. */
export const TEST_WORDS = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

export interface Seen {
  url: string;
  method: string;
  body: string | null;
  headers: Record<string, string>;
}

type Fixtures = {
  /** Every request the page made to our API. */
  apiRequests: Seen[];
  /** Requests to anywhere but the local test server; they are blocked. */
  outside: string[];
  signedIn: (scenario?: string) => Promise<void>;
  walletCalls: (page: Page) => Promise<{ kind: string; p?: unknown; txs?: unknown }[]>;
};

export const test = base.extend<Fixtures>({
  outside: async ({}, use) => {
    await use([]);
  },
  apiRequests: async ({ context, outside }, use) => {
    const seen: Seen[] = [];
    // No test touches the real network: everything that is not the local test server is blocked.
    await context.route("**/*", (route) => {
      const url = route.request().url();
      if (url.startsWith(ORIGIN + "/") || url === ORIGIN) return route.continue();
      outside.push(url);
      return route.abort("blockedbyclient");
    });
    context.on("request", (r: Request) => {
      if (r.url().startsWith(ORIGIN + "/api/")) seen.push({ url: r.url(), method: r.method(), body: r.postData(), headers: r.headers() });
    });
    await context.addInitScript(() => {
      const w = window as unknown as Record<string, unknown>;
      // kept in sessionStorage so calls are counted across page loads in one test
      const load = (): unknown[] => JSON.parse(sessionStorage.getItem("__walletCalls") ?? "[]");
      const record = (c: unknown) => {
        const all = load();
        all.push(c);
        sessionStorage.setItem("__walletCalls", JSON.stringify(all));
        return all.length;
      };
      const publicKey = "ed25519:11111111111111111111111111111111";
      w.__unhuntableTestWallet = {
        accountId: "alice.near",
        publicKey,
        async signMessage(p: unknown) {
          record({ kind: "signMessage", p });
          return { accountId: "alice.near", publicKey, signature: btoa(String.fromCharCode(...new Array(64).fill(17))) };
        },
        async signAndSendTransactions(txs: unknown[]) {
          const n = record({ kind: "send", txs });
          return txs.map((_, i) => `tx${n}x${i}`);
        },
      };
    });
    await use(seen);
  },
  signedIn: async ({ context }, use) => {
    await use(async (scenario = "ok") => {
      const sid = "t" + Math.random().toString(36).slice(2);
      await context.addCookies([
        { name: "sid", value: sid, url: ORIGIN },
        { name: "scenario", value: scenario, url: ORIGIN },
      ]);
      await context.addInitScript(() => {
        try {
          localStorage.setItem("near-wallet-selector:selectedWalletId", JSON.stringify("test-wallet"));
        } catch {
          // storage blocked; the test then fails at the wallet step
        }
      });
    });
  },
  walletCalls: async ({}, use) => {
    await use(async (page) => page.evaluate(() => JSON.parse(sessionStorage.getItem("__walletCalls") ?? "[]")));
  },
});

export { expect };

/** Save a screenshot of the screen at phone width for the pull request. */
export async function shot(page: Page, name: string, projectName: string) {
  if (projectName !== "phone") return;
  // The nav is fixed to the bottom; in a full-page shot it goes to the end of the page instead.
  // (Playwright's own screenshot style option is blocked by our CSP, so this sets it in the DOM.)
  const nav = page.locator("nav.nav");
  await nav.evaluate((n) => ((n as HTMLElement).style.position = "static"));
  await page.screenshot({ path: `screenshots/${name}.png`, fullPage: true });
  await nav.evaluate((n) => ((n as HTMLElement).style.position = ""));
}

/** Put the throwaway pieces key on this device through the restore screen. */
export async function restoreKey(page: Page) {
  await page.goto("/setup/");
  await page.getByRole("button", { name: "Restore from 12 words" }).click();
  await page.getByTestId("restore").fill(TEST_WORDS);
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.getByText("Your pieces key is back on this device.")).toBeVisible();
}
