import { expect, shot, test } from "./fixtures";

test("go home asks for exactly two approvals and keeps the relock banner until the relock is confirmed", async ({ page, apiRequests, signedIn, walletCalls }, info) => {
  await signedIn();
  await page.goto("/home/");
  await expect(page.getByTestId("exit-fee")).toHaveText("Leaving Hyperliquid costs about $1.20 per piece (Hyperliquid's new-account fee plus routing).");
  await expect(page.getByRole("link", { name: "Leave without us" })).toHaveAttribute("href", "/exit/index.html");
  await shot(page, "home", info.project.name);
  await page.getByRole("button", { name: "Send home" }).click();
  await expect(page.getByTestId("home-fee")).toHaveText("$2.40");
  await expect(page.getByTestId("unlock-summary")).toContainText("Piece 1: unlock");
  await expect(page.getByTestId("relock-banner")).toHaveCount(0);
  await page.getByRole("button", { name: "Approve in my wallet" }).click();

  await expect(page.getByTestId("relock-banner")).toBeVisible();
  await expect(page.getByTestId("relock-summary")).toBeVisible();
  // the banner stays on other screens until the relock is confirmed
  await page.goto("/positions/");
  await expect(page.getByTestId("relock-banner")).toBeVisible();
  await page.goto("/home/");
  await expect(page.getByTestId("home-steps")).toContainText("Sending to your private balance");
  await shot(page, "home-relock", info.project.name);
  await page.getByRole("button", { name: "Lock my pieces again" }).click();
  await expect(page.getByTestId("relocked")).toBeVisible();
  await expect(page.getByTestId("relock-banner")).toHaveCount(0);

  const sends = (await walletCalls(page)).filter((c) => c.kind === "send");
  expect(sends).toHaveLength(2);
  expect(JSON.stringify(sends[0].txs)).toContain('"locked":false');
  expect(JSON.stringify(sends[1].txs)).toContain('"locked":true');
  const confirms = apiRequests.filter((r) => r.url.endsWith("/api/policy/confirm")).map((r) => JSON.parse(r.body!));
  expect(confirms).toHaveLength(2);
  expect(confirms.every((c) => c.homeId === "home1" && c.txHashes.length === 1)).toBe(true);
});
