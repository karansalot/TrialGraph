"use client";
import { useMemo, useState } from "react";
import { Callout, ErrorNote, Loading, PageHeader, Panel, useData } from "@/components/bits";
import { BeforeAfter } from "@/components/charts";
import { FilterBar, useFilters } from "@/components/filters";
import { CountyMap, type Choropleth } from "@/components/map/county-map";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { API, get, post, type Json } from "@/lib/api";
import { C, compact, num, pct } from "@/lib/format";

interface Site { lat: number; lon: number; label: string }
interface Saved { name: string; category: string; state: string; threshold: number; sites: Site[]; result: Json }

function ComponentBars({ row, comps }: { row: Json; comps: { id: string; label: string }[] }) {
  return (
    <div className="flex h-3 w-28 gap-0.5" role="img" aria-label={comps.map((c) => `${c.label}: ${row[`c_${c.id}`] ?? "n/a"}`).join("; ")}>
      {comps.map((c) => {
        const v = row[`c_${c.id}`];
        return <div key={c.id} title={`${c.label}: ${v === null ? "not available" : (v * 100).toFixed(0) + " / 100"}`} className="relative flex-1 rounded-sm bg-neutral-100">
          <div className="absolute inset-y-0 left-0 rounded-sm" style={{ width: `${(v ?? 0) * 100}%`, background: C.blue }} /></div>;
      })}
    </div>
  );
}

export default function Simulator() {
  const { category, state, threshold, meta, categoryLabel } = useFilters();
  const [sites, setSites] = useState<Site[]>([]);
  const [customWeights, setWeights] = useState<Record<string, number> | null>(null);
  const [minGain, setMinGain] = useState(5000);
  const [saved, setSaved] = useState<Saved[]>([]);
  const [tab, setTab] = useState<"rank" | "sens">("rank");
  const [planK, setPlanK] = useState(3);
  const [plan, setPlan] = useState<Json | null>(null);
  const [planBusy, setPlanBusy] = useState(false);
  const weights = customWeights ?? meta?.defaults.weights ?? null;
  const comps = meta?.score_components ?? [];
  const body = { category, threshold_mi: threshold, state: state || null };
  const wKey = JSON.stringify(weights);
  const base = useData<Json>(() => get("/api/access/counties", { category, state, threshold_mi: threshold }), `${category}|${state}|${threshold}`);
  const rank = useData<Json>(() => (weights ? post("/api/simulator/candidates", { ...body, weights, min_gain_pop: minGain, limit: 25 }) : Promise.resolve(null)), `${category}|${state}|${threshold}|${wKey}|${minGain}`);
  const sens = useData<Json>(() => (weights && tab === "sens" ? post("/api/simulator/sensitivity", { ...body, weights, min_gain_pop: minGain, top_n: 10 }) : Promise.resolve(null)), `${category}|${state}|${threshold}|${wKey}|${minGain}|${tab}`);
  const sim = useData<Json>(() => (sites.length ? post("/api/simulator/simulate", { ...body, sites }) : Promise.resolve(null)), `${category}|${state}|${threshold}|${JSON.stringify(sites)}`);

  const choropleth = useMemo<Choropleth | null>(() => {
    if (!base.data) return null;
    const after: Record<string, number> = {};
    for (const c of sim.data?.affected_counties ?? []) after[c.fips] = 100 - c.pct_within_after;
    const values: Record<string, number | null> = {};
    for (const r of base.data.counties) values[r.fips] = after[r.fips] ?? (r.pct_within === null ? null : 100 - r.pct_within);
    return { values, breaks: [1, 10, 25, 50, 75, 99], label: `% of residents beyond ${threshold} mi${sites.length ? " (with hypothetical sites)" : " (today)"}`, format: (v) => `${num(v, 0)}%` };
  }, [base.data, sim.data, threshold, sites.length]);

  const add = (s: Site) => setSites((o) => (o.length >= 10 ? o : [...o, s]));
  const wsum = Object.values(weights ?? {}).reduce((a, b) => a + b, 0) || 1;
  const exportCsv = async () => {
    const r = await fetch(`${API}/api/simulator/candidates.csv`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, weights, min_gain_pop: minGain, limit: 500 }) });
    const a = document.createElement("a"); a.href = URL.createObjectURL(await r.blob()); a.download = "trialgraph_candidates.csv"; a.click();
  };
  const buildPlan = async () => {
    setPlanBusy(true);
    try {
      const p = await post("/api/simulator/plan", { ...body, weights, min_gain_pop: minGain, k: planK });
      setPlan(p);
      setSites(p.steps.map((st: Json) => ({ lat: +st.lat.toFixed(4), lon: +st.lon.toFixed(4), label: `${st.name}, ${st.usps}` })));
    } finally { setPlanBusy(false); }
  };
  const d = sim.data;

  return (
    <>
      <PageHeader title="Site Strategy Simulator" lead="Place hypothetical trial sites and see how straight-line coverage would change, or rank every county as a candidate location with an explainable score you control." />
      <Callout tone="warn"><b>Hypothetical scenarios only.</b> Candidate sites are not real or planned facilities. Scores measure geographic need under the assumptions shown — they say nothing about feasibility and are not institutional recommendations.</Callout>
      <FilterBar />
      <ErrorNote error={base.error ?? rank.error ?? sim.error ?? sens.error} />

      <div className="grid gap-3 xl:grid-cols-[1fr_420px]">
        <Panel title="Click the map to add a hypothetical site" note={<>Each click places one hypothetical site that is assumed to recruit for {categoryLabel.toLowerCase()} studies. Up to 10 sites per scenario. Colours update to the scenario for affected counties.</>}>
          {base.data ? <CountyMap choropleth={choropleth} state={state} markers={sites} height={500}
            onCountyClick={(_f, name, usps, ll) => add({ lat: +ll.lat.toFixed(4), lon: +ll.lng.toFixed(4), label: `${name}, ${usps}` })} /> : <Loading h={500} />}
        </Panel>
        <div className="grid content-start gap-3">
          <Panel title="Build a multi-site plan" note="Greedy selection: each step re-scores every county after the sites already chosen, so overlapping candidates are not picked twice. A heuristic, not a guaranteed optimum. Uses the weights and minimum below.">
            <div className="flex items-end gap-2">
              <label className="grid gap-1 text-xs text-muted-foreground">Number of hypothetical sites
                <select aria-label="Plan size" className="h-8 rounded-md border px-2 text-sm" value={planK} onChange={(e) => setPlanK(Number(e.target.value))}>
                  {[2, 3, 4, 5, 6, 8].map((k) => <option key={k} value={k}>{k}</option>)}</select></label>
              <button data-testid="build-plan" disabled={planBusy || !weights} onClick={buildPlan} className="h-8 rounded-md bg-neutral-900 px-3 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50">{planBusy ? "Building…" : "Suggest plan"}</button>
            </div>
            {plan && (
              <table className="mt-3 w-full text-xs" data-testid="plan-steps"><thead><tr className="text-left text-muted-foreground"><th className="py-1 font-medium">Step</th><th className="font-medium">Site added</th><th className="text-right font-medium">Adds</th><th className="text-right font-medium">Cumulative</th><th className="text-right font-medium">Coverage</th></tr></thead>
                <tbody>{plan.steps.map((st: Json) => (<tr key={st.step} className="border-t"><td className="py-1 tabular-nums">{st.step}</td><td>{st.name}, {st.usps}</td><td className="text-right tabular-nums">+{num(st.marginal_pop_newly_within)}</td>
                  <td className="text-right tabular-nums">+{num(st.cumulative_pop_newly_within)}</td><td className="text-right tabular-nums">{pct(st.cumulative_pct_within, 2)}</td></tr>))}
                  {!plan.steps.length && <tr><td colSpan={5} className="py-2 text-muted-foreground">No candidate meets the minimum coverage gain in this scope.</td></tr>}</tbody></table>)}
            {plan?.stopped_early && plan.steps.length > 0 && <p className="mt-1 text-[11px] text-muted-foreground">Stopped after {plan.steps.length}: no remaining candidate meets the minimum coverage gain.</p>}
          </Panel>
          <Panel title={`Scenario (${sites.length} hypothetical ${sites.length === 1 ? "site" : "sites"})`}
            action={sites.length > 0 && <button className="text-xs text-blue-700 hover:underline" onClick={() => setSites([])}>Clear</button>}>
            {!sites.length ? <p className="text-sm text-muted-foreground">No sites yet. Click a county on the map, or use “Add” on a ranked candidate below.</p> : (
              <ol className="space-y-1 text-sm" data-testid="scenario-sites">
                {sites.map((s, i) => (<li key={i} className="flex items-center justify-between gap-2"><span><b>{i + 1}.</b> {s.label} <span className="text-[11px] text-muted-foreground">({s.lat}, {s.lon})</span></span>
                  <button aria-label={`Remove site ${i + 1}`} className="rounded border px-1.5 text-xs hover:bg-muted" onClick={() => setSites(sites.filter((_, j) => j !== i))}>Remove</button></li>))}
              </ol>)}
            {d && (
              <div className="mt-3 space-y-2" data-testid="sim-result">
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-md border px-2 py-2"><div className="text-[11px] text-muted-foreground">Residents newly within {threshold} mi</div><div className="text-xl font-semibold tabular-nums" data-testid="sim-gain">+{num(d.delta.population_newly_within)}</div></div>
                  <div className="rounded-md border px-2 py-2"><div className="text-[11px] text-muted-foreground">Coverage, today → scenario</div><div className="text-xl font-semibold tabular-nums">{pct(d.before.pct_within, 2)} → {pct(d.after.pct_within, 2)}</div></div>
                  <div className="rounded-md border px-2 py-2"><div className="text-[11px] text-muted-foreground">Mean distance (pop.-weighted)</div><div className="text-xl font-semibold tabular-nums">{d.before.pop_weighted_mean_mi} → {d.after.pop_weighted_mean_mi} mi</div></div>
                  <div className="rounded-md border px-2 py-2"><div className="text-[11px] text-muted-foreground">Counties affected</div><div className="text-xl font-semibold tabular-nums">{num(d.n_affected_counties)}</div></div>
                </div>
                <button data-testid="save-scenario" className="w-full rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700"
                  onClick={() => setSaved((o) => [...o, { name: `Scenario ${String.fromCharCode(65 + o.length)}`, category, state, threshold, sites, result: d }])}>Save scenario for comparison</button>
              </div>)}
          </Panel>
        </div>
      </div>

      {d && (
        <div className="grid gap-3 lg:grid-cols-2">
          <Panel title={`Share of residents beyond ${threshold} miles, by county group`} note="Lower is better. Groups are county-level (ecological): USDA RUCC 2023 and ACS 5-year top quartiles. Straight-line distance.">
            <BeforeAfter data={d.equity_groups.map((g: Json) => ({ group: g.group, before: +(100 - g.pct_within_before).toFixed(2), after: +(100 - g.pct_within_after).toFixed(2) }))}
              y="group" before="before" after="after" format={(v) => `${v.toFixed(1)}%`} />
            <Table><TableHeader><TableRow><TableHead>County group</TableHead><TableHead className="text-right">Today</TableHead><TableHead className="text-right">Scenario</TableHead><TableHead className="text-right">Newly within</TableHead></TableRow></TableHeader>
              <TableBody>{d.equity_groups.map((g: Json) => (<TableRow key={g.group}><TableCell>{g.group}</TableCell><TableCell className="text-right tabular-nums">{pct(g.pct_within_before, 2)}</TableCell>
                <TableCell className="text-right tabular-nums">{pct(g.pct_within_after, 2)}</TableCell><TableCell className="text-right tabular-nums">+{num(g.population_newly_within)}</TableCell></TableRow>))}</TableBody></Table>
          </Panel>
          <Panel title="Counties whose access changes" note={d.assumptions.join(" ")}>
            <div className="max-h-96 overflow-auto"><Table><TableHeader><TableRow><TableHead>County</TableHead><TableHead className="text-right">Within {threshold} mi</TableHead><TableHead className="text-right">Newly within</TableHead><TableHead className="text-right">Mean distance</TableHead></TableRow></TableHeader>
              <TableBody>{d.affected_counties.map((c: Json) => (<TableRow key={c.fips}><TableCell>{c.name}, {c.usps}<span className="ml-1 text-[11px] text-muted-foreground">{c.is_metro ? "metro" : "non-metro"}</span></TableCell>
                <TableCell className="text-right tabular-nums">{pct(c.pct_within_before, 0)} → {pct(c.pct_within_after, 0)}</TableCell><TableCell className="text-right tabular-nums">+{num(c.pop_newly_within)}</TableCell>
                <TableCell className="text-right tabular-nums">{num(c.mean_mi_before, 0)} → {num(c.mean_mi_after, 0)} mi</TableCell></TableRow>))}</TableBody></Table></div>
          </Panel>
        </div>)}

      {saved.length > 0 && (
        <Panel title="Scenario comparison" action={<button className="text-xs text-blue-700 hover:underline" onClick={() => setSaved([])}>Clear all</button>}
          note="Each scenario is evaluated independently against today's baseline with the filters that were active when it was saved.">
          <Table data-testid="scenario-compare"><TableHeader><TableRow><TableHead>Scenario</TableHead><TableHead>Hypothetical sites</TableHead><TableHead>Scope</TableHead><TableHead className="text-right">Newly within</TableHead>
            <TableHead className="text-right">Coverage</TableHead><TableHead className="text-right">Mean distance</TableHead><TableHead className="text-right">Non-metro newly within</TableHead><TableHead className="text-right">High-poverty newly within</TableHead></TableRow></TableHeader>
            <TableBody>{saved.map((s) => (<TableRow key={s.name}><TableCell className="font-medium">{s.name}</TableCell><TableCell className="max-w-xs whitespace-normal text-xs">{s.sites.map((x) => x.label).join("; ")}</TableCell>
              <TableCell className="text-xs">{meta?.categories.find((c) => c.id === s.category)?.label} · {s.state || "US"} · {s.threshold} mi</TableCell>
              <TableCell className="text-right tabular-nums">+{num(s.result.delta.population_newly_within)}</TableCell><TableCell className="text-right tabular-nums">{pct(s.result.before.pct_within, 2)} → {pct(s.result.after.pct_within, 2)}</TableCell>
              <TableCell className="text-right tabular-nums">{s.result.before.pop_weighted_mean_mi} → {s.result.after.pop_weighted_mean_mi} mi</TableCell>
              <TableCell className="text-right tabular-nums">+{num(s.result.equity_groups[1].population_newly_within)}</TableCell><TableCell className="text-right tabular-nums">+{num(s.result.equity_groups[2].population_newly_within)}</TableCell></TableRow>))}</TableBody></Table>
        </Panel>)}

      <div className="grid gap-3 xl:grid-cols-[320px_1fr]">
        <Panel title="Scoring assumptions" action={<button className="text-xs text-blue-700 hover:underline" onClick={() => { setWeights(null); setMinGain(5000); }}>Reset</button>}
          note="Weights are normalised to sum to 100%. Score = 100 × weighted average of the five 0–1 components.">
          <div className="space-y-3">
            {comps.map((c) => (
              <label key={c.id} className="block text-xs">
                <span className="flex justify-between"><span>{c.label}</span><span className="tabular-nums font-medium">{(((weights?.[c.id] ?? 0) / wsum) * 100).toFixed(0)}%</span></span>
                <input aria-label={`Weight: ${c.label}`} type="range" min={0} max={1} step={0.05} value={weights?.[c.id] ?? 0} className="w-full accent-neutral-800"
                  onChange={(e) => setWeights({ ...(weights ?? {}), [c.id]: Number(e.target.value) })} /></label>))}
            <label className="block text-xs">Minimum residents newly covered to be ranked
              <select aria-label="Minimum coverage gain" className="mt-1 h-8 w-full rounded-md border px-2 text-sm" value={minGain} onChange={(e) => setMinGain(Number(e.target.value))}>
                {[0, 1000, 5000, 25000, 100000].map((v) => <option key={v} value={v}>{num(v)}</option>)}</select></label>
          </div>
        </Panel>
        <Panel title={`Ranked hypothetical site opportunities — ${categoryLabel}, ${state || "United States"}, ${threshold} mi`}
          action={<div className="flex items-center gap-2 text-xs">
            <button className={`rounded px-2 py-1 ${tab === "rank" ? "bg-neutral-900 text-white" : "border"}`} onClick={() => setTab("rank")}>Ranking</button>
            <button data-testid="tab-sensitivity" className={`rounded px-2 py-1 ${tab === "sens" ? "bg-neutral-900 text-white" : "border"}`} onClick={() => setTab("sens")}>Sensitivity analysis</button>
            <button className="rounded border px-2 py-1" onClick={exportCsv}>Export CSV</button></div>}
          note={tab === "rank" ? <>{rank.data?.method.candidate_definition} {rank.data?.method.independence} Bars show the five component scores in the order of the sliders (hover for values). {rank.data?.method.components.health_context}.</>
            : <>Weight sets are drawn from a seeded Dirichlet distribution centred on your weights ({sens.data?.n_draws} draws, seed {sens.data?.seed}), so results are reproducible.</>}>
          {tab === "rank" ? (!rank.data ? <Loading h={300} /> : (
            <div className="max-h-[560px] overflow-auto"><Table><TableHeader><TableRow><TableHead>#</TableHead><TableHead>Candidate county</TableHead><TableHead className="text-right">Newly within {threshold} mi</TableHead>
              <TableHead className="text-right">Miles saved</TableHead><TableHead className="text-right">Non-metro</TableHead><TableHead>Components</TableHead><TableHead className="text-right">Score</TableHead><TableHead /></TableRow></TableHeader>
              <TableBody data-testid="candidate-rows">{rank.data.candidates.map((r: Json) => (
                <TableRow key={r.fips}><TableCell className="tabular-nums">{r.rank}</TableCell><TableCell>{r.name}, {r.usps}<div className="text-[11px] text-muted-foreground">{r.is_metro ? "metro" : "non-metro"} · reaches {r.counties_reached} counties</div></TableCell>
                  <TableCell className="text-right tabular-nums">{num(r.pop_newly_within)}</TableCell><TableCell className="text-right tabular-nums">{num(r.miles_saved_per_person, 0)}</TableCell>
                  <TableCell className="text-right tabular-nums">{pct((r.rural_share ?? 0) * 100, 0)}</TableCell><TableCell><ComponentBars row={r} comps={comps} /></TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">{num(r.score, 1)}</TableCell>
                  <TableCell><button className="rounded border px-2 py-0.5 text-xs hover:bg-muted" onClick={() => add({ lat: +r.lat.toFixed(4), lon: +r.lon.toFixed(4), label: `${r.name}, ${r.usps}` })}>Add</button></TableCell></TableRow>))}
                {!rank.data.candidates.length && <TableRow><TableCell colSpan={8} className="py-6 text-center text-muted-foreground">No candidate would bring at least {num(minGain)} more residents within {threshold} miles in this scope. Lower the minimum or the threshold.</TableCell></TableRow>}
              </TableBody></Table></div>)) : (!sens.data ? <Loading h={300} /> : (
            <div className="grid gap-4 lg:grid-cols-2" data-testid="sensitivity">
              <div><h3 className="mb-1 text-xs font-semibold">Rank stability under {sens.data.n_draws} alternative weightings</h3>
                <Table><TableHeader><TableRow><TableHead>Candidate</TableHead><TableHead className="text-right">Rank</TableHead><TableHead className="text-right">Median</TableHead><TableHead className="text-right">5th–95th pct</TableHead><TableHead className="text-right">Stays top {sens.data.top_n}</TableHead></TableRow></TableHeader>
                  <TableBody>{sens.data.weight_monte_carlo.map((r: Json) => (<TableRow key={r.fips}><TableCell>{r.name}, {r.usps}</TableCell><TableCell className="text-right tabular-nums">{r.baseline_rank}</TableCell><TableCell className="text-right tabular-nums">{r.median_rank}</TableCell>
                    <TableCell className="text-right tabular-nums">{num(r.p05_rank)}–{num(r.p95_rank)}</TableCell><TableCell className="text-right tabular-nums">{pct(r.share_top_n * 100, 0)}</TableCell></TableRow>))}</TableBody></Table></div>
              <div className="space-y-4">
                <div><h3 className="mb-1 text-xs font-semibold">Changing the distance threshold</h3>
                  <Table><TableHeader><TableRow><TableHead>Threshold</TableHead><TableHead className="text-right">Candidates</TableHead><TableHead className="text-right">Top {sens.data.top_n} shared with current</TableHead><TableHead>#1 at that threshold</TableHead></TableRow></TableHeader>
                    <TableBody>{sens.data.threshold.map((t: Json) => (<TableRow key={t.threshold_mi}><TableCell>{t.threshold_mi} mi{t.threshold_mi === threshold ? " (current)" : ""}</TableCell><TableCell className="text-right tabular-nums">{num(t.n_candidates)}</TableCell>
                      <TableCell className="text-right tabular-nums">{t.top_n_overlap} / {sens.data.top_n}</TableCell><TableCell className="text-xs">{t.top_n[0] ? `${t.top_n[0].name}, ${t.top_n[0].usps}` : "—"}</TableCell></TableRow>))}</TableBody></Table></div>
                <div><h3 className="mb-1 text-xs font-semibold">One weight at a time (×0.5 and ×1.5)</h3>
                  <Table><TableHeader><TableRow><TableHead>Weight changed</TableHead><TableHead className="text-right">Factor</TableHead><TableHead className="text-right">Top {sens.data.top_n} retained</TableHead><TableHead className="text-right">New rank of current #1</TableHead></TableRow></TableHeader>
                    <TableBody>{sens.data.one_at_a_time.map((o: Json) => (<TableRow key={o.component + o.factor}><TableCell>{comps.find((c) => c.id === o.component)?.label}</TableCell><TableCell className="text-right tabular-nums">×{o.factor}</TableCell>
                      <TableCell className="text-right tabular-nums">{o.top_n_overlap} / {sens.data.top_n}</TableCell><TableCell className="text-right tabular-nums">{o.new_rank_of_baseline_top1}</TableCell></TableRow>))}</TableBody></Table></div>
              </div>
            </div>))}
        </Panel>
      </div>
      <p className="text-[11px] text-muted-foreground">Population: 2020 Census tract centres of population ({compact(base.data?.counties.reduce((a: number, c: Json) => a + (c.pop_2020 ?? 0), 0))} residents in scope). Equity inputs: ACS 5-year. Rurality: USDA RUCC 2023. Health context: CDC PLACES.</p>
    </>
  );
}
