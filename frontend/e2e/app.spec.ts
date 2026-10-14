import { expect, test, type Page } from "@playwright/test";

const numberIn = async (page: Page, testId: string) => {
  const t = await page.getByTestId(testId).innerText();
  return Number((t.match(/[\d,]+(\.\d+)?/) ?? ["0"])[0].replaceAll(",", ""));
};

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (e) => { throw e; });
});

test("national overview shows real, sourced metrics and a data-freshness indicator", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("stat-recruiting-studies")).toContainText("ClinicalTrials.gov");
  expect(await numberIn(page, "stat-recruiting-studies")).toBeGreaterThan(100);
  await expect(page.getByTestId("stat-coverage")).toContainText("straight-line");
  await expect(page.getByTestId("freshness")).toContainText(/Trial data (fresh|stale)|Snapshot/);
  await expect(page.getByText("Registered studies by recruitment status")).toBeVisible();
  await expect(page.getByTestId("county-map")).toHaveAttribute("data-ready", "true");
  // never label straight-line distance as driving distance
  await expect(page.getByText(/not driving distance/i).first()).toBeVisible();
});

test("filters change the numbers (condition and region)", async ({ page }) => {
  await page.goto("/");
  const all = await numberIn(page, "stat-recruiting-studies");
  await page.getByLabel("Cancer type").selectOption("sarcoma");
  await expect.poll(() => numberIn(page, "stat-recruiting-studies")).toBeLessThan(all);
  const sarcomaUS = await numberIn(page, "stat-recruiting-studies");
  await page.getByLabel("Region").selectOption("MT");
  await expect.poll(() => numberIn(page, "stat-recruiting-studies")).toBeLessThan(sarcomaUS);
});

test("access gap explorer: choropleth, gap table and county profile", async ({ page }) => {
  await page.goto("/access");
  await expect(page.getByTestId("map-legend")).toContainText("straight-line");
  expect(await numberIn(page, "stat-gap-counties")).toBeGreaterThan(0);
  await page.getByLabel("Map metric").selectOption("acs_pct_poverty");
  await expect(page.getByTestId("map-legend")).toContainText("poverty");
  await page.getByTestId("gap-table").locator("tr").first().click();
  const panel = page.getByTestId("county-panel");
  await expect(panel).toContainText("Nearest currently recruiting sites");
  await expect(panel).toContainText("90% MOE");
  await expect(page.getByText("Trial proximity is not trial access.")).toBeVisible();
});

test("trial explorer: search, status filter, drill-down and source link", async ({ page }) => {
  await page.goto("/trials");
  await expect(page.getByTestId("trial-rows").locator("tr").first()).toBeVisible();
  await page.getByLabel("Search trials").fill("melanoma");
  await expect(page.getByTestId("trial-count")).toContainText("studies match");
  const first = page.getByTestId("trial-rows").locator("tr").first();
  await expect(first).toContainText(/NCT\d{8}/);
  await expect(first).toContainText("Recruiting");
  const nct = (await first.innerText()).match(/NCT\d{8}/)![0];
  await first.getByRole("link", { name: nct }).click();
  await expect(page).toHaveURL(new RegExp(`/trial/?\\?id=${nct}`));
  await expect(page.getByTestId("source-link")).toHaveAttribute("href", `https://clinicaltrials.gov/study/${nct}`);
  await expect(page.getByTestId("site-rows").locator("tr").first()).toBeVisible();
  await page.goto("/trials");
  await page.getByLabel("Recruitment status").selectOption("completed");
  await expect(page.getByTestId("trial-rows").locator("tr").first()).toContainText("Completed");
});

test("simulator: add a ranked candidate, see before/after, compare scenarios, run sensitivity", async ({ page }) => {
  await page.goto("/simulator");
  await expect(page.getByText("Hypothetical scenarios only.")).toBeVisible();
  const rows = page.getByTestId("candidate-rows").locator("tr");
  await expect(rows.first()).toBeVisible();
  await rows.nth(0).getByRole("button", { name: "Add" }).click();
  await expect(page.getByTestId("sim-result")).toBeVisible();
  const gain1 = await numberIn(page, "sim-gain");
  expect(gain1).toBeGreaterThan(0);
  await page.getByTestId("save-scenario").click();
  await rows.nth(2).getByRole("button", { name: "Add" }).click();
  await expect.poll(() => numberIn(page, "sim-gain")).toBeGreaterThanOrEqual(gain1);
  await page.getByTestId("save-scenario").click();
  await expect(page.getByTestId("scenario-compare").locator("tbody tr")).toHaveCount(2);
  // changing a weight re-ranks
  const before = await rows.first().innerText();
  await page.getByLabel(/Weight: Population newly within/).fill("0");
  await page.getByLabel(/Weight: Non-metro share/).fill("1");
  await expect.poll(async () => rows.first().innerText()).not.toBe(before);
  await page.getByTestId("tab-sensitivity").click();
  await expect(page.getByTestId("sensitivity")).toContainText("Rank stability");
});

test("executive brief: findings, limitations and export; methods page lists sources", async ({ page }) => {
  await page.goto("/brief");
  const brief = page.getByTestId("brief");
  await expect(brief).toContainText("Key findings");
  await expect(brief).toContainText("Limitations");
  await expect(brief).toContainText("Traceable to");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-md").click()]);
  const md = await (await import("node:fs/promises")).readFile((await dl.path())!, "utf8");
  expect(md).toContain("## Ranked hypothetical site opportunities");
  expect(md).toContain("straight-line");
  await page.goto("/methods");
  await expect(page.getByTestId("sources-table")).toContainText("ClinicalTrials.gov API v2");
  await expect(page.getByTestId("dictionary")).toContainText("acs_pct_poverty");
});

test("coverage by cancer type applies a filter, and the view is shareable by URL", async ({ page }) => {
  await page.goto("/");
  const table = page.getByTestId("category-coverage");
  await expect(table.locator("tbody tr")).toHaveCount(20);
  await table.getByText("Sarcoma", { exact: true }).click();
  await expect(page.getByLabel("Cancer type")).toHaveValue("sarcoma");
  await expect(page).toHaveURL(/category=sarcoma/);
  await page.goto("/access?category=lung&state=MT&threshold=100");
  await expect(page.getByLabel("Cancer type")).toHaveValue("lung");
  await expect(page.getByLabel("Region")).toHaveValue("MT");
  await expect(page.getByLabel("Distance threshold", { exact: true })).toHaveValue("100");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-counties").click()]);
  const csv = await (await import("node:fs/promises")).readFile((await dl.path())!, "utf8");
  expect(csv).toContain("category=lung; scope=MT; threshold_mi=100");
  expect(csv.split("\n").filter((l) => l && !l.startsWith("#"))).toHaveLength(57);
});

test("facility profile is reachable from a trial and lists its studies", async ({ page }) => {
  await page.goto("/trials");
  await page.getByTestId("trial-rows").locator("tr").first().getByRole("link").first().click();
  await page.getByTestId("site-rows").locator("tr").first().getByRole("link").first().click();
  await expect(page).toHaveURL(/\/facility\/?\?id=\d+/);
  await expect(page.getByTestId("facility-name")).toBeVisible();
  await expect(page.getByTestId("facility-studies").locator("tr").first()).toContainText(/NCT\d{8}/);
  await expect(page.getByText("Location confidence")).toBeVisible();
});

test("simulator suggests a multi-site plan that fills the scenario", async ({ page }) => {
  await page.goto("/simulator");
  await expect(page.getByTestId("candidate-rows").locator("tr").first()).toBeVisible();
  await page.getByLabel("Plan size").selectOption("4");
  await page.getByTestId("build-plan").click();
  await expect(page.getByTestId("plan-steps").locator("tbody tr")).toHaveCount(4);
  await expect(page.getByTestId("scenario-sites").locator("li")).toHaveCount(4);
  const cumulative = Number((await page.getByTestId("plan-steps").locator("tbody tr").last().locator("td").nth(3).innerText()).replace(/[+,]/g, ""));
  await expect.poll(() => numberIn(page, "sim-gain")).toBe(cumulative);
});

test("insights page shows computed findings with deep links, and lenses are selectable", async ({ page }) => {
  await page.goto("/insights");
  const cards = page.getByTestId("insight");
  await expect(cards).toHaveCount(8);
  await expect(cards.first()).toContainText("Phase 1");
  await cards.first().getByRole("link", { name: "Explore this →" }).click();
  await expect(page).toHaveURL(/\/access\/?\?category=lens_phase1/);
  await expect(page.getByLabel("Cancer type")).toHaveValue("lens_phase1");
  await page.goto("/");
  await expect(page.getByTestId("insight-teasers").locator("a")).toHaveCount(3);
});

test("usability: jump-to search, help panel with glossary, share link, welcome card", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await expect(page.getByTestId("welcome")).toBeVisible();
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("Yuma");
  await expect(page.getByTestId("palette-results")).toContainText("Yuma County, AZ");
  await page.keyboard.press("ArrowDown");
  await page.getByTestId("palette-results").getByText("Yuma County, AZ").click();
  await expect(page).toHaveURL(/\/access\/?\?state=AZ&county=04027/);
  await expect(page.getByTestId("county-panel")).toContainText("Yuma County");
  await page.getByTestId("share").first().click();
  await expect(page.getByText("Link copied")).toBeVisible();
  await page.getByTestId("open-help").click();
  await expect(page.getByRole("dialog", { name: "How to use TrialGraph" })).toContainText("Margin of error");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "What is Distance threshold?" }).first().focus();
  await expect(page.getByRole("tooltip")).toContainText("covered");
});

test("mobile layout: menu navigation works at phone width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Menu" }).click();
  await page.locator("#mobile-nav").getByRole("link", { name: "Insights" }).click();
  await expect(page).toHaveURL(/\/insights/);
  await expect(page.getByTestId("insight").first()).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
