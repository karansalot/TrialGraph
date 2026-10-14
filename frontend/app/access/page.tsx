"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Callout, ErrorNote, Loading, PageHeader, Panel, Stat, useData } from "@/components/bits";
import { HBar } from "@/components/charts";
import { FilterBar, useFilters } from "@/components/filters";
import { CountyMap, type Choropleth } from "@/components/map/county-map";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { API, get, qs, type Json } from "@/lib/api";
import { compact, fmtValue, num, pct, usd } from "@/lib/format";

type Row = Record<string, number | string | boolean | null>;
interface Metric { id: string; label: string; legend: string; breaks: number[] | "quantile"; format: (v: number) => string; get: (r: Row) => number | null; source: string }

const n = (v: unknown) => (typeof v === "number" ? v : null);
const METRICS: Metric[] = [
  { id: "mean_mi", label: "Distance to nearest recruiting site", legend: "Pop.-weighted mean straight-line miles", breaks: [10, 25, 50, 75, 100, 150], format: (v) => `${num(v, 0)} mi`, get: (r) => n(r.mean_mi), source: "Calculation: tract centres of population → nearest recruiting site" },
  { id: "pct_beyond", label: "Residents beyond the threshold", legend: "% of residents beyond threshold", breaks: [1, 10, 25, 50, 75, 99], format: (v) => `${num(v, 0)}%`, get: (r) => (n(r.pct_within) === null ? null : 100 - (r.pct_within as number)), source: "Calculation: 2020 Census tract populations" },
  { id: "studies_50mi", label: "Recruiting studies within 50 miles", legend: "Recruiting studies within 50 mi of county pop. centre", breaks: [1, 5, 20, 50, 150, 400], format: (v) => num(v, 0), get: (r) => n(r.studies_50mi), source: "PostGIS ST_DWithin on the county population centre; ClinicalTrials.gov" },
  { id: "acs_pct_poverty", label: "Poverty rate (ACS)", legend: "% below poverty level", breaks: "quantile", format: (v) => `${num(v, 0)}%`, get: (r) => n(r.acs_pct_poverty), source: "ACS 5-year, table B17001" },
  { id: "acs_pct_uninsured", label: "Uninsured rate (ACS)", legend: "% without health insurance", breaks: "quantile", format: (v) => `${num(v, 0)}%`, get: (r) => n(r.acs_pct_uninsured), source: "ACS 5-year, table B27010" },
  { id: "acs_pct_no_vehicle_hh", label: "Households without a vehicle (ACS)", legend: "% households with no vehicle", breaks: "quantile", format: (v) => `${num(v, 1)}%`, get: (r) => n(r.acs_pct_no_vehicle_hh), source: "ACS 5-year, table B08201" },
  { id: "acs_median_hh_income", label: "Median household income (ACS)", legend: "Median household income", breaks: "quantile", format: (v) => `$${compact(v)}`, get: (r) => n(r.acs_median_hh_income), source: "ACS 5-year, table B19013" },
  { id: "acs_pct_65_plus", label: "Population aged 65+ (ACS)", legend: "% aged 65+", breaks: "quantile", format: (v) => `${num(v, 0)}%`, get: (r) => n(r.acs_pct_65_plus), source: "ACS 5-year, table B01001" },
  { id: "places_cancer_aa", label: "Adult cancer prevalence (CDC PLACES)", legend: "Age-adjusted % of adults ever told they had cancer", breaks: "quantile", format: (v) => `${num(v, 1)}%`, get: (r) => n(r.places_cancer_aa), source: "CDC PLACES (model-based estimate; context, not trial demand)" },
];

function quantileBreaks(vals: number[]): number[] {
  const s = [...vals].sort((a, b) => a - b);
  if (!s.length) return [0];
  const out = [1, 2, 3, 4, 5, 6].map((i) => s[Math.min(s.length - 1, Math.floor((i / 7) * s.length))]);
  return [...new Set(out)];
}

function CountyPanel({ fips, onClose }: { fips: string; onClose: () => void }) {
  const { category, threshold } = useFilters();
  const { data, error } = useData<Json>(() => get(`/api/access/county/${fips}`, { category, threshold_mi: threshold }), `${fips}|${category}|${threshold}`);
  if (error) return <ErrorNote error={error} />;
  if (!data) return <Loading h={300} />;
  const c = data.county;
  return (
    <div data-testid="county-panel" className="space-y-3 text-sm">
      <div className="flex items-start justify-between">
        <div><div className="text-base font-semibold">{c.name}, {c.usps}</div>
          <div className="text-xs text-muted-foreground">{num(c.pop_2020)} residents (2020 Census) · {c.is_metro ? "Metro" : "Non-metro"} · RUCC {c.rucc_2023}</div></div>
        <button onClick={onClose} className="rounded border px-2 py-0.5 text-xs hover:bg-muted">Close</button>
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        {[["Within " + threshold + " mi", pct(data.access.pct_within)], ["Mean distance", `${num(data.access.mean_mi, 1)} mi`], ["Studies ≤ 50 mi", num(data.supply?.recruiting_studies_50mi ?? 0)]].map(([l, v]) => (
          <div key={l} className="rounded-md border px-1 py-2"><div className="text-lg font-semibold tabular-nums">{v}</div><div className="text-[11px] text-muted-foreground">{l}</div></div>))}
      </div>
      <div>
        <div className="mb-1 text-xs font-semibold">Nearest currently recruiting sites</div>
        <table className="w-full text-xs"><tbody>
          {data.nearest_recruiting_sites.slice(0, 5).map((s: Json) => (
            <tr key={s.facility_id} className="border-t"><td className="py-1 pr-2"><Link className="text-blue-700 hover:underline" href={`/facilities/${s.facility_id}`}>{s.name || "Unnamed site"}</Link>{s.is_placeholder_name && <span className="text-muted-foreground"> (anonymised)</span>}
              <div className="text-muted-foreground">{s.city}, {s.usps} · {s.recruiting_studies} recruiting {s.recruiting_studies === 1 ? "study" : "studies"} · geocode {s.geocode_confidence}</div></td>
              <td className="whitespace-nowrap py-1 text-right align-top tabular-nums">{num(s.miles, 1)} mi</td></tr>))}
        </tbody></table>
        <p className="mt-1 text-[11px] text-muted-foreground">{data.nearest_sites_note} {data.travel_time.configured ? "" : data.travel_time.message}</p>
        {data.travel_time.configured && data.travel_time.results && (
          <p className="mt-1 text-[11px]">Road travel time (routing source): {data.travel_time.results.map((r: Json) => `${r.drive_minutes ?? "—"} min`).join(" · ")}</p>)}
      </div>
      <div>
        <div className="mb-1 text-xs font-semibold">Population characteristics</div>
        <table className="w-full text-xs"><tbody>
          {data.indicators.filter((i: Json) => !i.indicator_id.endsWith("_crude")).map((i: Json) => (
            <tr key={i.indicator_id} className="border-t"><td className="py-1 pr-2">{i.label}<div className="text-muted-foreground">{i.vintage}</div></td>
              <td className="whitespace-nowrap py-1 text-right align-top tabular-nums">
                {i.value === null ? <span className="text-muted-foreground" title={i.missing_reason}>not published</span> : fmtValue(i.value, i.unit)}
                <div className="text-muted-foreground">{i.value !== null && i.moe !== null ? `± ${i.unit === "USD" ? usd(i.moe) : num(i.moe, 1)} (90% MOE)` : i.ci_low !== null ? `95% CI ${i.ci_low}–${i.ci_high}` : ""}</div></td></tr>))}
        </tbody></table>
      </div>
      <Link href="/simulator" className="inline-block text-xs font-medium text-blue-700 hover:underline">Test a hypothetical site here in the simulator →</Link>
    </div>
  );
}

export default function AccessPage() {
  const { category, state, threshold, meta } = useFilters();
  const [metricId, setMetricId] = useState("mean_mi");
  const [minShare, setMinShare] = useState(50);
  const [showSites, setShowSites] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const key = `${category}|${state}|${threshold}|${minShare}`;
  const cty = useData<Json>(() => get("/api/access/counties", { category, state, threshold_mi: threshold, min_share: minShare }), key);
  const cmp = useData<Json>(() => get("/api/access/compare", { category, state, threshold_mi: threshold, min_share: minShare }), key);
  const fac = useData<Json>(() => (showSites ? get("/api/facilities", { category, state }) : Promise.resolve(null)), `${category}|${state}|${showSites}`);
  const metric = METRICS.find((m) => m.id === metricId)!;
  const rows: Row[] = useMemo(() => cty.data?.counties ?? [], [cty.data]);
  const choropleth = useMemo<Choropleth | null>(() => {
    if (!rows.length) return null;
    const values: Record<string, number | null> = {};
    const vals: number[] = [];
    for (const r of rows) { const v = metric.get(r); values[r.fips as string] = v; if (v !== null) vals.push(v); }
    return { values, breaks: metric.breaks === "quantile" ? quantileBreaks(vals) : metric.breaks, label: metric.legend, format: metric.format };
  }, [rows, metric]);
  const gaps = useMemo(() => rows.filter((r) => r.is_gap).sort((a, b) => (b.pop_2020 as number) - (a.pop_2020 as number)), [rows]);
  const sel2 = "h-8 rounded-md border border-input bg-background px-2 text-sm";

  return (
    <>
      <PageHeader title="Access Gap Explorer" lead="County-level distance to currently recruiting oncology trial sites, alongside the socioeconomic characteristics of the people who live there. Click a county for its profile." />
      <FilterBar>
        <label className="grid gap-1 text-xs text-muted-foreground">Map shows
          <select aria-label="Map metric" className={sel2} value={metricId} onChange={(e) => setMetricId(e.target.value)}>
            {METRICS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select></label>
        <label className="grid gap-1 text-xs text-muted-foreground">Access gap = fewer than
          <select aria-label="Gap definition" className={sel2} value={minShare} onChange={(e) => setMinShare(Number(e.target.value))}>
            {[10, 25, 50, 75, 90].map((v) => <option key={v} value={v}>{v}% of residents within threshold</option>)}</select></label>
        <label className="flex h-8 items-center gap-2 text-xs"><input type="checkbox" checked={showSites} onChange={(e) => setShowSites(e.target.checked)} /> Show recruiting sites</label>
        <a data-testid="export-counties" className="ml-auto flex h-8 items-center rounded-md border px-3 text-xs font-medium hover:bg-muted"
          href={`${API}/api/access/counties.csv${qs({ category, state, threshold_mi: threshold, min_share: minShare })}`}>Export county table (CSV)</a>
      </FilterBar>
      <ErrorNote error={cty.error ?? cmp.error} />
      {cty.data && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat testId="stat-gap-counties" label="Access-gap counties" value={num(cty.data.n_gap_counties)} sub={`of ${num(cty.data.n_counties)} counties in scope`} source={`Calculation · ${cty.data.gap_definition}`} />
          <Stat label="Residents of gap counties" value={compact(cty.data.gap_population)} sub="2020 Census population" source="Calculation · U.S. Census Bureau 2020 tract populations" />
          <Stat label="Non-metro residents within threshold" value={pct(cmp.data?.metro_vs_nonmetro?.[1]?.pct_within)} sub={`Metro: ${pct(cmp.data?.metro_vs_nonmetro?.[0]?.pct_within)}`} source="Calculation · USDA ERS Rural-Urban Continuum Codes 2023" />
          <Stat label="Poverty rate, gap vs other counties" value={`${cmp.data?.indicators.find((i: Json) => i.indicator_id === "acs_pct_poverty")?.gap_counties ?? "—"}%`}
            sub={`Other counties: ${cmp.data?.indicators.find((i: Json) => i.indicator_id === "acs_pct_poverty")?.other_counties ?? "—"}%`} source="ACS 5-year B17001 · population-weighted county means" />
        </div>
      )}
      <div className="grid gap-3 xl:grid-cols-[1fr_400px]">
        <Panel title={metric.label} note={<>Source: {metric.source}. {cty.data?.distance_label}. Counties are 2023 Census boundaries; grey = value not published by the source.</>}>
          {cty.data ? <CountyMap choropleth={choropleth} facilities={fac.data?.facilities ?? null} state={state} selectedFips={sel} onCountyClick={(f) => setSel(f)} height={520} /> : <Loading h={520} />}
        </Panel>
        <Panel title={sel ? "County profile" : "Largest access-gap counties"} note={sel ? undefined : "Ranked by 2020 population. Click a row or a county on the map."}>
          {sel ? <CountyPanel fips={sel} onClose={() => setSel(null)} /> : (
            <div className="max-h-[520px] overflow-auto">
              <Table><TableHeader><TableRow><TableHead>County</TableHead><TableHead className="text-right">Residents</TableHead><TableHead className="text-right">Mean mi</TableHead></TableRow></TableHeader>
                <TableBody data-testid="gap-table">
                  {gaps.slice(0, 60).map((r) => (
                    <TableRow key={r.fips as string} className="cursor-pointer" onClick={() => setSel(r.fips as string)}>
                      <TableCell>{r.name}, {r.usps}<div className="text-[11px] text-muted-foreground">{r.is_metro ? "Metro" : "Non-metro"} · {pct(r.pct_within as number, 0)} within {threshold} mi</div></TableCell>
                      <TableCell className="text-right tabular-nums">{num(r.pop_2020 as number)}</TableCell><TableCell className="text-right tabular-nums">{num(r.mean_mi as number, 0)}</TableCell></TableRow>))}
                  {!gaps.length && <TableRow><TableCell colSpan={3} className="text-muted-foreground">No county meets the gap definition for this selection.</TableCell></TableRow>}
                </TableBody></Table>
            </div>)}
        </Panel>
      </div>
      {cmp.data && (
        <div className="grid gap-3 lg:grid-cols-2">
          <Panel title="Access-gap counties compared with all other counties" note={<>{cmp.data.caveat} Spearman ρ is the rank correlation between county mean distance and the indicator across counties with a published value.</>}>
            <Table><TableHeader><TableRow><TableHead>Indicator</TableHead><TableHead className="text-right">Gap counties ({num(cmp.data.n_gap_counties)})</TableHead>
              <TableHead className="text-right">Other counties ({num(cmp.data.n_other_counties)})</TableHead><TableHead className="text-right">ρ with distance</TableHead></TableRow></TableHeader>
              <TableBody>{cmp.data.indicators.map((i: Json) => (
                <TableRow key={i.indicator_id}><TableCell>{i.label}<div className="text-[11px] text-muted-foreground">{i.vintage} · values for {num(i.n_counties_with_value)} counties</div></TableCell>
                  <TableCell className="text-right tabular-nums">{fmtValue(i.gap_counties, i.unit)}</TableCell><TableCell className="text-right tabular-nums">{fmtValue(i.other_counties, i.unit)}</TableCell>
                  <TableCell className="text-right tabular-nums">{i.spearman_rho_distance ?? "—"}</TableCell></TableRow>))}</TableBody></Table>
          </Panel>
          <Panel title={`Residents beyond ${threshold} miles, by rural-urban continuum code`} note="USDA ERS RUCC 2023: 1–3 are metro counties, 4–9 non-metro (9 = most rural). Population: 2020 Census.">
            <HBar data={cmp.data.by_rucc.map((r: Json) => ({ ...r, label: `RUCC ${r.rucc_2023} · ${r.is_metro ? "metro" : "non-metro"}`, beyond: +(100 - r.pct_within).toFixed(2) }))}
              x="beyond" y="label" name={`Residents beyond ${threshold} mi`} format={(v) => `${v.toFixed(1)}%`} yWidth={130} />
            <Table className="mt-2"><TableHeader><TableRow><TableHead>RUCC</TableHead><TableHead className="text-right">Counties</TableHead><TableHead className="text-right">Residents</TableHead><TableHead className="text-right">Mean distance</TableHead></TableRow></TableHeader>
              <TableBody>{cmp.data.by_rucc.map((r: Json) => (<TableRow key={r.rucc_2023}><TableCell title={r.description}>{r.rucc_2023} <span className="text-[11px] text-muted-foreground">{(r.description ?? "").replace(/^(Metro|Nonmetro) - /, "")}</span></TableCell>
                <TableCell className="text-right tabular-nums">{num(r.n_counties)}</TableCell><TableCell className="text-right tabular-nums">{compact(r.population)}</TableCell><TableCell className="text-right tabular-nums">{num(r.pop_weighted_mean_mi, 1)} mi</TableCell></TableRow>))}</TableBody></Table>
          </Panel>
        </div>
      )}
      <Callout tone="warn"><b>Trial proximity is not trial access.</b> {meta?.analysis_site_definition} Distance says nothing about whether a resident would be eligible, whether a study has capacity, or how long the trip takes by road.
        {meta && !meta.routing_configured && " Road travel time is not shown because no routing source is configured."}</Callout>
    </>
  );
}
