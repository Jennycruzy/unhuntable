import { expect, shot, test } from "./fixtures";

async function quote(page: import("@playwright/test").Page) {
  await page.goto("/deposit/");
  await page.getByLabel("Amount").fill("100");
  await page.getByRole("button", { name: "Get quote" }).click();
}

test("below the minimum shows the API sentence", async ({ page, apiRequests, signedIn }) => {
  void apiRequests;
  await signedIn("deposit_min");
  await quote(page);
  await expect(page.getByTestId("deposit-error")).toHaveText("The smallest deposit for this route is 10 USDC.");
});

test("waiting shows the address, the fee and a QR of the address", async ({ page, apiRequests, signedIn }, info) => {
  void apiRequests;
  await signedIn();
  await quote(page);
  await expect(page.getByTestId("deposit-address")).toHaveText("0x1111111111111111111111111111111111111111");
  await expect(page.getByTestId("qr")).toHaveAttribute("data-text", "0x1111111111111111111111111111111111111111");
  await expect(page.getByText("$0.58", { exact: true })).toBeVisible();
  await expect(page.getByTestId("fee-line")).toContainText("The fee includes our 0.06%.");
  await expect(page.getByTestId("deposit-status")).toContainText("This quote ends in");
  await shot(page, "deposit", info.project.name);
});

test("done shows what is in the private balance", async ({ page, apiRequests, signedIn }) => {
  void apiRequests;
  await signedIn("deposit_done");
  await quote(page);
  await expect(page.getByTestId("deposit-status")).toHaveText("In your private balance: $99.42");
});

test("refunded says it was sent back", async ({ page, apiRequests, signedIn }) => {
  void apiRequests;
  await signedIn("deposit_refunded");
  await quote(page);
  await expect(page.getByTestId("deposit-status")).toContainText("sent back to alice.near");
});

test("an expired quote offers a new one", async ({ page, apiRequests, signedIn }) => {
  void apiRequests;
  await signedIn("deposit_expired");
  await quote(page);
  await expect(page.getByTestId("deposit-status")).toHaveText("That quote expired. Don't send to that address.", { timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Get a new quote" })).toBeVisible();
});

test("the refund field says which address it needs on each route", async ({ page, signedIn }) => {
  await signedIn();
  await page.goto("/deposit/");
  await expect(page.getByTestId("refund-hint")).toContainText("Your NEAR account, like alice.near.");
  await expect(page.getByLabel("Refund to")).toHaveValue("alice.near");
  await page.getByRole("radio", { name: "MetaMask or Phantom" }).check();
  await expect(page.getByLabel("Refund to")).toHaveValue("");
  await page.getByLabel("Chain").selectOption({ label: "Base" });
  await expect(page.getByTestId("refund-hint")).toContainText("Your own address on Base, starting with 0x, from MetaMask.");
});
