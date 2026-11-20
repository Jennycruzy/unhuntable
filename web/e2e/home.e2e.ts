import { expect, restoreKey, shot, test } from "./fixtures";

const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

test("go home asks for exactly two approvals and keeps the relock banner until the relock is confirmed", async ({ page, apiRequests, signedIn, walletCalls }, info) => {
  await signedIn();
  await page.goto("/home/");
  await expect(page.getByTestId("exit-fee")).toHaveText("Leaving Hyperliquid costs about $1.20 per piece (Hyperliquid's new-account fee plus routing).");
  await expect(page.getByRole("link", { name: "Leave without us" })).toHaveAttribute("href", "/exit/");
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

test("withdraw sends the private balance to the signed-in NEAR account, signed on this device", async ({ page, context, signedIn }, info) => {
  await signedIn();
  await restoreKey(page);
  const sent: { path: string; body: unknown; auth: string }[] = [];
  // OutLayer, answered here; our server never sees these calls
  await context.route("https://api.outlayer.ai/**", (route) => {
    const r = route.request();
    const path = new URL(r.url()).pathname;
    sent.push({ path, body: r.postData() ? JSON.parse(r.postData()!) : null, auth: r.headers()["authorization"] ?? "" });
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (path.endsWith("/confidential/balance")) return json({ balances: [{ token: USDC, balance: "21340000" }] });
    if (path.endsWith("/withdraw/dry-run")) return json({ amount_out: "12490000", time_estimate_seconds: 20 });
    if (path.endsWith("/confidential/withdraw")) return json({ request_id: "req-1", status: "pending" });
    return route.abort("blockedbyclient");
  });
  await page.goto("/home/");
  await expect(page.getByTestId("withdraw-have")).toHaveText("21.34 USDC");
  await expect(page.getByTestId("withdraw-amount")).toHaveValue("21.34");
  await page.getByTestId("withdraw-amount").fill("12.5");
  await page.getByRole("button", { name: "See what arrives" }).click();
  await expect(page.getByTestId("withdraw-preview")).toHaveText("12.5 USDC leaves your private balance. About 12.49 USDC arrives at alice.near, in about 20 seconds.");
  await shot(page, "withdraw", info.project.name);
  await page.getByRole("button", { name: "Withdraw", exact: true }).click();
  await expect(page.getByTestId("withdraw-sent")).toContainText("OutLayer request req-1 is pending.");
  const sends = sent.filter((s) => s.path.endsWith("/withdraw") || s.path.endsWith("/dry-run"));
  expect(sends).toHaveLength(2);
  for (const s of sends) {
    expect(s.body).toEqual({ chain: "near", to: "alice.near", amount: "12500000", token: USDC });
    expect(s.auth).toMatch(/^Bearer near:/);
  }
});
