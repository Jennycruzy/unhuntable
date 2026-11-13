import { expect, shot, test } from "./fixtures";

test("judge mode: a code opens a real trade, the stop is sealed in the browser, the public view shows no stop, and it closes", async ({ page, apiRequests }, info) => {
  await page.goto("/judge/");
  await expect(page.locator("h1")).toHaveText("Open a real trade");
  await expect(page.getByTestId("judge-open")).toBeDisabled();

  await page.getByTestId("judge-code").fill("wrong");
  await page.getByTestId("judge-open").click();
  await expect(page.getByText("That judge code is not right.")).toBeVisible();

  await page.getByTestId("judge-code").fill("judge-code");
  await page.getByRole("radiogroup", { name: "Side" }).getByRole("radio", { name: "Short" }).check();
  await page.getByTestId("judge-open").click();
  await expect(page.getByTestId("judge-run")).toContainText("Short $15.00 ETH at 2x");
  // a short with the default 2% stop: 3000 * 1.02
  await expect(page.getByTestId("judge-stop")).toContainText("Your stop at 3,060 is sealed", { timeout: 15_000 });
  await expect(page.getByTestId("judge-clock")).toContainText("Closes by itself in");
  // the level never travels: the stop call carries only sealed boxes
  const stop = apiRequests.find((r) => r.url.endsWith("/api/judge/stop"));
  expect(stop).toBeTruthy();
  expect(stop!.body).not.toContain("3060");
  await expect(page.getByTestId("hunter-verdict")).toHaveText("Hyperliquid shows one account and no stop or take-profit on the book.");
  await shot(page, "judge-open", info.project.name);

  await page.getByTestId("judge-close").click();
  await expect(page.getByTestId("judge-step")).toHaveText("Closed on Hyperliquid.");
  await expect(page.getByTestId("judge-result")).toContainText("Result");
});

test("judge mode says so when another judge trade is running", async ({ page, context, apiRequests }) => {
  void apiRequests;
  await context.addCookies([{ name: "scenario", value: "judge_busy", url: "http://127.0.0.1:4173" }]);
  await page.goto("/judge/");
  await page.getByTestId("judge-code").fill("judge-code");
  await expect(page.getByText("Another judge trade is running.")).toBeVisible();
  await expect(page.getByTestId("judge-open")).toBeDisabled();
});
