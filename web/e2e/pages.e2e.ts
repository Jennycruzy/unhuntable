import AxeBuilder from "@axe-core/playwright";
import { ORIGIN, expect, shot, test } from "./fixtures";

const PAGES = ["/", "/signin/", "/setup/", "/deposit/", "/trade/", "/positions/", "/home/", "/hunt-map/", "/agents/", "/hunt-us/"];

test("every page loads scripts only from our own origin, under a strict CSP", async ({ page, apiRequests, signedIn, outside }, info) => {
  void apiRequests;
  await signedIn();
  const scripts: string[] = [];
  const refused: string[] = [];
  page.on("request", (r) => {
    if (r.resourceType() === "script") scripts.push(r.url());
  });
  page.on("console", (m) => {
    if (m.type() === "error" && /Content Security Policy|Refused to/i.test(m.text())) refused.push(m.text());
  });
  for (const path of PAGES) {
    await page.goto(path);
    await expect(page.locator("h1")).toBeVisible();
    const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toMatch(/script-src 'self'( 'sha256-[A-Za-z0-9+/=]+')*;/);
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
  }
  expect(scripts.length).toBeGreaterThan(0);
  for (const s of scripts) expect(new URL(s).origin).toBe(ORIGIN);
  expect(refused).toEqual([]);
  expect(outside.filter((u) => !u.startsWith("https://"))).toEqual([]);

  // screenshots last: Playwright adds a style of its own while it takes them
  for (const path of PAGES) {
    await page.goto(path);
    await expect(page.locator("h1")).toBeVisible();
    await shot(page, path === "/" ? "start" : path.replace(/\//g, ""), info.project.name);
  }
});

test("a bottom nav on phones, a side nav on desktop", async ({ page, apiRequests }, info) => {
  void apiRequests;
  await page.goto("/trade/");
  const box = await page.locator("nav.nav").boundingBox();
  expect(box).not.toBeNull();
  const phone = info.project.name === "phone";
  if (phone) expect(box!.y + box!.height).toBeGreaterThan(700);
  else expect(box!.height).toBeGreaterThan(700);
  // touch targets on phones; pointer targets on desktop
  for (const link of await page.locator("nav.nav a:visible").all()) expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(phone ? 44 : 32);
});

test("visitors get the landing, with one way in, no app nav and no call that fails", async ({ page, apiRequests }) => {
  const failed: string[] = [];
  page.on("response", (r) => {
    if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`);
  });
  await page.goto("/");
  await expect(page.locator("h1")).toHaveText("They can see where you get liquidated.");
  await expect(page.locator("nav.nav")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Open the app" }).first()).toHaveAttribute("href", "/signin/");
  // the book is drawn from the levels the server read, and says which parts are an illustration
  await expect(page.locator(".lp-heat .band")).not.toHaveCount(0);
  await expect(page.locator("#lp-book-cap")).toContainText("liquidation levels on Hyperliquid, read 2 min ago");
  await expect(page.locator("#lp-book-cap")).toContainText("The position and price path are an illustration.");
  // a visitor can switch between the two views
  await page.getByRole("button", { name: "Through Unhuntable" }).click();
  await expect(page.getByRole("button", { name: "Through Unhuntable" })).toHaveAttribute("aria-pressed", "true");
  // the largest live position the server read, with a link to check it
  await expect(page.getByTestId("whale-link")).toHaveText("0x5b5d…c060");
  await expect(page.getByTestId("whale-link")).toHaveAttribute("href", "https://app.hyperliquid.xyz/explorer/address/0x5b5d51203a0f9079f8aeb098a6523a13f298c060");
  await expect(page.getByTestId("whale-note")).toContainText("2 min ago");
  // a visitor never asks who is signed in
  expect(apiRequests.map((r) => new URL(r.url).pathname)).not.toContain("/api/me");
  expect(failed).toEqual([]);
});

test("the Hunt Map is open to visitors and shows the levels the server read, each with a link to check it", async ({ page, apiRequests }) => {
  await page.goto("/hunt-map/");
  await expect(page.locator("h1")).toHaveText("The Hunt Map");
  await expect(page.locator("nav.nav")).toHaveCount(0);
  await expect(page.getByTestId("totals")).toContainText("$4.1B");
  await expect(page.getByTestId("totals")).toContainText("832");
  const btc = page.getByTestId("coin-BTC");
  await expect(btc.getByRole("list", { name: "BTC: $85M is liquidated within 10% of the price 73,564." })).toBeVisible();
  await expect(btc.getByRole("link", { name: "0x8eff…bd5e" })).toHaveAttribute("href", "https://app.hyperliquid.xyz/explorer/address/0x8eff8ff863c1a54ec6697b7ad98fe30aa344bd5e");
  await expect(btc).toContainText("72,473");
  await expect(btc).toContainText("1.5% below");
  const replays = page.getByTestId("replays");
  await expect(replays.getByRole("heading", { name: "14 of 23 came straight back." })).toBeVisible();
  await expect(replays.getByTestId("replay")).toHaveCount(1);
  await expect(replays.getByTestId("replay")).toContainText("Long $200K HOOD");
  await expect(replays.getByTestId("replay")).toContainText("Liquidated at 89.83");
  await expect(replays.getByTestId("replay")).toContainText("went to 89.53");
  await expect(replays.getByTestId("replay")).toContainText("Back above the level an hour later");
  await expect(replays.getByRole("link", { name: "0x0423…55bb" })).toHaveAttribute("href", "https://app.hyperliquid.xyz/explorer/address/0x0423b4b2acb4f219ae4a270abd5dde2360e455bb");
  await expect(page.getByTestId("followed")).toContainText("visible levels followed");
  await expect(page.getByTestId("followed")).toContainText("then back");
  // a visitor never asks who is signed in
  expect(apiRequests.map((r) => new URL(r.url).pathname)).not.toContain("/api/me");
});

test("before the first read the Hunt Map says so and shows no numbers", async ({ page, apiRequests, context }) => {
  void apiRequests;
  await context.addCookies([{ name: "scenario", value: "no_map", url: "http://127.0.0.1:4173" }]);
  await page.goto("/hunt-map/");
  await expect(page.getByText("The first read of Hyperliquid is still running.")).toBeVisible();
  await expect(page.getByTestId("totals")).toHaveCount(0);
});

test("without a live read the landing shows no numbers it did not read", async ({ page, apiRequests, context }) => {
  void apiRequests;
  await context.addCookies([
    { name: "scenario", value: "no_map", url: "http://127.0.0.1:4173" },
  ]);
  await page.goto("/");
  await expect(page.locator("h1")).toBeVisible();
  await expect(page.locator(".lp-heat .band")).toHaveCount(0);
  await expect(page.locator(".lp-readout")).toHaveCount(0);
  await expect(page.locator("#lp-book-cap")).toHaveText("The position and price path are an illustration.");
});

test("no page has a serious accessibility problem, in dark or light", async ({ page, apiRequests, signedIn }) => {
  void apiRequests;
  const serious = async (where: string) =>
    (await new AxeBuilder({ page }).analyze()).violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${where} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  const found: string[] = [];
  for (const colorScheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.goto("/");
    await expect(page.locator("h1")).toBeVisible();
    found.push(...(await serious(`${colorScheme} /`)));
  }
  await signedIn();
  for (const colorScheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    for (const path of PAGES) {
      await page.goto(path);
      await expect(page.locator("h1")).toBeVisible();
      found.push(...(await serious(`${colorScheme} ${path}`)));
    }
  }
  expect(found).toEqual([]);
});

test("every choice tile is one tap target, clear of the fixed nav", async ({ page, apiRequests, signedIn }) => {
  void apiRequests;
  await signedIn();
  // the real height, and one a bit shorter, where a tile ends up next to the bottom nav
  for (const height of [page.viewportSize()!.height, page.viewportSize()!.height - 30]) {
    await page.setViewportSize({ width: page.viewportSize()!.width, height });
    for (const path of ["/trade/", "/deposit/"]) {
      await page.goto(path);
      await expect(page.locator(".choice input").first()).toBeVisible();
      for (const input of await page.locator(".choice input").all()) {
        await input.scrollIntoViewIfNeeded();
        const tile = (await input.locator("xpath=ancestor::label[1]").boundingBox())!;
        const box = (await input.boundingBox())!;
        expect(box).toEqual(tile);
        expect(box.height).toBeGreaterThanOrEqual(44);
        const hit = await input.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el;
        });
        expect(hit).toBe(true);
      }
    }
  }
});
