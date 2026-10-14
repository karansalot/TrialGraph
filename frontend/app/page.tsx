"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ErrorNote, Loading, PageHeader, Panel, Stat, useData, Callout } from "@/components/bits";
import { HBar } from "@/components/charts";
import { FilterBar, useFilters } from "@/components/filters";
import { CountyMap } from "@/components/map/county-map";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { get } from "@/lib/api";
import { compact, num, pct } from "@/lib/format";

const SPONSOR: Record<string, string> = { OTHER: "Academic / hospital / other", INDUSTRY: "Industry", NIH: "NIH", NETWORK: "Research network", FED: "Other U.S. federal", OTHER_GOV: "Other government", INDIV: "Individual", UNKNOWN: "Not reported" };

export default function Overview() {
  const { category, state, threshold, meta, categoryLabel, set } = useFilters();
  const key = `${category}|${state}|${threshold}`;
  const ov = useData(() => get("/api/overview", { category, state, threshold_mi: threshold }), key);
  const fac = useData(() => get("/api/facilities", { category, state }), `${category}|${state}`);
  const cats = useData(() => get("/api/access/by-category", { state, threshold_mi: threshold }), `${state}|${threshold}`);
  const router = useRouter();
  const ins = useData(() => get("/api/insights", { threshold_mi: threshold }), `ins|${threshold}`);
  const d = ov.data;
  const recruiting = d?.status_counts.find((s: { status_group: string }) => s.status_group === "recruiting");
  const total = d?.status_counts.reduce((a: number, s: { studies: number }) => a + s.studies, 0);
  const where = state ? meta?.states.find((s) => s.usps === state)?.name : "the 50 states and DC";

  return (
    <>
      <PageHeader title="National Overview"
        lead={<>Where oncology trials are recruiting right now, and how much of the population lives near one. Every figure is computed from the public sources named beneath it.</>} />
      <FilterBar />
      <ErrorNote error={ov.error} />
      {!d ? <Loading h={420} /> : (
        <>
          {ins.data && (
            <div className="grid gap-3 md:grid-cols-3" data-testid="insight-teasers">
              {ins.data.insights.slice(0, 3).map((i: { id: string; theme: string; title: string; headline: string; headline_label: string }) => (
                <Link key={i.id} href="/insights" className="group rounded-lg border bg-neutral-900 px-4 py-3 text-white hover:bg-neutral-800">
                  <div className="text-[11px] uppercase tracking-wide text-neutral-400">{i.theme} insight</div>
                  <div className="mt-1 text-sm font-medium">{i.title}</div>
                  <div className="mt-1 flex items-baseline gap-2"><span className="text-2xl font-semibold tabular-nums">{i.headline}</span><span className="text-xs text-neutral-300">{i.headline_label}</span></div>
                  <div className="mt-1 text-xs text-sky-300 group-hover:underline">All insights →</div>
                </Link>))}
            </div>)}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat testId="stat-recruiting-studies" label={`Recruiting ${category === "all" ? "oncology" : categoryLabel.toLowerCase()} studies`} value={num(recruiting?.studies ?? 0)}
              sub={<>{pct(total ? (100 * (recruiting?.studies ?? 0)) / total : null)} of {num(total)} registered studies with sites in {where}</>}
              source="ClinicalTrials.gov API v2 · overallStatus = RECRUITING" />
            <Stat testId="stat-recruiting-sites" label="Facilities with a recruiting site" value={num(d.recruiting_sites.recruiting_facilities)}
              sub={<>{num(d.recruiting_sites.distinct_site_locations)} distinct ZIP/city locations in {num(d.recruiting_sites.counties_with_recruiting_site)} counties · interventional studies only</>}
              source="ClinicalTrials.gov · study and site both RECRUITING; de-duplicated by name + city + state + ZIP (upper bound)" />
            <Stat testId="stat-coverage" label={`Residents within ${threshold} straight-line miles`} value={pct(d.coverage.pct_within)}
              sub={<>{compact(d.coverage.population_within)} of {compact(d.coverage.population)} residents</>}
              source="Calculation · 2020 Census tract centres of population → nearest recruiting site" />
            <Stat testId="stat-beyond" label={`Residents farther than ${threshold} miles`} value={compact(d.coverage.population_beyond)}
              sub={<>Median distance {d.coverage.pop_weighted_median_mi} mi · 90th percentile {d.coverage.pop_weighted_p90_mi} mi</>}
              source="Calculation · population-weighted great-circle distance" />
          </div>

          <div className="grid gap-3 xl:grid-cols-[1fr_380px]">
            <Panel title={`Sites currently recruiting for interventional ${category === "all" ? "oncology" : categoryLabel.toLowerCase()} studies`}
              note={<>{meta?.analysis_site_definition} Points are ZIP-area or city centroids, not street addresses. Click a site for its profile. {fac.data ? `${num(fac.data.count)} facility records shown.` : ""}</>}>
              <CountyMap facilities={fac.data?.facilities ?? null} state={state} height={470} onFacilityClick={(id) => router.push(`/facilities/${id}`)} />
            </Panel>
            <div className="grid content-start gap-3">
              <Panel title="Registered studies by recruitment status"
                note="Only the highlighted bar is recruiting now. Completed, active-not-recruiting and unknown-status studies are never counted toward access. Source: ClinicalTrials.gov overallStatus.">
                <HBar data={d.status_counts} x="studies" y="label" name="Studies" highlight={(s: { status_group: string }) => s.status_group === "recruiting"} yWidth={140} />
              </Panel>
              <Panel title="Residents by distance to nearest recruiting site" note="Straight-line miles — not driving distance. Population: 2020 Census.">
                <HBar data={d.distance_bands} x="pct" y="band" name="Share of residents" format={(v) => `${v.toFixed(1)}%`} yWidth={70} />
              </Panel>
            </div>
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <Panel title={`Coverage by county type (within ${threshold} mi)`}
              note="Groups are defined by county-level characteristics (USDA RUCC 2023; ACS 5-year quartiles). They describe places, not individuals.">
              <Table>
                <TableHeader><TableRow><TableHead>County group</TableHead><TableHead className="text-right">Residents</TableHead>
                  <TableHead className="text-right">Within {threshold} mi</TableHead><TableHead className="text-right">Mean distance</TableHead></TableRow></TableHeader>
                <TableBody>
                  {d.coverage_by_group.map((g: { group: string; population: number; pct_within: number; pop_weighted_mean_mi: number }) => (
                    <TableRow key={g.group}><TableCell>{g.group}</TableCell><TableCell className="text-right tabular-nums">{compact(g.population)}</TableCell>
                      <TableCell className="text-right tabular-nums">{pct(g.pct_within)}</TableCell><TableCell className="text-right tabular-nums">{num(g.pop_weighted_mean_mi, 1)} mi</TableCell></TableRow>
                  ))}
                </TableBody>
              </Table>
            </Panel>
            <Panel title="Recruiting interventional studies by cancer type"
              note="A study can appear in several categories. Categories are assigned by published keyword rules over conditions and MeSH terms (see Data & Methods).">
              <HBar data={d.by_category.map((c: { category: string; studies: number }) => ({ ...c, label: meta?.categories.find((m) => m.id === c.category)?.label ?? c.category }))}
                x="studies" y="label" name="Recruiting studies with a recruiting site" />
            </Panel>
          </div>

          <div className="grid gap-3 lg:grid-cols-[1.6fr_1fr]">
            <Panel title={`Coverage by cancer type (within ${threshold} straight-line miles)`}
              note={<>{cats.data?.note} Click a row to apply that cancer type to every page.</>}>
              {!cats.data ? <Loading h={240} /> : (
                <div className="max-h-96 overflow-auto"><Table data-testid="category-coverage">
                  <TableHeader><TableRow><TableHead>Cancer type</TableHead><TableHead className="text-right">Recruiting studies</TableHead><TableHead className="text-right">Facilities</TableHead>
                    <TableHead className="text-right">Residents within {threshold} mi</TableHead><TableHead className="text-right">Residents beyond</TableHead><TableHead className="text-right">Median distance</TableHead></TableRow></TableHeader>
                  <TableBody>{cats.data.categories.map((c: { category: string; label: string; recruiting_studies: number; recruiting_facilities: number; pct_within: number; population_beyond: number; pop_weighted_median_mi: number }) => (
                    <TableRow key={c.category} className={`cursor-pointer ${c.category === category ? "bg-muted" : ""}`} onClick={() => set({ category: c.category })}>
                      <TableCell className="font-medium">{c.label}</TableCell><TableCell className="text-right tabular-nums">{num(c.recruiting_studies)}</TableCell><TableCell className="text-right tabular-nums">{num(c.recruiting_facilities)}</TableCell>
                      <TableCell className="text-right tabular-nums">{pct(c.pct_within)}</TableCell><TableCell className="text-right tabular-nums">{compact(c.population_beyond)}</TableCell>
                      <TableCell className="text-right tabular-nums">{c.pop_weighted_median_mi === null ? "—" : `${num(c.pop_weighted_median_mi, 1)} mi`}</TableCell></TableRow>))}</TableBody></Table></div>)}
            </Panel>
            <Panel title="Recruiting interventional studies by lead-sponsor type"
              note="ClinicalTrials.gov lead-sponsor class; the registry’s ‘Other’ class covers universities, hospitals and similar organisations. Counts studies with at least one recruiting site in the selected region.">
              <HBar data={d.by_sponsor_class.map((x: { sponsor_class: string; studies: number }) => ({ ...x, label: SPONSOR[x.sponsor_class] ?? x.sponsor_class }))} x="studies" y="label" name="Recruiting studies" yWidth={150} />
            </Panel>
          </div>

          <Panel title={state ? "Recruiting activity in this state" : "States ranked by recruiting studies"}
            note="Studies per 100k uses the 2020 Census population. A study with sites in several states is counted in each. Coverage uses the selected threshold."
            action={<Link href="/access" className="text-xs font-medium text-blue-700 hover:underline">Open Access Gap Explorer →</Link>}>
            <div className="max-h-80 overflow-auto">
              <Table>
                <TableHeader><TableRow><TableHead>State</TableHead><TableHead className="text-right">Recruiting studies</TableHead><TableHead className="text-right">Facilities</TableHead>
                  <TableHead className="text-right">Studies per 100k residents</TableHead><TableHead className="text-right">Residents within {threshold} mi</TableHead></TableRow></TableHeader>
                <TableBody>
                  {d.by_state.map((s: { usps: string; studies: number; facilities: number; studies_per_100k: number }) => {
                    const cov = d.state_coverage.find((c: { usps: string }) => c.usps === s.usps);
                    return <TableRow key={s.usps}><TableCell>{meta?.states.find((m) => m.usps === s.usps)?.name ?? s.usps}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(s.studies)}</TableCell><TableCell className="text-right tabular-nums">{num(s.facilities)}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(s.studies_per_100k, 1)}</TableCell><TableCell className="text-right tabular-nums">{pct(cov?.pct_within)}</TableCell></TableRow>;
                  })}
                </TableBody>
              </Table>
            </div>
          </Panel>
          <Callout>
            <b>How to read this page.</b> Being near a recruiting site is not the same as having access to a trial: eligibility, open slots, referral and travel all matter and are not modelled here.
            {" "}{num(d.recruiting_interventional_studies_without_recruiting_us_site_in_snapshot)} recruiting interventional studies list no U.S. site that is itself marked recruiting and therefore add no coverage.
            {" "}{num(d.records_excluded_as_not_oncology)} retrieved records could not be confirmed as oncology and are excluded.
          </Callout>
        </>
      )}
    </>
  );
}
