"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Callout, ErrorNote, Loading, Panel, StatusBadge, useData } from "@/components/bits";
import { useFilters } from "@/components/filters";
import { CountyMap } from "@/components/map/county-map";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { get, type Json } from "@/lib/api";
import { date, num } from "@/lib/format";

export default function TrialDetail() {
  const { nctId } = useParams<{ nctId: string }>();
  const { meta } = useFilters();
  const { data, error } = useData<Json>(() => get(`/api/trials/${nctId}`), nctId);
  if (error) return <><ErrorNote error={error} /><Link href="/trials" className="text-sm text-blue-700 hover:underline">← Back to Trial Explorer</Link></>;
  if (!data) return <Loading h={400} />;
  const s = data.study;
  const rec = data.sites.filter((x: Json) => x.is_recruiting_site && x.lat !== null);
  const age = (v: number | null, f: string) => (v === null ? f : `${v} years`);
  const facts: [string, React.ReactNode][] = [
    ["Study type", s.study_type], ["Phase", (s.phases ?? []).join(" / ") || "Not applicable"], ["Lead sponsor", `${s.lead_sponsor} (${s.sponsor_class})`],
    ["Enrollment", s.enrollment_count === null ? "—" : `${num(s.enrollment_count)} (${(s.enrollment_type ?? "").toLowerCase()}, whole study)`],
    ["Start date", s.start_date ?? "—"], ["Primary completion", s.primary_completion_date ?? "—"], ["Last update posted", date(s.last_update_posted)],
    ["Status verified", s.status_verified_date ?? "—"],
    ["Eligibility (registry metadata)", `Sex: ${s.sex ?? "—"} · Ages ${age(s.min_age_years, "no minimum")} to ${age(s.max_age_years, "no maximum")} · Healthy volunteers: ${s.healthy_volunteers === null ? "—" : s.healthy_volunteers ? "yes" : "no"}`],
    ["Interventions", (s.interventions ?? []).map((i: Json) => `${i.name} (${(i.type ?? "").toLowerCase().replaceAll("_", " ")})`).join("; ") || "—"],
    ["Conditions (sponsor-entered)", (s.conditions ?? []).join("; ")], ["MeSH condition terms", (s.mesh_terms ?? []).join("; ") || "none assigned"],
    ["TrialGraph categories", (s.cancer_categories ?? []).map((c: string) => meta?.categories.find((m) => m.id === c)?.label ?? c).join(", ") || "uncategorised"],
    ["Counted as oncology because", s.oncology_basis === "mesh" ? "NLM MeSH term in the Neoplasms tree" : s.oncology_basis === "condition_text" ? "sponsor-entered condition names a cancer" : "not confirmed — excluded from analysis"],
  ];
  return (
    <>
      <Link href="/trials" className="text-sm text-blue-700 hover:underline">← Trial Explorer</Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-4xl">
          <div className="flex items-center gap-2"><span className="font-mono text-sm">{s.nct_id}</span>
            <StatusBadge group={s.status_group} label={meta?.statuses.find((x) => x.id === s.status_group)?.label} /></div>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">{s.brief_title}</h1>
        </div>
        <a href={s.source_url} target="_blank" rel="noreferrer" data-testid="source-link" className="rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white hover:bg-neutral-700">View original record on ClinicalTrials.gov ↗</a>
      </div>
      <div className="grid gap-3 xl:grid-cols-2">
        <Panel title="Registry record" note="All fields are reproduced from ClinicalTrials.gov API v2 except the two TrialGraph classification rows.">
          <dl className="grid grid-cols-[180px_1fr] gap-x-3 gap-y-1.5 text-sm">{facts.map(([k, v]) => (<div key={k} className="contents"><dt className="text-muted-foreground">{k}</dt><dd>{v}</dd></div>))}</dl>
        </Panel>
        <Panel title={`Sites currently recruiting (${num(data.site_summary.recruiting_sites)} of ${num(data.site_summary.us_sites)} U.S. sites)`} note="Points are ZIP-area or city centroids, not street addresses.">
          <CountyMap facilities={rec.map((x: Json) => ({ id: x.facility_id, lat: x.lat, lon: x.lon, n: 1, name: x.name_on_record, city: x.city, usps: x.usps, anon: x.is_placeholder_name }))} height={360}
            facilityLegend="Site with status RECRUITING on this study" />
        </Panel>
      </div>
      <Panel title="U.S. sites listed on this study">
        <div className="max-h-[480px] overflow-auto">
          <Table><TableHeader><TableRow><TableHead>Facility (as written in the registry)</TableHead><TableHead>City</TableHead><TableHead>State</TableHead><TableHead>County</TableHead><TableHead>Site status</TableHead><TableHead>Geocoding</TableHead></TableRow></TableHeader>
            <TableBody data-testid="site-rows">{data.sites.map((x: Json) => (
              <TableRow key={x.facility_id}><TableCell className="whitespace-normal"><Link className="text-blue-700 hover:underline" href={`/facilities/${x.facility_id}`}>{x.name_on_record || "Unnamed site"}</Link>{x.is_placeholder_name && <span className="ml-1 text-[11px] text-muted-foreground">(sponsor-anonymised)</span>}</TableCell>
                <TableCell>{x.city}</TableCell><TableCell>{x.usps}</TableCell><TableCell>{x.county_name ?? "—"}</TableCell>
                <TableCell>{x.is_recruiting_site ? <StatusBadge group="recruiting" label="Recruiting" /> : <span className="text-xs text-muted-foreground">{(x.site_status ?? "not reported").toLowerCase().replaceAll("_", " ")}</span>}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{x.geocode_method.replaceAll("_", " ")} · {x.geocode_confidence}</TableCell></TableRow>))}</TableBody></Table>
        </div>
      </Panel>
      <Callout>{data.notes.join(" ")}</Callout>
    </>
  );
}
