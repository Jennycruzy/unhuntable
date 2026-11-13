import AxeBuilder from "@axe-core/playwright";
import { expect, restoreKey, shot, test } from "./fixtures";

test("guard unreachable shows the sentence and a Close now button", async ({ page, apiRequests, signedIn }, info) => {
  await signedIn("guard_down");
  await page.goto("/positions/");
  await expect(page.getByTestId("guard-unreachable")).toHaveText(
    "The guard isn't answering. Your positions are open on Hyperliquid; stops can't fire until it's back. You can close now.",
  );
  await shot(page, "positions-guard", info.project.name);
  await page.getByTestId("position").getByRole("button", { name: "Close now" }).click();
  await expect(page.getByText("Closing: Closing.")).toBeVisible();
  const close = apiRequests.find((r) => r.url.endsWith("/api/positions/pos1/close"))!;
  expect(JSON.parse(close.body!)).toEqual({ now: true });
});

test("positions show each piece and its alerts", async ({ page, apiRequests, signedIn }, info) => {
  void apiRequests;
  await signedIn();
  await page.goto("/positions/");
  await expect(page.getByTestId("piece")).toHaveCount(2);
  await expect(page.getByTestId("piece").first()).toContainText("24.0% away");
  await expect(page.getByTestId("piece").first()).toContainText("Watching");
  await expect(page.getByTestId("alerts")).toContainText("Both pieces are open.");
  await shot(page, "positions", info.project.name);
});

test("hunter's view puts what you see beside what Hyperliquid shows anyone", async ({ page, apiRequests, signedIn }, info) => {
  // two accessibility scans; on a small build box under full load they need more time
  test.slow();
  await signedIn();
  // no fade-ins while the contrast is measured
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/positions/");
  const view = page.getByTestId("hunter-view");
  await expect(view.getByTestId("hunter-you")).toContainText("Long $300.00 ETH");
  await expect(view.getByTestId("hunter-you")).toContainText("Stop");
  await expect(view.getByTestId("hunter-account")).toHaveCount(2);
  await expect(view.getByTestId("hunter-account").first()).toContainText("0xa1a1…a1a1");
  await expect(view.getByTestId("hunter-account").first()).toContainText("Long $150.53 · liquidation 2,501");
  await expect(view.getByTestId("hunter-account").first()).toContainText("No orders");
  await expect(view.getByTestId("hunter-account").first().getByRole("link")).toHaveAttribute(
    "href",
    "https://app.hyperliquid.xyz/explorer/address/0x" + "a1".repeat(20),
  );
  await expect(view.getByTestId("hunter-verdict")).toHaveText("Hyperliquid shows 2 separate accounts and no stop or take-profit on the book.");
  expect(apiRequests.some((r) => r.url.endsWith("/api/positions/pos1/hunter"))).toBe(true);
  await shot(page, "positions-hunter", info.project.name);
  // the filled panel is readable in both colour schemes; the phone's fixed tab bar is put in the
  // page flow first, so no row sits under it while the colours are measured
  await page.locator("nav.nav").evaluate((n) => ((n as HTMLElement).style.position = "static"));
  // measure the final colours, not a colour-scheme change halfway through its transition
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>("*")) {
      el.style.transition = "none";
      el.style.animation = "none";
    }
  });
  for (const colorScheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    const bad = (await new AxeBuilder({ page }).include('[data-testid="hunter-view"]').analyze()).violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(bad.map((v) => `${colorScheme} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  }
});

test("hunter's view says so when Hyperliquid cannot be read, and shows no made-up rows", async ({ page, apiRequests, signedIn }) => {
  void apiRequests;
  await signedIn("hunter_down");
  await page.goto("/positions/");
  const view = page.getByTestId("hunter-view");
  await expect(view.getByTestId("hunter-public")).toContainText("Hyperliquid's public data could not be read just now.");
  await expect(view.getByTestId("hunter-account")).toHaveCount(0);
  await expect(view.getByTestId("hunter-you")).toContainText("Long $300.00 ETH");
});

test("the owner switches auto-refill on with a daily limit", async ({ page, apiRequests, signedIn }, info) => {
  await signedIn();
  await page.goto("/positions/");
  const card = page.getByTestId("refills");
  await expect(card.getByLabel("Refill cut pieces")).not.toBeChecked();
  await card.getByLabel("Refill cut pieces").check();
  await card.getByLabel("Daily limit, in dollars").fill("40");
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card).toContainText("Auto-refill is on, up to $40.00 a day.");
  await expect(card.getByTestId("refilled-today")).toHaveText("Refilled today: $0.00 of $40.00");
  const sent = apiRequests.find((r) => r.method === "POST" && r.url.endsWith("/api/settings"))!;
  expect(JSON.parse(sent.body!)).toEqual({ autoRefill: true, refillCapUsdPerDay: 40 });
  await shot(page, "positions-refills", info.project.name);
});

test("a copy says whose trade it copies, and a first copy starts with one wallet approval", async ({ page, apiRequests, signedIn, walletCalls }) => {
  await signedIn("copy_wait");
  await restoreKey(page);
  await page.goto("/positions/");
  await expect(page.getByTestId("copy-of")).toHaveText("Copy of @alice_trades: it closes when theirs closes.");
  const start = page.getByTestId("start-copy");
  await expect(start).toContainText("Your copy of @alice_trades");
  await start.getByRole("button", { name: "Start my copy" }).click();
  await expect.poll(async () => (await walletCalls(page)).filter((c) => c.kind === "send").length).toBe(1);
  expect(apiRequests.some((r) => r.url.endsWith("/api/positions/pos2/continue"))).toBe(true);
  await expect.poll(() => apiRequests.some((r) => r.url.endsWith("/api/policy/confirm"))).toBe(true);
});

test("your own funded pieces waiting for their locks get an Approve button that signs once", async ({ page, apiRequests, signedIn, walletCalls }) => {
  await signedIn("lock_wait");
  await restoreKey(page);
  await page.goto("/positions/");
  const n = page.getByTestId("approve-locks");
  await expect(n).toContainText("Your ETH pieces are funded. Approve their locks in your wallet");
  await n.getByRole("button", { name: "Approve in my wallet" }).click();
  await expect.poll(async () => (await walletCalls(page)).filter((c) => c.kind === "send").length).toBe(1);
  expect(apiRequests.some((r) => r.url.endsWith("/api/positions/pos3/continue"))).toBe(true);
  await expect.poll(() => apiRequests.some((r) => r.url.endsWith("/api/policy/confirm"))).toBe(true);
});
