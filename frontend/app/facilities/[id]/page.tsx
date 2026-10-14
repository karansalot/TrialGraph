"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Callout, ErrorNote, Loading, Panel, Stat, StatusBadge, useData } from "@/components/bits";
import { useFilters } from "@/components/filters";
import { CountyMap } from "@/components/map/county-map";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { get, type Json } from "@/lib/api";
import { num } from "@/lib/format";

const METHOD: Record<string, string> = {
  zcta_centroid: "Centre of the site's ZIP Code Tabulation Area (Census gazetteer)",
  city_point: "City-level point published by ClinicalTrials.gov (no usable ZIP)",
  city_point_zip_conflict: "City-level point; the ZIP on record is more than 30 miles away and was not trusted",
  zcta_centroid_no_city: "Centre of the ZIP area; the registry gave no coordinate",
  none: "No coordinate available - excluded from distance analysis",
};

export default function FacilityPage() {
  const { id } = useParams<{ id: string }>();
  const { meta } = useFilters();
  const { data, error } = useData<Json>(() => get(`/api/facilities/${id}`), id);
  if (error) return <><ErrorNote error={error} /><Link href="/" className="text-sm text-blue-700 hover:underline">← National Overview</Link></>;
  if (!data) return <Loading h={400} />;
  const f = data.facility;
  const rec = data.studies.filter((s: Json) => s.is_recruiting_site);
  const cats: Record<string, number> = {};
  for (const s of rec) for (const c of s.cancer_categories ?? []) cats[c] = (cats[c] ?? 0) + 1;
  const topCats = Object.entries(cats).sort((a, b) => b[1] - a[1]).slice(0, 6);
  return (
    <>
      <Link href="/" className="text-sm text-blue-700 hover:underline">← National Overview</Link>
      <div>
        <h1 className="text-xl font-semibold tracking-tight" data-testid="facility-name">{f.name || "Unnamed site"}</h1>
        <p className="text-sm text-muted-foreground">{f.city}, {f.usps} {f.zip5 ?? ""}{f.county_name ? ` · ${f.county_name}` : ""}</p>
      </div>
      {f.is_placeholder_name && <Callout>This site name is a sponsor placeholder. The registry does not disclose which institution it is, so records here are grouped only by name, city, state and ZIP.</Callout>}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Studies recruiting at this site" value={num(rec.length)} sub="study and site both RECRUITING" source="ClinicalTrials.gov API v2 · oncology studies only" />
        <Stat label="Oncology studies listing this site" value={num(data.studies.length)} sub={data.studies.length >= 200 ? "showing the 200 most recent" : "all statuses in the snapshot"} source="ClinicalTrials.gov API v2" />
        <Stat label="Registry records merged" value={num(f.n_source_records)} sub={`${num(f.n_name_variants)} spelling ${f.n_name_variants === 1 ? "variant" : "variants"}`} source="TrialGraph de-duplication · exact normalised name + city + state + ZIP" />
        <Stat label="Location confidence" value={<span className="capitalize">{f.geocode_confidence}</span>} sub={f.zip_city_gap_mi !== null ? `ZIP centre is ${num(f.zip_city_gap_mi, 1)} mi from the registry city point` : "single coordinate source"} source={METHOD[f.geocode_method] ?? f.geocode_method} />
      </div>
      <div className="grid gap-3 xl:grid-cols-[1fr_1.4fr]">
        <Panel title="Approximate location" note="ZIP-area or city centroid, not a street address. Other institutions under different spellings of the same name are separate records.">
          {f.lat !== null ? <CountyMap facilities={[{ id: f.facility_id, lat: f.lat, lon: f.lon, n: Math.max(1, rec.length), name: f.name, city: f.city, usps: f.usps, anon: f.is_placeholder_name }]} state={f.usps} height={340} facilityLegend="This site" />
            : <p className="text-sm text-muted-foreground">No coordinate is available for this site.</p>}
          {topCats.length > 0 && <p className="mt-2 text-xs">Recruiting by cancer type: {topCats.map(([c, n]) => `${meta?.categories.find((m) => m.id === c)?.label ?? c} (${n})`).join(" · ")}</p>}
        </Panel>
        <Panel title="Oncology studies at this site" note="Recruiting studies first, then most recently updated. Each links to its registry record.">
          <div className="max-h-[440px] overflow-auto"><Table><TableHeader><TableRow><TableHead>NCT ID</TableHead><TableHead>Study</TableHead><TableHead>Study status</TableHead><TableHead>This site</TableHead></TableRow></TableHeader>
            <TableBody data-testid="facility-studies">{data.studies.map((s: Json) => (
              <TableRow key={s.nct_id}><TableCell className="font-mono text-xs"><Link className="text-blue-700 hover:underline" href={`/trials/${s.nct_id}`}>{s.nct_id}</Link></TableCell>
                <TableCell className="max-w-md whitespace-normal text-sm">{s.brief_title}<div className="text-[11px] text-muted-foreground">{(s.phases ?? []).join(" / ").replaceAll("PHASE", "Ph ") || s.study_type.toLowerCase()}</div></TableCell>
                <TableCell><StatusBadge group={s.status_group} label={meta?.statuses.find((x) => x.id === s.status_group)?.label} /></TableCell>
                <TableCell>{s.is_recruiting_site ? <StatusBadge group="recruiting" label="Recruiting" /> : <span className="text-xs text-muted-foreground">{(s.site_status ?? "not reported").toLowerCase().replaceAll("_", " ")}</span>}</TableCell></TableRow>))}
              {!data.studies.length && <TableRow><TableCell colSpan={4} className="text-muted-foreground">No oncology studies list this site in the snapshot.</TableCell></TableRow>}</TableBody></Table></div>
        </Panel>
      </div>
    </>
  );
}
