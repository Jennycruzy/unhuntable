import { expect, restoreKey, shot, test } from "./fixtures";

const STOP = "2987.65";

test("review shows the plan, confirm sends the policy batch in one approval and seals the stop", async ({ page, apiRequests, signedIn, walletCalls }, info) => {
  await signedIn();
  await restoreKey(page);
  await page.goto("/trade/");
  await page.getByRole("radio", { name: "ETH" }).check();
  await page.getByLabel("Size", { exact: true }).fill("300");
  await page.getByRole("radio", { name: "Several" }).check();
  await page.getByText("Invisible stop", { exact: true }).click();
  await page.getByLabel("Stop price").fill(STOP);
  await shot(page, "trade", info.project.name);
  await page.getByRole("button", { name: "Review" }).click();

  const review = page.getByTestId("review");
  await expect(review.getByRole("heading", { name: "2 pieces" })).toBeVisible();
  await expect(page.getByTestId("review-piece").nth(0)).toContainText("0.0456 ETH");
  await expect(page.getByTestId("review-piece").nth(0)).toContainText("$150.25");
  await expect(page.getByTestId("review-piece").nth(1)).toContainText("$149.75");
  await expect(page.getByTestId("review-piece").nth(0)).toContainText("$75");
  await expect(page.getByTestId("fees")).toHaveText("$0.93");
  await expect(page.getByTestId("exit-fee")).toHaveText("$2.40");
  await expect(page.getByTestId("world")).toContainText("Account 1");
  await expect(page.getByTestId("world")).toContainText("Account 2");
  await shot(page, "trade-review", info.project.name);

  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByTestId("policy-summary")).toContainText("Piece 1: lock");
  await page.getByRole("button", { name: "Approve in my wallet" }).click();
  await expect(page.getByTestId("stop-sealed")).toHaveText(
    "Your stop is not on the exchange. It lives sealed inside the guard and fires when at least 3 of 7 price sources agree.",
    { timeout: 15_000 },
  );

  const sends = (await walletCalls(page)).filter((c) => c.kind === "send");
  expect(sends).toHaveLength(1);
  expect((sends[0].txs as unknown[]).length).toBe(1);
  expect(JSON.stringify(sends[0].txs)).toContain("store_wallet_policy");

  const confirm = apiRequests.find((r) => r.url.endsWith("/api/policy/confirm"))!;
  expect(JSON.parse(confirm.body!)).toEqual({ positionId: "pos1", txHashes: ["tx1x0"] });

  const stop = apiRequests.find((r) => r.url.endsWith("/api/positions/pos1/stop"))!;
  const boxes = JSON.parse(stop.body!).boxes as { shard: string; box: object }[];
  expect(boxes.map((b) => b.shard)).toEqual(["s0", "s1"]);
  // the level appears in no request except inside a sealed box
  for (const r of apiRequests) {
    const body = r.body ? JSON.parse(r.body) : {};
    if (Array.isArray(body.boxes)) for (const b of body.boxes) b.box = "sealed";
    expect(`${r.url} ${JSON.stringify(body)}`).not.toContain(STOP);
  }
});

test("a refusal from the plan is shown word for word", async ({ page, apiRequests, signedIn }) => {
  void apiRequests;
  await signedIn("prices_disagree");
  await page.goto("/trade/");
  await page.getByLabel("Size", { exact: true }).fill("300");
  await page.getByRole("button", { name: "Review" }).click();
  await expect(page.getByTestId("trade-error")).toHaveText("Price sources disagree right now, so we held off. Your stop is still set.");
});
