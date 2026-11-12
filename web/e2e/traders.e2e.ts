import { expect, test } from "./fixtures";

test("anyone sees a trader's card and guard-signed record, and nothing open", async ({ page, apiRequests }) => {
  void apiRequests;
  await page.goto("/traders/");
  const card = page.getByTestId("trader-card");
  await expect(card.getByRole("heading", { name: "@alice_trades" })).toBeVisible();
  await expect(card).toContainText("4 (3 won)");
  await expect(page.getByTestId("trader-record")).toContainText("Signed by the guard over 6 pieces");
  await expect(page.getByTestId("record-download")).toHaveAttribute("download", "unhuntable-record-alice_trades.json");
  await expect(card).not.toContainText(/0x[0-9a-f]{40}/);
  await expect(card.getByRole("link", { name: "Sign in" })).toBeVisible();
});

test("buying a copy key: one wallet approval, then closed trades open up", async ({ page, apiRequests, signedIn, walletCalls }) => {
  await signedIn();
  await page.goto("/traders/");
  const card = page.getByTestId("trader-card");
  await expect(card.getByRole("button", { name: "Closed trades" })).toHaveCount(0);
  await card.getByRole("button", { name: "Buy a key" }).click();
  await page.getByLabel("Size of each copy, in dollars").fill("10");
  await expect(page.getByTestId("buy-key").getByRole("alert")).toHaveText("A copy is at least $15.");
  await page.getByLabel("Size of each copy, in dollars").fill("30");
  await expect(page.getByTestId("buy-key")).toContainText("split across several of your pieces");
  await expect(page.getByTestId("key-price")).toContainText("$0.50 a day");
  await page.getByRole("button", { name: "Approve and buy the copy key" }).click();
  await expect(page.getByTestId("key-row")).toContainText("Copy key · @alice_trades");
  await expect(page.getByTestId("key-row")).toContainText("On");
  const sends = (await walletCalls(page)).filter((c) => c.kind === "send");
  expect(sends).toHaveLength(1);
  const follow = apiRequests.find((r) => r.url.endsWith("/api/follow") && r.method === "POST")!;
  expect(JSON.parse(follow.body!)).toEqual({ handle: "alice_trades", kind: "copy", copyUsd: 30 });
  expect(apiRequests.some((r) => r.url.endsWith("/api/follow/key1/confirm"))).toBe(true);
  await card.getByRole("button", { name: "Closed trades" }).click();
  await expect(page.getByTestId("closed-trades")).toContainText("Short $101.00 BTC 5x");
  await expect(page.getByTestId("closed-trades")).toContainText("+$1.25");
  await page.getByTestId("key-row").getByRole("button", { name: "Stop the key" }).click();
  await expect(page.getByTestId("key-row")).toHaveCount(0);
});

test("selling keys: a name already taken is refused, then the profile is saved", async ({ page, apiRequests, signedIn }) => {
  void apiRequests;
  await signedIn();
  await page.goto("/traders/");
  const sell = page.getByTestId("sell-keys");
  await expect(sell.getByRole("heading", { name: "Sell keys to your trading" })).toBeVisible();
  await sell.getByLabel("Name").fill("alice_trades");
  await sell.getByRole("button", { name: "Start selling keys" }).click();
  await expect(sell.getByRole("alert")).toHaveText("Another trader already uses that name. Pick another.");
  await sell.getByLabel("Name").fill("bob_swings");
  await sell.getByRole("button", { name: "Start selling keys" }).click();
  await expect(page.getByTestId("sell-keys").getByRole("heading", { name: "Your trader profile" })).toBeVisible();
});
