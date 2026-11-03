import { expect, shot, test } from "./fixtures";

test("the 3-word check refuses a wrong word and accepts the right ones", async ({ page, apiRequests, signedIn }, info) => {
  await signedIn("setup");
  await page.goto("/setup/");
  await page.getByRole("button", { name: "Make my 12 words" }).click();
  const words = (await page.getByTestId("words").locator("li").allInnerTexts()).map((t) => t.replace(/^\d+\s*/, "").trim());
  expect(words).toHaveLength(12);
  await expect(page.getByText("Write these down. They are the only way to get your money home without us.")).toBeVisible();
  await shot(page, "setup-words", info.project.name);
  await page.getByRole("button", { name: "I wrote them down" }).click();

  const labels = await page.locator("form label").allInnerTexts();
  const positions = labels.map((l) => Number(/Word (\d+)/.exec(l)![1]) - 1);
  for (let i = 0; i < 3; i++) await page.getByTestId(`check-${i}`).fill(words[positions[i]]);
  await page.getByTestId("check-1").fill(words[positions[1]] === "zoo" ? "abandon" : "zoo");
  await page.getByRole("button", { name: "Check" }).click();
  await expect(page.getByTestId("check-wrong")).toBeVisible();
  await shot(page, "setup-check", info.project.name);

  await page.getByTestId("check-1").fill(words[positions[1]]);
  await page.getByRole("button", { name: "Check" }).click();
  await expect(page.getByTestId("addkey-words")).toContainText("it can only call outlayer.near");
  await shot(page, "setup-key", info.project.name);

  // the words never went to our API, alone or in a row
  const sentText = apiRequests.map((r) => `${r.url} ${JSON.stringify(r.headers)} ${r.body ?? ""}`).join("\n");
  expect(sentText).not.toContain(words.join(" "));
  for (let i = 0; i + 1 < words.length; i++) expect(sentText).not.toMatch(new RegExp(`\\b${words[i]}\\W{1,4}${words[i + 1]}\\b`));
});
