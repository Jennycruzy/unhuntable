import { ORIGIN, expect, shot, test } from "./fixtures";

const PAGES = ["/", "/signin/", "/setup/", "/deposit/", "/trade/", "/positions/", "/home/"];

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

test("visitors get the cover, with one way in and no app nav", async ({ page, apiRequests }) => {
  void apiRequests;
  await page.goto("/");
  await expect(page.locator("h1")).toHaveText("Trade big. Leave nothing to hunt.");
  await expect(page.locator("nav.nav")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Start" }).first()).toHaveAttribute("href", "/signin/");
  await expect(page.getByRole("img", { name: /A public position/ })).toBeVisible();
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
