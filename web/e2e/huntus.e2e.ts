import { expect, shot, test } from "./fixtures";

test("hunt us: one piece shown, a 90-second clock, then every piece with Hyperliquid's public facts", async ({ page, apiRequests }, info) => {
  await page.goto("/hunt-us/");
  await expect(page.locator("h1")).toHaveText("Hunt us");
  await expect(page.getByTestId("hunt-shown")).toContainText("ETH · one of 3 pieces");
  await expect(page.getByTestId("hunt-address")).toHaveText("0x" + "a1".repeat(20));
  await expect(page.getByTestId("hunt-address")).toHaveAttribute("href", "https://app.hyperliquid.xyz/explorer/address/0x" + "a1".repeat(20));
  // the rest is not asked for until the visitor starts and the time is up
  expect(apiRequests.some((r) => r.url.includes("/api/hunt-us/reveal"))).toBe(false);

  await page.getByRole("button", { name: "Start the 90 seconds" }).click();
  await expect(page.getByTestId("hunt-clock")).toBeVisible();
  await expect(page.getByTestId("hunt-headline")).toHaveText("3 separate accounts. No money ever moved between them, and no stop on the book.");
  const pieces = page.getByTestId("hunt-piece");
  await expect(pieces).toHaveCount(3);
  await expect(pieces.nth(1)).toContainText("Long $10");
  await expect(pieces.nth(1)).toContainText("2,061");
  await expect(pieces.nth(1)).toContainText("Funded by 0x6b9e…0a24, which sent money to at least 871 accounts in the last 6 hours");
  await shot(page, "hunt-us-reveal", info.project.name);
});

test("hunt us says so when no challenge is open", async ({ page, apiRequests, context }) => {
  void apiRequests;
  await context.addCookies([{ name: "scenario", value: "no_hunt", url: "http://127.0.0.1:4173" }]);
  await page.goto("/hunt-us/");
  await expect(page.getByText("No challenge position is open right now.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start the 90 seconds" })).toHaveCount(0);
});
