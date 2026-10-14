// Dev helper: node e2e/shot.mjs <path> <out.png> [waitMs] [fullPage]  - screenshots a page and prints console errors.
import { chromium } from "@playwright/test";
const [path = "/", out = "shot.png", wait = "4000", full = "1"] = process.argv.slice(2);
const b = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
const errs = [];
p.on("console", (m) => m.type() === "error" && errs.push(m.text().slice(0, 300)));
p.on("pageerror", (e) => errs.push("PAGEERROR " + String(e).slice(0, 300)));
await p.goto((process.env.BASE ?? "http://localhost:3010") + path, { waitUntil: "networkidle" });
await p.waitForTimeout(Number(wait));
await p.screenshot({ path: out, fullPage: full === "1" });
console.log(JSON.stringify({ errs }, null, 1));
await b.close();
