import AxeBuilder from "@axe-core/playwright";
import { expect, shot, test } from "./fixtures";

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
  await signedIn();
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
  // the filled panel is readable in both colour schemes
  for (const colorScheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    const bad = (await new AxeBuilder({ page }).include('[data-testid="hunter-view"]').analyze()).violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(bad.map((v) => `${colorScheme} ${v.id}`)).toEqual([]);
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
