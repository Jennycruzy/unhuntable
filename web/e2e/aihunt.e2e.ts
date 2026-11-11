import AxeBuilder from "@axe-core/playwright";
import { expect, shot, test } from "./fixtures";

test("the owner sends the NEAR AI hunter and sees what it named against the truth", async ({ page, apiRequests, signedIn }, info) => {
  // two accessibility scans; on a small build box under full load they need more time
  test.slow();
  await signedIn();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/positions/");
  const card = page.getByTestId("ai-hunter");
  await expect(card).toContainText("starts from one of your pieces");
  await card.getByTestId("ai-hunt-start").click();
  await expect(card.getByTestId("ai-hunt-running")).toContainText("about 3 minutes");
  await expect(card.getByTestId("ai-hunt-verdict")).toHaveText("Partly found. It named 1 of your 2 other pieces.", { timeout: 15_000 });
  await expect(card.getByTestId("ai-hunt-chance")).toHaveText("It named 1 of 15 accounts and 1 was yours. Naming 1 at random would find 0.13 on average.");
  const rows = card.getByTestId("ai-hunt-row");
  await expect(rows).toHaveCount(15);
  await expect(rows.nth(3)).toContainText("Your piece");
  await expect(rows.nth(3)).toContainText("Named 85%");
  await expect(rows.nth(3)).toContainText("Same payer, same $10 ETH open and close loops as T.");
  await expect(rows.nth(10)).toContainText("Your piece");
  await expect(rows.nth(10)).not.toContainText("Named");
  await expect(card.getByTestId("ai-hunt-guess")).toHaveText("It could not say what the whole position is.");
  await expect(card.getByTestId("ai-hunt-stop")).toHaveText("It could not tell");
  await expect(card.getByTestId("ai-hunt-proof")).toContainText("Signed inside NEAR AI's TEE");
  await expect(card.getByTestId("ai-hunt-proof")).toContainText("Qwen/Qwen3.6-35B-A3B-FP8 · 87d076fef7ef497c962261e3ca59e77d");
  await expect(card).toContainText("2 hunts left today");
  expect(apiRequests.some((r) => r.method === "POST" && r.url.endsWith("/api/positions/pos1/ai-hunt"))).toBe(true);

  const download = page.waitForEvent("download");
  await card.getByRole("button", { name: "Download the signed question and answer" }).click();
  expect((await download).suggestedFilename()).toBe("ai-hunt-11111111-2222-4333-8444-555555555555.json");
  await shot(page, "positions-ai-hunter", info.project.name);

  await page.locator("nav.nav").evaluate((n) => ((n as HTMLElement).style.position = "static"));
  for (const colorScheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    const bad = (await new AxeBuilder({ page }).include('[data-testid="ai-hunter"]').analyze()).violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(bad.map((v) => `${colorScheme} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  }
});

test("a finished hunt shows on load", async ({ page, apiRequests, signedIn }) => {
  void apiRequests;
  await signedIn("ai_done");
  await page.goto("/positions/");
  const card = page.getByTestId("ai-hunter");
  await expect(card.getByTestId("ai-hunt-verdict")).toHaveText("Partly found. It named 1 of your 2 other pieces.");
  await expect(card.getByTestId("ai-hunt-start")).toHaveText("Send the hunter again");
});

test("the day's limit is said plainly", async ({ page, apiRequests, signedIn }) => {
  void apiRequests;
  await signedIn("ai_limit");
  await page.goto("/positions/");
  const card = page.getByTestId("ai-hunter");
  await card.getByTestId("ai-hunt-start").click();
  await expect(card.getByTestId("ai-hunt-error")).toHaveText("You have used today's 3 AI hunts. More open in 24 hours.");
});

test("no hunter card when the server runs without the hunter", async ({ page, apiRequests, signedIn }) => {
  void apiRequests;
  await signedIn("ai_off");
  await page.goto("/positions/");
  await expect(page.getByTestId("hunter-view")).toBeVisible();
  await expect(page.getByTestId("ai-hunter")).toHaveCount(0);
});
