/**
 * Static-edition request router: answers the same paths as the FastAPI backend, returning the same
 * response shapes, from the exported snapshot (public/data) plus the in-browser engine.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { COMPONENT_LABELS, COMPONENTS, Engine, haversine } from "./engine";

const BASE = (process.env.NEXT_PUBLIC_BASE_PATH ?? "") + "/data";
const DISTANCE_LABEL = "Straight-line (great-circle) distance in miles - not driving distance or travel time";
const cache = new Map<string, Promise<any>>();
const json = (p: string) => { if (!cache.has(p)) cache.set(p, fetch(`${BASE}/${p}`).then((r) => { if (!r.ok) throw new Error(`${r.status} ${p}`); return r.json(); })); return cache.get(p)!; };
const bin = (p: string) => fetch(`${BASE}/${p}`).then((r) => { if (!r.ok) throw new Error(`${r.status} ${p}`); return r.arrayBuffer(); });

let enginePromise: Promise<Engine> | null = null;
export const engine = () => (enginePromise ??= Promise.all([bin("engine/tracts.bin"), json("engine/counties.json")])
  .then(([b, c]) => new Engine(b, c, (cat) => bin(`engine/base_${cat}.bin`))));

class HttpError extends Error { constructor(public status: number, msg: string) { super(`${status} ${msg}`); } }
const num = (v: any, d: number) => (v === undefined || v === null || v === "" ? d : Number(v));
const cols = (j: { columns: string[]; rows: any[][] }) => j.rows.map((r) => Object.fromEntries(j.columns.map((c, i) => [c, r[i]])));

async function meta() { return json("meta/meta.json"); }
async function checkCat(cat: string) { const m = await meta(); if (!m.categories.some((c: any) => c.id === cat)) throw new HttpError(422, `unknown category '${cat}'`); }
const STATES = new Set("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" "));
function stateOf(s?: string | null) {
  if (!s || s === "US") return null;
  const u = String(s).toUpperCase();
  if (!STATES.has(u)) throw new HttpError(422, `unknown state '${s}'`);  // also keeps user input out of data-file paths
  return u;
}
function hyp(): Promise<string> { return json("meta/brief_text.json").then((b) => b.disclaimer); }

// --------------------------------------------------------------------------- handlers
async function freshness() {
  const f = await json("meta/freshness.json");
  const now = Date.now();
  const sources = f.sources.map((s: any) => {
    const age = (now - new Date(s.retrieved_at).getTime()) / 86400000;
    return { ...s, age_days: Math.round(age * 10) / 10, status: age > s.stale_after_days ? "stale" : "fresh" };
  });
  return { ...f, generated_at: new Date().toISOString(), sources, static_edition: true,
    overall_status: sources.some((s: any) => s.status === "stale") ? "stale" : "fresh",
    ctgov_live: { error: "Static edition: this is a frozen snapshot. Rebuild with the pipeline to refresh." } };
}

async function overview(p: any) {
  const cat = p.category ?? "all", st = stateOf(p.state), T = num(p.threshold_mi, 50);
  await checkCat(cat);
  const [agg, e] = await Promise.all([json(`overview/${cat}_${st ?? "US"}.json`), engine()]);
  const d = await e.baseline(cat), mask = e.tractMask(st);
  const ct = e.countyTable(d, T), cm = e.countyMask(st);
  const per: Record<string, any> = {};
  e.counties.forEach((c, i) => { if (!cm[i]) return; const r = (per[c.usps] ??= { usps: c.usps, population: 0, pop_within: 0, pop_beyond: 0 });
    r.population += c.pop_2020 ?? 0; r.pop_within += ct[i].pop_within; r.pop_beyond += ct[i].pop_beyond; });
  const stateCov = Object.values(per).map((r: any) => ({ ...r, pct_within: Math.round((10000 * r.pop_within) / r.population) / 100 }))
    .sort((a: any, b: any) => a.pct_within - b.pct_within);
  const byState = agg.by_state.map((r: any) => ({ ...r, studies_per_100k: per[r.usps]?.population ? Math.round((1e7 * r.studies) / per[r.usps].population) / 100 : null }));
  return { filters: { category: cat, state: st, threshold_mi: T }, ...agg, by_state: byState, coverage: e.summarize(d, T, mask),
    coverage_by_group: e.groupBreakdown(d, T, mask), distance_bands: e.distanceBands(d, mask), state_coverage: stateCov, distance_label: DISTANCE_LABEL };
}

async function sitesFor(cat: string) { return cols(await json(`sites/${cat}.json`)); }

async function facilities(p: any) {
  const cat = p.category ?? "all", st = stateOf(p.state);
  await checkCat(cat);
  const rows = (await sitesFor(cat)).filter((r) => !st || r.usps === st);
  return { count: rows.length, distinct_locations: new Set(rows.map((r) => `${r.lat},${r.lon}`)).size, facilities: rows,
    note: "Coordinates are ZIP-area or city centroids, not street addresses." };
}

async function accessCounties(p: any) {
  const cat = p.category ?? "all", st = stateOf(p.state), T = num(p.threshold_mi, 50), ms = num(p.min_share, 50);
  await checkCat(cat);
  const e = await engine(); const d = await e.baseline(cat);
  const ct = e.countyTable(d, T), cm = e.countyMask(st), sup = e.supply[cat];
  const rows = e.counties.map((c, i) => ({ fips: c.fips, name: c.name, usps: c.usps, pop_2020: c.pop_2020, rucc_2023: c.rucc_2023, is_metro: c.is_metro,
    ...Object.fromEntries(e.profileCols.map((k) => [k, c[k]])), pct_within: ct[i].pct_within, mean_mi: ct[i].mean_mi, pop_beyond: ct[i].pop_beyond,
    is_gap: ct[i].pct_within !== null && ct[i].pct_within < ms, sites_in_county: sup[0][i], studies_in_county: sup[1][i], studies_50mi: sup[2][i] }))
    .filter((_, i) => cm[i]);
  return { filters: { category: cat, state: st, threshold_mi: T, min_share: ms },
    gap_definition: `County where fewer than ${ms}% of residents live within ${T} straight-line miles of a currently recruiting interventional oncology trial site.`,
    n_counties: rows.length, n_gap_counties: rows.filter((r) => r.is_gap).length, gap_population: rows.filter((r) => r.is_gap).reduce((a, r) => a + (r.pop_2020 ?? 0), 0),
    distance_label: DISTANCE_LABEL, counties: rows };
}

async function accessCompare(p: any) {
  const cat = p.category ?? "all", st = stateOf(p.state), T = num(p.threshold_mi, 50), ms = num(p.min_share, 50);
  await checkCat(cat);
  const e = await engine(); const d = await e.baseline(cat); const mask = e.tractMask(st);
  const out = e.compareIndicators(d, T, ms, st);
  const byRucc: any[] = [];
  for (let code = 1; code <= 9; code++) {
    const m = Uint8Array.from(mask, (v, i) => (v && e.counties[e.tc[i]].rucc_2023 === code ? 1 : 0));
    if (!m.some(Boolean)) continue;
    byRucc.push({ rucc_2023: code, is_metro: code <= 3, n_counties: e.counties.filter((c, i) => c.rucc_2023 === code && e.countyMask(st)[i]).length,
      ...e.summarize(d, T, m), description: e.rucc[String(code)] });
  }
  return { filters: { category: cat, state: st, threshold_mi: T, min_share: ms }, ...out, by_rucc: byRucc,
    metro_vs_nonmetro: e.groupBreakdown(d, T, mask).slice(0, 2),
    caveat: "County-level (ecological) comparison of population-weighted means. Associations describe places, not individuals, and do not establish that distance causes any outcome.",
    distance_label: DISTANCE_LABEL };
}

async function byCategory(p: any) {
  const st = stateOf(p.state), T = num(p.threshold_mi, 50);
  const [m, counts, e] = await Promise.all([meta(), json(`bycat/${st ?? "US"}.json`), engine()]);
  const mask = e.tractMask(st);
  const rows = [];
  for (const c of m.categories) {
    const s = e.summarize(await e.baseline(c.id), T, mask);
    rows.push({ category: c.id, ...s, label: c.label, group: c.group, recruiting_studies: counts[c.id]?.[0] ?? 0, recruiting_facilities: counts[c.id]?.[1] ?? 0,
      pct_beyond: s.pct_within === null ? null : Math.round((100 - s.pct_within) * 1000) / 1000 });
  }
  return { filters: { state: st, threshold_mi: T }, categories: rows, note: counts._note, distance_label: DISTANCE_LABEL };
}

async function countyDetail(fips: string, p: any) {
  const cat = p.category ?? "all", T = num(p.threshold_mi, 50);
  const e = await engine();
  const i = e.counties.findIndex((c) => c.fips === fips);
  if (i < 0) throw new HttpError(404, "county not found");
  const c = e.counties[i]; const d = await e.baseline(cat);
  const [vals, defs, sites] = await Promise.all([json(`county/${c.usps}.json`), json("meta/indicators.json"), sitesFor(cat)]);
  const mine = vals[fips] ?? {};
  const indicators = defs.map((x: any) => { const v = mine[x.indicator_id]; return { indicator_id: x.indicator_id, label: x.label, unit: x.unit, vintage: x.vintage,
    value_type: x.value_type, direction: x.direction, uncertainty: x.uncertainty, source_key: x.source_key, value: v?.[0] ?? null, moe: v?.[1] ?? null,
    ci_low: v?.[2] ?? null, ci_high: v?.[3] ?? null, missing_reason: v ? v[4] : "not_published_for_this_county" }; });
  const nearest = sites.map((s) => ({ facility_id: s.id, name: s.name, is_placeholder_name: s.anon, city: s.city, usps: s.usps, geocode_confidence: s.conf,
    recruiting_studies: s.n, lat: s.lat, lon: s.lon, miles: Math.round(haversine(c.centroid_lat, c.centroid_lon, s.lat, s.lon) * 10) / 10 }))
    .sort((a, b) => a.miles - b.miles).slice(0, 8);
  const sup = e.supply[cat];
  return { county: { fips, name: c.name, usps: c.usps, pop_2020: c.pop_2020, rucc_2023: c.rucc_2023, rucc_description: e.rucc[String(c.rucc_2023)],
    is_metro: c.is_metro, centroid_lat: c.centroid_lat, centroid_lon: c.centroid_lon }, category: cat, threshold_mi: T,
    access: e.countyTable(d, T)[i], access_detail: e.summarize(d, T, Uint8Array.from(e.tc, (x) => (x === i ? 1 : 0))),
    supply: { recruiting_sites_in_county: sup[0][i], recruiting_studies_in_county: sup[1][i], recruiting_studies_50mi: sup[2][i] },
    indicators, nearest_recruiting_sites: nearest, nearest_sites_note: "Miles are straight-line from the county's population-weighted centre.",
    travel_time: { configured: false, message: "Road travel time needs a routing server and is not available in the static edition. Only straight-line distance is shown." },
    distance_label: DISTANCE_LABEL };
}

// ------------------------------------------------------------------- trials
let trialIndex: Promise<any[]> | null = null;
const PH: Record<string, string> = { P1: "PHASE1", P2: "PHASE2", P3: "PHASE3", P4: "PHASE4", EP1: "EARLY_PHASE1", NA: "NA" };
const trials = () => (trialIndex ??= json("trials/index.json").then((j) => cols(j).map((r) => {
  const per: Record<string, [number, number]> = {};
  if (r.site_states) for (const part of String(r.site_states).split(",")) { const [s, a, b] = part.split(":"); per[s] = [Number(a), Number(b)]; }
  return { ...r, phases: (r.phases ?? []).map((p: string) => PH[p] ?? p), per, search: `${r.nct_id} ${r.brief_title} ${(r.conditions ?? []).join(" ")} ${r.lead_sponsor}`.toLowerCase(),
    cancer_categories: (r.filter_keys ?? []).filter((k: string) => !k.startsWith("lens_")), filter_keys: ["all", ...(r.filter_keys ?? [])],
    source_url: `https://clinicaltrials.gov/study/${r.nct_id}` };
})));

async function listTrials(p: any) {
  const cat = p.category ?? "all", st = stateOf(p.state), page = num(p.page, 1), size = Math.min(100, num(p.page_size, 25));
  await checkCat(cat);
  let rows = await trials();
  if (p.include_non_oncology !== "true" && p.include_non_oncology !== true) rows = rows.filter((r) => r.oncology_basis !== "not_oncology");
  if (p.q && String(p.q).trim()) {
    const toks = String(p.q).toLowerCase().split(/\s+/).filter(Boolean);
    rows = rows.filter((r) => toks.every((t) => r.search.includes(t)));
  }
  if (p.status) { const g = String(p.status).split(","); rows = rows.filter((r) => g.includes(r.status_group)); }
  if (cat !== "all") rows = rows.filter((r) => r.filter_keys.includes(cat));
  if (p.phase) rows = rows.filter((r) => r.phases.includes(String(p.phase).toUpperCase()));
  if (p.study_type) rows = rows.filter((r) => r.study_type === p.study_type);
  if (st) rows = rows.filter((r) => r.per[st]);
  const scoped = rows.map((r) => ({ ...r, n_us_sites: st ? r.per[st][0] : r.n_us_sites, n_recruiting_sites: st ? r.per[st][1] : r.n_recruiting_sites }));
  const sort = p.sort ?? "updated";
  if (sort === "sites") scoped.sort((a, b) => b.n_us_sites - a.n_us_sites || a.nct_id.localeCompare(b.nct_id));
  else if (sort === "recruiting_sites") scoped.sort((a, b) => b.n_recruiting_sites - a.n_recruiting_sites || a.nct_id.localeCompare(b.nct_id));
  else if (sort === "nct") scoped.sort((a, b) => a.nct_id.localeCompare(b.nct_id));
  return { total: scoped.length, page, page_size: size, site_counts_scope: st ?? "US",
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    trials: scoped.slice((page - 1) * size, page * size).map(({ per, search, ...r }) => r) };
}

async function siteCodes() { return json("trials/codes.json"); }
async function trialDetail(nct: string) {
  nct = nct.toUpperCase();
  const [shard, codes, e] = await Promise.all([json(`trials/d${nct.slice(-3)}.json`).catch(() => ({})), siteCodes(), engine()]);
  const rec = shard[nct];
  if (!rec) throw new HttpError(404, "study not in the TrialGraph snapshot");
  const sites = rec.sites.map((r: any[]) => ({ facility_id: r[0], name_on_record: r[1], city: r[2], usps: r[3], site_status: codes.site_status[r[4]] || null,
    is_recruiting_site: !!r[5], geocode_method: codes.geocode_method[r[6]], geocode_confidence: codes.geocode_confidence[r[7]], lat: r[8], lon: r[9],
    county_name: r[10] === null ? null : e.counties[r[10]]?.name, is_placeholder_name: !!r[11] }));
  return { study: { ...rec.study, source_url: `https://clinicaltrials.gov/study/${nct}` }, sites,
    site_summary: { us_sites: sites.length, recruiting_sites: sites.filter((s: any) => s.is_recruiting_site).length },
    notes: ["Sites outside the 50 states and DC are not included.", "Enrollment counts are sponsor-reported targets or actuals for the whole study, not site capacity.",
      "Eligibility is summarised from registry metadata only; this tool does not assess individual eligibility."] };
}

async function facilityDetail(id: number) {
  const [shard, fcols, codes, idx] = await Promise.all([json(`facility/f${String(id % 1000).padStart(3, "0")}.json`), json("facility/columns.json"), siteCodes(), trials()]);
  const rec = shard[id];
  if (!rec) throw new HttpError(404, "facility not found");
  const facility = Object.fromEntries((fcols as string[]).map((c, i) => [c, rec[0][i]]));
  const byId = new Map(idx.map((r) => [r.nct_id, r]));
  const order = new Map(idx.map((r, i) => [r.nct_id, i]));
  const studies = rec[1].map(([nct, sc, isr]: any[]) => { const s = byId.get(nct); return s && s.oncology_basis !== "not_oncology" ? {
    nct_id: nct, brief_title: s.brief_title, status_group: s.status_group, site_status: codes.site_status[sc] || null, is_recruiting_site: !!isr,
    phases: s.phases, study_type: s.study_type, cancer_categories: s.cancer_categories, source_url: s.source_url } : null; })
    .filter(Boolean).sort((a: any, b: any) => Number(b.is_recruiting_site) - Number(a.is_recruiting_site) || (order.get(a.nct_id)! - order.get(b.nct_id)!)).slice(0, 200);
  return { facility, studies };
}

// ------------------------------------------------------------------- simulator
function params(b: any) {
  const cat = b.category ?? "all"; const st = stateOf(b.state); const T = num(b.threshold_mi, 50);
  if (T < 5 || T > 250) throw new HttpError(422, "threshold_mi out of range");
  return { cat, st, T };
}
async function simulate(b: any) {
  const { cat, st, T } = params(b); await checkCat(cat);
  if (!b.sites?.length) throw new HttpError(422, "at least one site is required");
  const e = await engine(); const before = await e.baseline(cat); const after = e.applySites(before, b.sites);
  const mask = e.tractMask(st);
  const bc = e.countyTable(before, T), ac = e.countyTable(after, T), cm = e.countyMask(st);
  const aff = e.counties.map((c, i) => ({ fips: c.fips, name: c.name, usps: c.usps, is_metro: c.is_metro, population: c.pop_2020,
    pct_within_before: bc[i].pct_within, pct_within_after: ac[i].pct_within, pop_newly_within: ac[i].pop_within - bc[i].pop_within,
    mean_mi_before: bc[i].mean_mi, mean_mi_after: ac[i].mean_mi }))
    .filter((r, i) => cm[i] && (r.pop_newly_within > 0 || ((r.mean_mi_before ?? 0) - (r.mean_mi_after ?? 0)) > 0.05))
    .sort((a, b2) => b2.pop_newly_within - a.pop_newly_within);
  const bs = e.summarize(before, T, mask), as = e.summarize(after, T, mask);
  const gb = e.groupBreakdown(before, T, mask), ga = e.groupBreakdown(after, T, mask);
  return { params: b, before: bs, after: as,
    delta: { population_newly_within: as.population_within - bs.population_within, pct_within_change: Math.round(((as.pct_within ?? 0) - (bs.pct_within ?? 0)) * 1000) / 1000,
      pop_weighted_mean_mi_change: Math.round(((as.pop_weighted_mean_mi ?? 0) - (bs.pop_weighted_mean_mi ?? 0)) * 100) / 100 },
    equity_groups: gb.map((g, i) => ({ group: g.group, population: g.population, pct_within_before: g.pct_within, pct_within_after: ga[i].pct_within,
      population_newly_within: ga[i].population_within - g.population_within, mean_mi_before: g.pop_weighted_mean_mi, mean_mi_after: ga[i].pop_weighted_mean_mi })),
    n_affected_counties: aff.length, affected_counties: aff.slice(0, 60),
    assumptions: ["The hypothetical site is assumed to recruit for the selected cancer category.",
      "A resident is 'covered' when their census tract's centre of population is within the threshold, in straight-line miles.",
      "No capacity, eligibility, referral-pattern or travel-time effects are modelled.", "Equity groups are defined by county-level characteristics (ecological), not individuals."],
    disclaimer: await hyp(), distance_label: DISTANCE_LABEL };
}
const METHOD = {
  candidate_definition: "One hypothetical site at the population-weighted centre of each county in scope.",
  score: "100 x weighted average of the components below; weights are normalised to sum to 1.",
  components: { coverage: "pop_newly_within / max(pop_newly_within) across candidates in scope", distance_relief: "min(miles_saved_per_person / 100, 1)",
    equity: "population-weighted mean national percentile of poverty, uninsured and no-vehicle rates (ACS) for newly covered residents' counties",
    rurality: "share of newly covered residents in non-metro counties (USDA RUCC 4-9)",
    health_context: "population-weighted national percentile of age-adjusted cancer prevalence (CDC PLACES); skipped where not published" },
  min_gain_pop: "Candidates that would bring fewer than this many residents within the threshold are not ranked.",
  independence: "Candidates are scored one at a time against today's baseline; scores are not additive across candidates.",
};
async function candidates(b: any) {
  const { cat, st, T } = params(b); await checkCat(cat);
  const e = await engine();
  let r; try { r = await e.rank(cat, T, b.weights, st, num(b.min_gain_pop, 5000)); } catch (err) { throw new HttpError(422, String((err as Error).message)); }
  return { params: b, weights: Object.fromEntries(COMPONENTS.map((c, j) => [c, Math.round(r.w[j] * 10000) / 10000])), component_labels: COMPONENT_LABELS,
    n_candidates: r.df.length, candidates: r.df.slice(0, num(b.limit, 25)), method: METHOD, disclaimer: await hyp(), distance_label: DISTANCE_LABEL };
}
async function plan(b: any) {
  const { cat, st, T } = params(b); await checkCat(cat);
  const k = num(b.k, 3); if (k < 1 || k > 8) throw new HttpError(422, "k must be 1-8");
  const out = await (await engine()).plan(cat, T, b.weights, st, k, num(b.min_gain_pop, 5000));
  return { params: b, ...out, method: "Greedy sequential selection: at each step every county is re-scored against today's baseline plus the hypothetical sites already chosen, and the top-scoring one is added. A heuristic, not a guaranteed optimum.",
    disclaimer: await hyp(), distance_label: DISTANCE_LABEL };
}
async function sensitivity(b: any) {
  const { cat, st, T } = params(b); await checkCat(cat);
  const out = await (await engine()).sensitivity(cat, T, b.weights, st, num(b.min_gain_pop, 5000), num(b.top_n, 10));
  return { params: b, ...out, how_to_read: {}, disclaimer: await hyp() };
}

// ------------------------------------------------------------------- brief
export async function brief(p: any) {
  const cat = p.category ?? "all", st = stateOf(p.state), T = num(p.threshold_mi, 50);
  const [m, ov, cmp, e, bt, fr] = await Promise.all([meta(), overview(p), accessCompare({ ...p, min_share: 50 }), engine(), json("meta/brief_text.json"), freshness()]);
  const r = await e.rank(cat, T, null, st, 5000);
  const sens = r.df.length ? await e.sensitivity(cat, T, null, st, 5000) : null;
  const cov = ov.coverage, sites = ov.recruiting_sites;
  const rec = ov.status_counts.find((s: any) => s.status_group === "recruiting") ?? { studies: 0, interventional: 0 };
  const total = ov.status_counts.reduce((a: number, s: any) => a + s.studies, 0);
  const [metro, non] = cmp.metro_vs_nonmetro;
  const where = st ?? "the 50 states and DC";
  const lab = m.categories.find((c: any) => c.id === cat)?.label ?? "All oncology";
  const label = cat === "all" ? "oncology" : lab.toLowerCase();
  const f = (n: number) => n.toLocaleString("en-US");
  const ind = Object.fromEntries(cmp.indicators.map((i: any) => [i.indicator_id, i]));
  const findings: any[] = [
    { title: "Only a minority of registered studies are recruiting now",
      text: `Of ${f(total)} ${label} studies with sites in ${where} in the snapshot, ${f(rec.studies)} are listed as Recruiting (${f(rec.interventional)} interventional). ${f(sites.recruiting_studies_with_recruiting_site)} interventional studies have at least one site that is itself recruiting, across ${f(sites.recruiting_facilities)} facility records in ${f(sites.counties_with_recruiting_site)} counties.`,
      trace: "ClinicalTrials.gov API v2: overallStatus and per-location status" },
    { title: `${cov.pct_within?.toFixed(1)}% of residents live within ${T} straight-line miles of a recruiting site`,
      text: `${f(cov.population_beyond)} of ${f(cov.population)} residents (2020 Census) live farther than ${T} miles. The population-weighted median distance is ${cov.pop_weighted_median_mi} miles and the 90th percentile is ${cov.pop_weighted_p90_mi} miles.`,
      trace: "Calculation: tract centres of population (2020 Census) to nearest analysis site" },
  ];
  if (metro.population && non.population) findings.push({ title: "Non-metro residents are farther from recruiting sites",
    text: `${non.pct_within?.toFixed(1)}% of non-metro residents are within ${T} miles, versus ${metro.pct_within?.toFixed(1)}% of metro residents; population-weighted mean distance is ${non.pop_weighted_mean_mi} vs ${metro.pop_weighted_mean_mi} miles.`,
    trace: "Calculation grouped by USDA ERS Rural-Urban Continuum Codes 2023" });
  if (cmp.n_gap_counties) { const pv = ind.acs_pct_poverty, ui = ind.acs_pct_uninsured; findings.push({ title: `${f(cmp.n_gap_counties)} counties are access gaps at this threshold`,
    text: `They hold ${f(cmp.gap_population)} residents. Population-weighted poverty is ${pv.gap_counties}% in gap counties vs ${pv.other_counties}% elsewhere; the uninsured rate is ${ui.gap_counties}% vs ${ui.other_counties}% (ACS ${pv.vintage}). These are county-level associations, not causal findings.`,
    trace: "Calculation joined to ACS 5-year county estimates" }); }
  if (r.df.length && sens) { const t = r.df[0], s0 = sens.weight_monte_carlo[0]; findings.push({ title: "Largest modelled coverage opportunity (hypothetical)",
    text: `A hypothetical site at the population centre of ${t.name}, ${t.usps} would bring ${f(t.pop_newly_within)} more residents within ${T} miles (score ${t.score}). It stays in the top ${sens.top_n} in ${Math.round((s0.share_top_n ?? 0) * 100)}% of ${sens.n_draws} alternative weightings.`,
    trace: "Site Strategy Simulator, default weights; sensitivity analysis" }); }
  return { title: `Geographic access to recruiting ${label} trials - ${st ?? "United States"}`, generated_at: new Date().toISOString(),
    filters: { category: cat, state: st, threshold_mi: T }, key_findings: findings,
    headline: { coverage: cov, recruiting_sites: sites, status_counts: ov.status_counts, metro, nonmetro: non, n_gap_counties: cmp.n_gap_counties, gap_population: cmp.gap_population },
    ranked_opportunities: r.df.slice(0, 10), weights: Object.fromEntries(COMPONENTS.map((c, j) => [c, r.w[j]])), component_labels: COMPONENT_LABELS,
    sensitivity: sens, indicator_comparison: cmp.indicators, methodology: bt.methodology, limitations: bt.limitations,
    sources: fr.sources, freshness: fr.overall_status, disclaimer: bt.disclaimer, distance_label: DISTANCE_LABEL };
}

// ------------------------------------------------------------------- dispatch
export async function staticGet(path: string, p: Record<string, any> = {}): Promise<any> {
  const m = path.match(/^\/api\/(.+)$/); if (!m) throw new HttpError(404, path);
  const r = m[1];
  if (r === "health") return { status: "ok", static_edition: true };
  if (r === "meta") return meta();
  if (r === "meta/freshness") return freshness();
  if (r === "meta/indicators") return json("meta/indicators.json");
  if (r === "meta/quality") return json("meta/quality.json");
  if (r === "overview") return overview(p);
  if (r === "facilities") return facilities(p);
  if (r === "access/counties") return accessCounties(p);
  if (r === "access/compare") return accessCompare(p);
  if (r === "access/by-category") return byCategory(p);
  if (r === "insights") { const t = num(p.threshold_mi, 50); if (![25, 50, 75, 100].includes(t)) throw new HttpError(422, "static edition has insights for 25/50/75/100 mi"); return json(`insights/${t}.json`); }
  if (r === "trials") return listTrials(p);
  if (r === "brief") return brief(p);
  let x;
  if ((x = r.match(/^access\/county\/(\d{5})$/))) return countyDetail(x[1], p);
  if ((x = r.match(/^trials\/(NCT\d{8})$/i))) return trialDetail(x[1]);
  if ((x = r.match(/^facilities\/(\d+)$/))) return facilityDetail(Number(x[1]));
  if ((x = r.match(/^geo\/(counties|states)$/))) return json(`geo/${x[1]}.json`);
  throw new HttpError(404, path);
}
export async function staticPost(path: string, body: any): Promise<any> {
  if (path === "/api/simulator/simulate") return simulate(body);
  if (path === "/api/simulator/candidates") return candidates(body);
  if (path === "/api/simulator/plan") return plan(body);
  if (path === "/api/simulator/sensitivity") return sensitivity(body);
  throw new HttpError(404, path);
}
