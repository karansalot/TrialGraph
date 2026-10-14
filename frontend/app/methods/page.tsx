"use client";
import { ErrorNote, Loading, PageHeader, Panel, useData } from "@/components/bits";
import { useFilters } from "@/components/filters";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { get, type Json } from "@/lib/api";
import { dateTime, num } from "@/lib/format";

export default function Methods() {
  const { meta } = useFilters();
  const fr = useData<Json>(() => get("/api/meta/freshness", { live: true }), "f");
  const ind = useData<Json>(() => get("/api/meta/indicators"), "i");
  const q = useData<Json>(() => get("/api/meta/quality"), "q");
  return (
    <>
      <PageHeader title="Data & Methods" lead="Where every number comes from, how fresh it is, and how well the raw data held up. The full methodology and data dictionary are in the repository under docs/." />
      <ErrorNote error={fr.error ?? ind.error ?? q.error} />
      <Panel title="Sources and freshness" note={fr.data?.ctgov_live?.upstream_data_timestamp ? <>Live check: ClinicalTrials.gov currently reports data timestamp {fr.data.ctgov_live.upstream_data_timestamp}; this snapshot was built from {String(fr.data.ctgov_live.snapshot_data_timestamp).slice(0, 19)}. {fr.data.ctgov_live.newer_data_available ? "Newer registry data is available — re-run the pipeline." : "The snapshot matches the registry’s current data release."}</> : "Live upstream check unavailable."}>
        <div id="sources" />
        {!fr.data ? <Loading /> : <Table data-testid="sources-table"><TableHeader><TableRow><TableHead>Source</TableHead><TableHead>Publisher</TableHead><TableHead>Vintage</TableHead><TableHead>Grain</TableHead><TableHead>Retrieved</TableHead><TableHead className="text-right">Age</TableHead><TableHead>Status</TableHead><TableHead>SHA-256 (upstream)</TableHead></TableRow></TableHeader>
          <TableBody>{fr.data.sources.map((s: Json) => (<TableRow key={s.source_key}><TableCell className="whitespace-normal"><a className="text-blue-700 hover:underline" href={s.url} target="_blank" rel="noreferrer">{s.source_name}</a><div className="text-[11px] text-muted-foreground">{s.source_key}{s.notes ? ` · ${s.notes}` : ""}</div></TableCell>
            <TableCell className="whitespace-normal text-xs">{s.publisher}</TableCell><TableCell className="text-xs">{s.vintage}</TableCell><TableCell className="text-xs">{s.geographic_grain}</TableCell><TableCell className="whitespace-nowrap text-xs">{dateTime(s.retrieved_at)}</TableCell>
            <TableCell className="text-right tabular-nums">{s.age_days}d</TableCell><TableCell><span className={`rounded-full border px-2 py-0.5 text-[11px] ${s.status === "fresh" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-800"}`}>{s.status === "fresh" ? "✓ fresh" : "! stale"}</span><div className="text-[11px] text-muted-foreground">stale after {s.stale_after_days}d</div></TableCell>
            <TableCell className="font-mono text-[10px] text-muted-foreground">{(s.upstream_sha256 ?? "").slice(0, 16)}…</TableCell></TableRow>))}</TableBody></Table>}
      </Panel>
      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title="Definitions used everywhere">
          <dl className="space-y-2 text-sm">
            <div><dt className="font-medium">Recruiting site</dt><dd className="text-muted-foreground">{meta?.analysis_site_definition}</dd></div>
            <div><dt className="font-medium">Distance</dt><dd className="text-muted-foreground">{meta?.distance_label}. Computed from each 2020 census tract’s centre of population to the nearest recruiting site on a sphere of radius 6371.0088 km; cross-checked against PostGIS geodesic distance.</dd></div>
            <div><dt className="font-medium">Scope</dt><dd className="text-muted-foreground">50 states and the District of Columbia ({meta?.scope === "national" ? "national run" : `pilot: ${meta?.scope}`}). Territories are not included.</dd></div>
            <div><dt className="font-medium">Road travel time</dt><dd className="text-muted-foreground">{meta?.routing_configured ? "A routing source is configured; drive times appear in county profiles." : "Not shown: no routing source is configured (set TG_OSRM_URL). Straight-line distance is never labelled as driving distance."}</dd></div>
          </dl>
        </Panel>
        <Panel title="Data quality counters" note="Coordinates falling in a different state than the registry reports are downgraded to low confidence.">
          {!q.data ? <Loading /> : <div className="grid grid-cols-2 gap-4 text-xs">
            <div><div className="mb-1 font-semibold">Site geocoding</div><table className="w-full"><tbody>{q.data.geocoding.map((g: Json) => (<tr key={g.geocode_method + g.geocode_confidence} className="border-t"><td className="py-0.5">{g.geocode_method.replaceAll("_", " ")} <span className="text-muted-foreground">({g.geocode_confidence})</span></td><td className="text-right tabular-nums">{num(g.facilities)}</td></tr>))}</tbody></table>
              <div className="mb-1 mt-3 font-semibold">Oncology determination</div><table className="w-full"><tbody>{q.data.oncology_basis.map((g: Json) => (<tr key={g.oncology_basis} className="border-t"><td className="py-0.5">{g.oncology_basis.replaceAll("_", " ")}</td><td className="text-right tabular-nums">{num(g.studies)}</td></tr>))}</tbody></table></div>
            <div><div className="mb-1 font-semibold">Facility de-duplication</div><table className="w-full"><tbody>
              {[["Source site records", q.data.facilities.source_site_records], ["Facilities after de-duplication", q.data.facilities.total], ["…merged from several spellings", q.data.facilities.merged_spelling_variants], ["…with sponsor-anonymised name", q.data.facilities.anonymised_name], ["…coordinate in a different state", q.data.facilities.state_mismatch]].map(([l, v]) => (<tr key={l} className="border-t"><td className="py-0.5">{l}</td><td className="text-right tabular-nums">{num(v as number)}</td></tr>))}</tbody></table>
              <div className="mb-1 mt-3 font-semibold">Site status within recruiting studies</div><table className="w-full"><tbody>{q.data.site_status_of_recruiting_studies.map((g: Json) => (<tr key={g.site_status} className="border-t"><td className="py-0.5">{g.site_status.toLowerCase().replaceAll("_", " ")}</td><td className="text-right tabular-nums">{num(g.site_links)}</td></tr>))}</tbody></table></div>
          </div>}
        </Panel>
      </div>
      <Panel title="Data dictionary — county indicators" note="Missing values are never imputed; counties without a published value show as “not published”.">
        {!ind.data ? <Loading /> : <div className="max-h-[560px] overflow-auto"><Table data-testid="dictionary"><TableHeader><TableRow><TableHead>Indicator</TableHead><TableHead>Definition</TableHead><TableHead>Formula / source cells</TableHead><TableHead>Vintage</TableHead><TableHead>Uncertainty</TableHead><TableHead className="text-right">Counties with value</TableHead></TableRow></TableHeader>
          <TableBody>{ind.data.map((i: Json) => (<TableRow key={i.indicator_id}><TableCell className="whitespace-normal"><div className="font-medium">{i.label}</div><div className="font-mono text-[10px] text-muted-foreground">{i.indicator_id}</div></TableCell>
            <TableCell className="max-w-md whitespace-normal text-xs">{i.definition} <span className="text-muted-foreground">Universe: {i.universe}. {i.limitations}</span></TableCell>
            <TableCell className="max-w-xs whitespace-normal font-mono text-[10px]">{i.formula}</TableCell><TableCell className="text-xs">{i.vintage}</TableCell><TableCell className="whitespace-normal text-xs">{i.uncertainty}</TableCell>
            <TableCell className="text-right tabular-nums">{num(i.n_counties_with_value)}</TableCell></TableRow>))}</TableBody></Table></div>}
      </Panel>
      <Panel title="Cancer-category rules" note="Regular expressions applied to the lower-cased sponsor-entered conditions and MeSH condition terms. A study can match several categories.">
        <Table><TableHeader><TableRow><TableHead>Category</TableHead><TableHead>Rule</TableHead></TableRow></TableHeader>
          <TableBody>{meta?.categories.filter((c) => c.rule).map((c) => (<TableRow key={c.id}><TableCell>{c.label}</TableCell><TableCell className="whitespace-normal font-mono text-[10px]">{c.rule}</TableCell></TableRow>))}</TableBody></Table>
      </Panel>
    </>
  );
}
