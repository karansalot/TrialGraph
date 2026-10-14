// Parity check: the static (in-browser) edition must show the same numbers as the live API edition.
//   node e2e/parity.mjs   (live web on :3010 + API, static build served on :3020)
import { chromium } from "@playwright/test";
const b = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
async function grab(base) {
  const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
  const out = {};
  for (const [path, ids] of [["/?category=lens_phase1&state=TX&threshold=75", ["stat-recruiting-studies", "stat-recruiting-sites", "stat-coverage", "stat-beyond"]],
                             ["/access?category=breast", ["stat-gap-counties"]]]) {
    await p.goto(base + path, { waitUntil: "networkidle" });
    for (const id of ids) { await p.getByTestId(id).waitFor(); await p.waitForTimeout(800); out[path + "#" + id] = (await p.getByTestId(id).innerText()).split("\n").slice(0, 3).join(" | "); }
  }
  await p.goto(base + "/simulator?category=lung&threshold=50", { waitUntil: "networkidle" });
  await p.getByTestId("candidate-rows").locator("tr").first().waitFor();
  out["candidates"] = (await p.getByTestId("candidate-rows").locator("tr").allInnerTexts()).slice(0, 5).map((t) => t.replace(/\s+/g, " ").replace(/ Add$/, ""));
  await p.getByTestId("build-plan").click();
  await p.getByTestId("plan-steps").locator("tbody tr").first().waitFor();
  out["plan"] = (await p.getByTestId("plan-steps").locator("tbody tr").allInnerTexts()).map((t) => t.replace(/\s+/g, " "));
  await p.close();
  return out;
}
const live = await grab("http://localhost:3010"), stat = await grab("http://localhost:3020");
let bad = 0;
for (const k of Object.keys(live)) {
  const same = JSON.stringify(live[k]) === JSON.stringify(stat[k]);
  if (!same) bad++;
  console.log(same ? "MATCH " : "DIFF  ", k, same ? "" : `\n   live:   ${JSON.stringify(live[k])}\n   static: ${JSON.stringify(stat[k])}`);
}
await b.close();
process.exit(bad ? 1 : 0);
