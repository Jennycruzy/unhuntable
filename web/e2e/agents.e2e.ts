import { expect, shot, test } from "./fixtures";

test("the owner makes an agent key, sees it once with MCP settings, and can revoke a key", async ({ page, apiRequests, signedIn }, info) => {
  await signedIn();
  await page.goto("/agents/");
  await expect(page.getByTestId("agent-price")).toHaveText("Each agent call costs 0.002 USDC on NEAR, paid by the agent with x402 to unhuntable.near.");
  const row = page.getByTestId("agent-key-row");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("trend bot");
  await expect(row).toContainText("ETH, BTC");
  await expect(row).toContainText("2 (2 paid)");
  await expect(row.getByRole("link", { name: "payment" }).first()).toHaveAttribute("href", "https://nearblocks.io/txns/PayTx2");

  await page.getByLabel("Name").fill("night bot");
  await page.getByLabel("Largest size it may open, in dollars").fill("50");
  await page.getByRole("checkbox", { name: "SOL" }).check({ force: true });
  await page.getByLabel("Opens per day").fill("2");
  await page.getByRole("button", { name: "Make key" }).click();

  const made = page.getByTestId("agent-made");
  await expect(made).toContainText("night bot: copy the key now");
  const key = "uak_" + "c3".repeat(32);
  await expect(page.getByTestId("agent-key")).toHaveText(key);
  await expect(page.getByTestId("agent-config")).toContainText(`"UNHUNTABLE_AGENT_KEY": "${key}"`);
  await expect(page.getByTestId("agent-config")).toContainText('"UNHUNTABLE_URL": "https://tryunhuntable.site"');
  const sent = apiRequests.find((r) => r.method === "POST" && r.url.endsWith("/api/agents"))!;
  expect(JSON.parse(sent.body!)).toEqual({ name: "night bot", maxNotionalUsd: 50, coins: ["ETH", "SOL"], dailyOpens: 2 });
  await shot(page, "agents-key-made", info.project.name);

  await row.getByRole("button", { name: "Revoke" }).click();
  await expect.poll(() => apiRequests.some((r) => r.url.endsWith("/api/agents/aaaaaaaa-1111-4111-8111-111111111111/revoke"))).toBe(true);
});

test("the start screen links to the agents screen, and a server without x402 says calls are free", async ({ page, apiRequests, signedIn }) => {
  void apiRequests;
  await signedIn("agents_free");
  await page.goto("/");
  await page.getByRole("link", { name: "AI agents" }).click();
  await expect(page).toHaveURL(/\/agents\/$/);
  await expect(page.getByTestId("agent-price")).toHaveText("Agent calls are free on this server.");
});
