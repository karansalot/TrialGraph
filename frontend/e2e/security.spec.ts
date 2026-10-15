// Security regression tests: strict CSP must not break the app, and untrusted registry text must never execute.
import { expect, test } from "@playwright/test";

test("map renders under the strict CSP with no violations", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text().slice(0, 200)); });
  await page.goto("/");
  await expect(page.getByTestId("county-map")).toHaveAttribute("data-ready", "true");
  await page.waitForTimeout(2500);
  const rendered = await page.evaluate(() => { const c = document.querySelector("canvas"); return !!c && c.width > 0; });
  expect(rendered).toBe(true);
  expect(violations).toEqual([]);
});

test("a malicious facility name is shown as text, never executed", async ({ page }) => {
  let fired = false;
  await page.exposeFunction("__xss", () => { fired = true; });
  await page.addInitScript(() => { (window as unknown as { __xssFlag: boolean }).__xssFlag = false; });
  const payload = `<img src=x onerror="window.__xss()"><script>window.__xss()</script>`;
  // intercept the site list in either edition and replace the first site's name with a hostile string
  await page.route(/(\/data\/sites\/all\.json|\/api\/facilities\?)/, async (route) => {
    const res = await route.fetch();
    const j = await res.json();
    if (j.rows) j.rows[0][1] = payload; else j.facilities[0].name = payload;
    await route.fulfill({ response: res, json: j });
  });
  await page.goto("/");
  await expect(page.getByTestId("county-map")).toHaveAttribute("data-ready", "true");
  await page.waitForTimeout(2500);
  // hover the first site's pixel position through the map's own API
  const handled = await page.evaluate(async () => {
    const w = window as unknown as { __tgmap?: { queryRenderedFeatures: (o: object) => unknown[]; fire: (n: string, e: object) => void } };
    return typeof w.__tgmap !== "undefined";
  });
  if (handled) {
    await page.mouse.move(700, 400); await page.mouse.move(702, 402);
  }
  await page.waitForTimeout(500);
  expect(fired).toBe(false);
  expect(await page.locator("img[src='x']").count()).toBe(0);
});

test("unknown state or category in a URL is rejected, not interpolated", async ({ page }) => {
  await page.goto("/access?state=../../etc&category=%3Cscript%3E");
  await expect(page.getByLabel("Region")).toHaveValue("");
  await expect(page.getByTestId("filter-bar")).toBeVisible();
  await expect(page.getByTestId("gap-table").locator("tr").first()).toBeVisible();
  const bodyHasScript = await page.evaluate(() => document.body.innerHTML.includes("<script>alert"));
  expect(bodyHasScript).toBe(false);
});
