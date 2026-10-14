// Captures the README product-tour screenshots into docs/screenshots/.  node e2e/screenshots.mjs
import { chromium } from "@playwright/test";
const BASE = process.env.BASE_URL ?? "http://localhost:3010";
const OUT = new URL("../../docs/screenshots/", import.meta.url).pathname;
const b = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const go = async (path, wait = 3500) => { await p.goto(BASE + path, { waitUntil: "networkidle" }); await p.waitForTimeout(wait); };
await go("/insights"); await p.screenshot({ path: OUT + "insights.png" });
await go("/"); await p.screenshot({ path: OUT + "overview.png" });
await go("/access?category=lens_phase1"); await p.getByTestId("gap-table").locator("tr").first().click(); await p.waitForTimeout(2500);
await p.screenshot({ path: OUT + "access.png" });
await go("/simulator"); await p.getByLabel("Plan size").selectOption("4"); await p.getByTestId("build-plan").click(); await p.waitForTimeout(3500);
await p.screenshot({ path: OUT + "simulator.png" });
await go("/trials"); await p.getByTestId("trial-rows").locator("tr").first().getByRole("link").first().click(); await p.waitForTimeout(3500);
await p.screenshot({ path: OUT + "trial.png" });
await b.close();
console.log("screenshots written to", OUT);
