import { expect, shot, test } from "./fixtures";

test("a refusal from the API is shown word for word", async ({ page, apiRequests, context, walletCalls }, info) => {
  await context.addCookies([{ name: "scenario", value: "signin_refused", url: "http://127.0.0.1:4173" }]);
  await page.goto("/signin/");
  await page.getByRole("button", { name: "Sign in with Test wallet" }).click();
  await expect(page.getByTestId("signin-error")).toHaveText("That key is not a full-access key of this NEAR account.");
  await shot(page, "signin-refused", info.project.name);

  const calls = await walletCalls(page);
  const sign = calls.find((c) => c.kind === "signMessage")!.p as { message: string; recipient: string; nonce: number[]; callbackUrl?: string };
  expect(Object.keys(sign).sort()).toEqual(["message", "nonce", "recipient"]);
  expect(sign.message).toMatch(/^Sign in to Unhuntable\n\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  expect(sign.nonce).toHaveLength(32);

  const session = apiRequests.find((r) => r.url.endsWith("/api/session"))!;
  const body = JSON.parse(session.body!);
  expect(body.message).toBe(sign.message);
  expect(body.recipient).toBe(sign.recipient);
  expect(body).not.toHaveProperty("callbackUrl");
  expect(Buffer.from(body.nonce, "base64")).toEqual(Buffer.from(sign.nonce));
});

test("signing in goes to the start screen", async ({ page, apiRequests }) => {
  void apiRequests;
  await page.goto("/signin/");
  await expect(page.getByRole("link", { name: "No NEAR wallet?" })).toHaveAttribute("href", "/deposit/");
  await page.getByRole("button", { name: "Sign in with Test wallet" }).click();
  await expect(page.getByTestId("account")).toHaveText("alice.near");
  await expect(page.getByTestId("private-balance")).toHaveText("$250.50");
});
