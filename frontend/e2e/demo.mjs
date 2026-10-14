// Records the ~3 minute product walkthrough described in docs/DEMO_SCRIPT.md.
//   node e2e/demo.mjs     (API on :8010 and web on :3010 must be running)
// Output: docs/demo/trialgraph-demo.webm + one PNG per scene. Captions are burned in as an overlay.
import { chromium } from "@playwright/test";
import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:3010";
const OUT = new URL("../../docs/demo/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: OUT + "tmp", size: { width: 1440, height: 900 } } });
const page = await ctx.newPage();
const t0 = Date.now();
let scene = 0;

async function caption(text) {
  await page.evaluate((t) => {
    let el = document.getElementById("tg-caption");
    if (!el) {
      el = document.createElement("div"); el.id = "tg-caption";
      el.style.cssText = "position:fixed;left:50%;bottom:22px;transform:translateX(-50%);max-width:1100px;z-index:9999;background:rgba(11,11,11,.92);color:#fff;font:500 17px/1.4 system-ui;padding:12px 18px;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.3);text-align:center";
      document.body.appendChild(el);
    }
    el.textContent = t;
  }, text);
}
const PACE = Number(process.env.DEMO_PACE ?? 0.74); // scales caption dwell time to keep the walkthrough near 3 minutes
async function say(text, ms = 6500) {
  ms = Math.round(ms * PACE);
  await caption(text);
  scene += 1;
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}scene-${String(scene).padStart(2, "0")}.png` });
  await page.waitForTimeout(ms - 900);
}
const go = async (path) => { await page.goto(BASE + path, { waitUntil: "networkidle" }); await page.waitForTimeout(1800); };
const scrollTo = async (text) => { await page.getByText(text, { exact: false }).first().scrollIntoViewIfNeeded(); await page.waitForTimeout(700); };

// 1. Problem + overview
await go("/");
await say("TrialGraph: where are oncology trials actually recruiting, and who lives far from them? Built entirely on public data.", 7500);
await say("Of ~40,000 registered U.S. oncology studies in the snapshot, only about one in six is recruiting now. Only those count.", 7500);
await say("Each dot is a site whose own status is RECRUITING. Every tile names its source; distances are straight-line, never 'driving'.", 7500);
await scrollTo("Coverage by county type");
await say("Coverage is computed from 84,414 census-tract centres of population: metro vs non-metro, and by county poverty or insurance.", 7000);

// 1b. Insights
await go("/insights");
await say("Insights are computed fresh from the data, with evidence and a link to check each one.", 6500);
await say("Early-phase trials: 40 million people live over 50 miles from a recruiting Phase 1 site - 33 million more than for any trial.", 7500);
await scrollTo("Where distance and economic barriers stack up");
await say("263 counties are both access gaps and in the top quartile for poverty or uninsurance - 4.6 million people.", 7000);
await scrollTo("New sites alone cannot close the gap");
await say("Even ten well-placed hypothetical sites close only about a quarter of the gap: a case for decentralised trial models.", 7000);

// 2. Filters
await go("/");
await page.getByLabel("Cancer type").selectOption("lens_phase1");
await page.waitForTimeout(1500);
await say("Filters include cancer types and trial-type lenses - here, early-phase trials only. Everything recomputes; the URL is shareable.", 6500);
await page.getByLabel("Cancer type").selectOption("lung");
await page.waitForTimeout(1200);

// 3. Access gap explorer
await go("/access");
await say("Access Gap Explorer: county choropleth of population-weighted distance to the nearest recruiting lung-cancer site.", 7000);
await page.getByLabel("Map metric").selectOption("acs_pct_poverty");
await page.waitForTimeout(1500);
await say("Switch the map to Census ACS indicators - poverty, insurance, vehicles - to see where barriers overlap.", 6500);
await page.getByLabel("Map metric").selectOption("mean_mi");
await page.getByTestId("gap-table").locator("tr").first().click();
await page.waitForTimeout(1800);
await say("A county profile: nearest recruiting sites, geocoding confidence, and every indicator with its margin of error.", 6500);
await scrollTo("Access-gap counties compared with all other counties");
await say("Gap counties vs the rest, and by USDA rural-urban code. County-level associations - explicitly not causal claims.", 7500);

// 4. Trial explorer
await go("/trials");
await page.getByLabel("Search trials").pressSequentially("immunotherapy", { delay: 60 });
await page.waitForTimeout(1500);
await say("Trial Explorer: real ClinicalTrials.gov records with NCT IDs, recruiting-site counts and a link to the source page.", 7000);
await page.getByTestId("trial-rows").locator("tr").first().getByRole("link").first().click();
await page.waitForLoadState("networkidle"); await page.waitForTimeout(1800);
await say("Drill-down: registry fields reproduced verbatim, why it was classified as oncology, and each site's own status.", 7500);

// 5. Simulator
await go("/simulator");
await page.getByLabel("Cancer type").selectOption("all");
await page.waitForTimeout(2000);
await say("Site Strategy Simulator. Everything here is hypothetical - candidate sites are not real or planned facilities.", 7000);
await scrollTo("Scoring assumptions");
await say("Every county is scored as a candidate with five transparent components. The weights are yours to change.", 7000);
const rows = page.getByTestId("candidate-rows").locator("tr");
await rows.nth(0).getByRole("button", { name: "Add" }).click();
await page.waitForTimeout(1500);
await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(1200);
await say("Add the top candidate: coverage is recalculated instantly - residents newly within 50 miles, before and after.", 7500);
await page.getByTestId("save-scenario").click();
await scrollTo("Ranked hypothetical site opportunities");
await rows.nth(2).getByRole("button", { name: "Add" }).click();
await page.waitForTimeout(1200);
await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(800);
await page.getByTestId("save-scenario").click();
await scrollTo("Share of residents beyond");
await say("Equity view: how coverage changes for non-metro and high-poverty county groups - and scenarios side by side.", 7500);
await page.getByLabel(/Weight: Non-metro share/).fill("0.8");
await page.waitForTimeout(1500);
await scrollTo("Scoring assumptions");
await say("Raise the rurality weight and the ranking reorders. The score is a weighted average you can audit.", 6000);
await page.evaluate(() => window.scrollTo(0, 0));
await page.getByRole("button", { name: "Clear" }).first().click();
await page.getByLabel("Plan size").selectOption("4");
await page.getByTestId("build-plan").click();
await page.waitForTimeout(2500);
await say("Plan builder: re-scores after each pick so overlapping candidates aren't chosen twice. Four sites, cumulative gain shown.", 7500);
await page.getByTestId("tab-sensitivity").click();
await page.waitForTimeout(1800);
await say("Sensitivity analysis: 500 seeded alternative weightings, one-at-a-time changes, and other distance thresholds.", 8000);

// 6. Brief + methods
await go("/brief");
await say("Executive Strategy Brief: findings assembled from computed values, each with its trace, exportable as Markdown or PDF.", 7500);
await scrollTo("Limitations");
await say("Methodology and limitations are part of the product: proximity is not access, and scores are not recommendations.", 7500);
await go("/methods");
await say("Data & Methods: every source with retrieval time, hash and freshness; the data dictionary; data-quality counters.", 8000);

await caption("TrialGraph - evidence-driven, reproducible, and honest about what it does not know.");
await page.waitForTimeout(4000);
console.log(`recorded ${(Date.now() - t0) / 1000}s, ${scene} scenes`);
await ctx.close(); await browser.close();
const f = readdirSync(OUT + "tmp").find((x) => x.endsWith(".webm"));
renameSync(OUT + "tmp/" + f, OUT + "trialgraph-demo.webm"); rmSync(OUT + "tmp", { recursive: true });
