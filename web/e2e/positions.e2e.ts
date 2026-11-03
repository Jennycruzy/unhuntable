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
