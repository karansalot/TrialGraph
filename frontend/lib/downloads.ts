// File exports that work in both editions: the live edition streams them from the API, the static
// edition builds the same files in the browser from the same data.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { API, get, post, qs, STATIC } from "./api";

function save(text: string, name: string, type: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function csv(rows: Record<string, any>[]): string {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v: any) => (v === null || v === undefined ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v));
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(Array.isArray(r[c]) ? r[c].join(";") : r[c])).join(","))].join("\n") + "\n";
}

export async function downloadCounties(p: { category: string; state: string; threshold_mi: number; min_share: number }) {
  const name = `trialgraph_counties_${p.category}_${p.state || "US"}.csv`;
  if (!STATIC) { const r = await fetch(`${API}/api/access/counties.csv${qs(p)}`); return save(await r.text(), name, "text/csv"); }
  const d = await get("/api/access/counties", p);
  save(`# TrialGraph county access table. category=${p.category}; scope=${p.state || "US"}; threshold_mi=${p.threshold_mi}; gap = fewer than ${p.min_share}% of residents within threshold.\n` +
    "# mean_mi and pct_within are straight-line (great-circle) measures, not driving distance. Blank = not published by the source.\n" + csv(d.counties), name, "text/csv");
}

export async function downloadCandidates(body: any) {
  const name = "trialgraph_candidates.csv";
  if (!STATIC) {
    const r = await fetch(`${API}/api/simulator/candidates.csv`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return save(await r.text(), name, "text/csv");
  }
  const d = await post("/api/simulator/candidates", { ...body, limit: 500 });
  save(`# TrialGraph hypothetical site-opportunity ranking. category=${body.category}; threshold_mi=${body.threshold_mi}; scope=${body.state || "US"}; weights=${JSON.stringify(d.weights)}\n` +
    "# Straight-line distance. Hypothetical candidates only - not institutional recommendations.\n" + csv(d.candidates), name, "text/csv");
}

export async function downloadBrief(p: { category: string; state: string; threshold_mi: number }) {
  const name = `trialgraph_brief_${p.category}_${p.state || "US"}.md`;
  if (!STATIC) { const r = await fetch(`${API}/api/brief.md${qs(p)}`); return save(await r.text(), name, "text/markdown"); }
  save(briefMarkdown(await get("/api/brief", p)), name, "text/markdown");
}

export function briefMarkdown(b: any): string {
  const T = b.filters.threshold_mi;
  const L = [`# ${b.title}`, "", `_TrialGraph executive strategy brief - generated ${new Date(b.generated_at).toISOString().slice(0, 16).replace("T", " ")} UTC. Threshold: ${T} straight-line miles._`, "",
    `> ${b.disclaimer}`, "", "## Key findings", ""];
  b.key_findings.forEach((f: any, i: number) => L.push(`${i + 1}. **${f.title}.** ${f.text}  `, `   _Source: ${f.trace}_`));
  L.push("", "## Ranked hypothetical site opportunities", "", "| Rank | Candidate county | Residents newly within threshold | Miles saved / person | Non-metro share | Score |", "|---|---|---|---|---|---|");
  for (const r of b.ranked_opportunities) L.push(`| ${r.rank} | ${r.name}, ${r.usps} | ${r.pop_newly_within.toLocaleString("en-US")} | ${r.miles_saved_per_person} | ${Math.round((r.rural_share ?? 0) * 100)}% | ${r.score} |`);
  if (!b.ranked_opportunities.length) L.push("| - | No candidate meets the minimum coverage-gain filter in this scope | | | | |");
  L.push("", "Weights: " + Object.entries(b.weights).map(([k, v]) => `${b.component_labels[k]} ${Math.round((v as number) * 100)}%`).join(", "), "");
  if (b.sensitivity) {
    L.push("### Rank stability", "", "| Candidate | Baseline rank | Median rank | 5th-95th pct rank | Share of weightings in top N |", "|---|---|---|---|---|");
    for (const r of b.sensitivity.weight_monte_carlo) L.push(`| ${r.name}, ${r.usps} | ${r.baseline_rank} | ${r.median_rank} | ${Math.round(r.p05_rank)}-${Math.round(r.p95_rank)} | ${Math.round(r.share_top_n * 100)}% |`);
    L.push("");
  }
  L.push("## Methodology", "", ...b.methodology.map((m: any) => `- **${m.topic}.** ${m.text}`), "", "## Limitations", "", ...b.limitations.map((x: string) => `- ${x}`),
    "", "## Sources", "", "| Source | Publisher | Vintage | Retrieved (UTC) |", "|---|---|---|---|",
    ...b.sources.map((s: any) => `| [${s.source_name}](${s.url}) | ${s.publisher} | ${s.vintage ?? ""} | ${String(s.retrieved_at).slice(0, 16).replace("T", " ")} |`));
  return L.join("\n") + "\n";
}
