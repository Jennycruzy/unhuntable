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
  await page.goto("/");
  const box = await page.locator("nav.nav").boundingBox();
  expect(box).not.toBeNull();
  if (info.project.name === "phone") expect(box!.y + box!.height).toBeGreaterThan(700);
  else expect(box!.height).toBeGreaterThan(700);
  for (const link of await page.locator("nav.nav a").all()) expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
});
