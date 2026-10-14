/**
 * In-browser port of backend/trialgraph/analysis/engine.py + scoring.py for the static edition.
 *
 * Same inputs (tract centres of population, per-filter nearest-site distances, county profiles) and
 * the same formulas, so results match the API. Two documented differences: the Monte Carlo
 * sensitivity uses a seeded JavaScript PRNG instead of NumPy's (same distribution, different draws),
 * and nearest-site lists use haversine instead of PostGIS spheroidal distance (< 0.5% apart).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

export const EARTH_RADIUS_MI = 6371.0088 / 1.609344;
export const COMPONENTS = ["coverage", "distance_relief", "equity", "rurality", "health_context"] as const;
export const DEFAULT_WEIGHTS: Record<string, number> = { coverage: 0.4, distance_relief: 0.2, equity: 0.2, rurality: 0.1, health_context: 0.1 };
export const COMPONENT_LABELS: Record<string, string> = {
  coverage: "Population newly within threshold",
  distance_relief: "Miles saved per newly covered resident",
  equity: "Socioeconomic barrier index of newly covered residents",
  rurality: "Non-metro share of newly covered residents",
  health_context: "Cancer prevalence context (CDC PLACES)",
};
const DISTANCE_RELIEF_CAP_MI = 100;
const EQUITY = ["acs_pct_poverty", "acs_pct_uninsured", "acs_pct_no_vehicle_hh"];
const BANDS: [number, number, string][] = [[0, 25, "0-25 mi"], [25, 50, "25-50 mi"], [50, 100, "50-100 mi"], [100, Infinity, "100+ mi"]];

export const chordToMiles = (c: number) => 2 * EARTH_RADIUS_MI * Math.asin(Math.min(c / 2, 1));
export const milesToChord = (m: number) => 2 * Math.sin(m / EARTH_RADIUS_MI / 2);
export function toXyz(lat: number, lon: number): [number, number, number] {
  const a = (lat * Math.PI) / 180, b = (lon * Math.PI) / 180;
  return [Math.cos(a) * Math.cos(b), Math.cos(a) * Math.sin(b), Math.sin(a)];
}
export function haversine(lat1: number, lon1: number, lat2: number, lon2: number) {
  const r = Math.PI / 180, dl = (lat2 - lat1) * r, dn = (lon2 - lon1) * r;
  const a = Math.sin(dl / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dn / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
}
const round = (v: number, d: number) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

/** Average-rank percentile in [0,1]; NaN stays NaN (scipy.stats.rankdata 'average'). */
export function pctRank(values: number[]): number[] {
  const idx = values.map((v, i) => [v, i] as [number, number]).filter(([v]) => Number.isFinite(v)).sort((a, b) => a[0] - b[0]);
  const out = new Array(values.length).fill(NaN);
  const n = idx.length;
  if (n < 2) return out;
  for (let i = 0; i < n;) {
    let j = i;
    while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2;  // 0-based average rank
    for (let k = i; k <= j; k++) out[idx[k][1]] = avg / (n - 1);
    i = j + 1;
  }
  return out;
}
function spearman(a: number[], b: number[]) {
  const ra = pctRank(a), rb = pctRank(b);
  const n = ra.length, ma = ra.reduce((s, v) => s + v, 0) / n, mb = rb.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2; }
  return num / Math.sqrt(da * db);
}

export interface County { [k: string]: any }

export class Engine {
  n: number; lat: Float32Array; lon: Float32Array; pop: Float32Array; tc: Int32Array; xyz: Float64Array;
  counties: County[]; nC: number; cUsps: string[]; cMetro: boolean[]; tUsps: string[]; tMetro: boolean[];
  cEquity: number[]; cHealth: number[]; cXyz: [number, number, number][]; supply: Record<string, number[][]>;
  rucc: Record<string, string>; defs: Record<string, any>; compare: string[]; profileCols: string[];
  private base: Record<string, Float32Array> = {};
  private comps = new Map<string, any[]>();
  constructor(buf: ArrayBuffer, cj: any, private loadBase: (cat: string) => Promise<ArrayBuffer>) {
    const f = new Float32Array(buf);
    const n = (this.n = f.length / 4);
    this.lat = f.subarray(0, n); this.lon = f.subarray(n, 2 * n); this.pop = f.subarray(2 * n, 3 * n);
    this.tc = Int32Array.from(f.subarray(3 * n, 4 * n));
    this.xyz = new Float64Array(3 * n);
    for (let i = 0; i < n; i++) { const p = toXyz(this.lat[i], this.lon[i]); this.xyz[3 * i] = p[0]; this.xyz[3 * i + 1] = p[1]; this.xyz[3 * i + 2] = p[2]; }
    this.counties = cj.rows.map((r: any[]) => Object.fromEntries(cj.columns.map((c: string, i: number) => [c, r[i]])));
    this.nC = this.counties.length;
    this.cUsps = this.counties.map((c) => c.usps); this.cMetro = this.counties.map((c) => !!c.is_metro);
    this.tUsps = Array.from(this.tc, (c) => this.cUsps[c]); this.tMetro = Array.from(this.tc, (c) => this.cMetro[c]);
    const pr = EQUITY.map((k) => pctRank(this.counties.map((c) => (c[k] ?? NaN) as number)));
    this.cEquity = this.counties.map((_, i) => { const v = pr.map((p) => p[i]).filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN; });
    this.cHealth = pctRank(this.counties.map((c) => (c.places_cancer_aa ?? NaN) as number));
    this.cXyz = this.counties.map((c) => toXyz(c.centroid_lat, c.centroid_lon));
    this.supply = cj.supply; this.rucc = cj.rucc_description; this.defs = cj.indicator_defs;
    this.compare = cj.compare_indicators; this.profileCols = cj.profile_cols;
  }

  async baseline(cat: string): Promise<Float32Array> {
    if (!this.base[cat]) {
      const b = new Float32Array(await this.loadBase(cat));
      for (let i = 0; i < b.length; i++) if (Number.isNaN(b[i])) b[i] = Infinity;
      this.base[cat] = b;
    }
    return this.base[cat];
  }
  tractMask(state?: string | null): Uint8Array { return Uint8Array.from(this.tUsps, (u) => (!state || u === state ? 1 : 0)); }
  countyMask(state?: string | null): boolean[] { return this.cUsps.map((u) => !state || u === state); }

  // ------------------------------------------------------------- summaries
  summarize(d: ArrayLike<number>, T: number, mask: Uint8Array) {
    let total = 0, within = 0, fs = 0, fp = 0;
    const idx: number[] = [];
    for (let i = 0; i < this.n; i++) {
      if (!mask[i]) continue;
      const p = this.pop[i];
      total += p;
      if (d[i] <= T) within += p;
      if (Number.isFinite(d[i])) { fs += p * d[i]; fp += p; }
      if (p > 0 && Number.isFinite(d[i])) idx.push(i);
    }
    idx.sort((a, b) => d[a] - d[b]);
    const q = (qq: number) => {
      if (!idx.length) return null;
      const target = qq * idx.reduce((s, i) => s + this.pop[i], 0);
      let c = 0;
      for (const i of idx) { c += this.pop[i]; if (c >= target) return round(d[i], 2); }
      return round(d[idx[idx.length - 1]], 2);
    };
    return {
      population: Math.round(total), population_within: Math.round(within), population_beyond: Math.round(total - within),
      pct_within: total ? round((100 * within) / total, 3) : null, pop_weighted_mean_mi: fp ? round(fs / fp, 2) : null,
      pop_weighted_median_mi: q(0.5), pop_weighted_p90_mi: q(0.9),
    };
  }
  groupBreakdown(d: ArrayLike<number>, T: number, mask: Uint8Array) {
    const groups: [string, (i: number) => boolean][] = [["Metro counties (RUCC 1-3)", (i) => this.tMetro[i]], ["Non-metro counties (RUCC 4-9)", (i) => !this.tMetro[i]]];
    for (const [k, label] of [["acs_pct_poverty", "Highest-poverty quartile of counties"], ["acs_pct_uninsured", "Highest-uninsured quartile of counties"],
      ["acs_pct_no_vehicle_hh", "Highest no-vehicle quartile of counties"]]) {
      const pr = pctRank(this.counties.map((c) => (c[k] ?? NaN) as number));
      groups.push([label, (i) => pr[this.tc[i]] >= 0.75]);
    }
    return groups.map(([g, f]) => ({ group: g, ...this.summarize(d, T, Uint8Array.from(mask, (m, i) => (m && f(i) ? 1 : 0))) }));
  }
  countyTable(d: ArrayLike<number>, T: number) {
    const tot = new Float64Array(this.nC), wi = new Float64Array(this.nC), ds = new Float64Array(this.nC), dp = new Float64Array(this.nC);
    for (let i = 0; i < this.n; i++) {
      const c = this.tc[i], p = this.pop[i];
      tot[c] += p; if (d[i] <= T) wi[c] += p;
      if (Number.isFinite(d[i])) { ds[c] += p * d[i]; dp[c] += p; }
    }
    return this.counties.map((c, j) => ({
      fips: c.fips as string, pct_within: tot[j] ? round((100 * wi[j]) / tot[j], 2) : null,
      pop_within: Math.round(wi[j]), pop_beyond: Math.round(tot[j] - wi[j]), mean_mi: dp[j] ? round(ds[j] / dp[j], 2) : null,
    }));
  }
  distanceBands(d: ArrayLike<number>, mask: Uint8Array) {
    let total = 0; const s = BANDS.map(() => 0);
    for (let i = 0; i < this.n; i++) {
      if (!mask[i]) continue; total += this.pop[i];
      BANDS.forEach(([lo, hi], k) => { if ((lo ? d[i] > lo : true) && d[i] <= hi) s[k] += this.pop[i]; });
    }
    return BANDS.map(([, , lab], k) => ({ band: lab, population: Math.round(s[k]), pct: total ? round((100 * s[k]) / total, 3) : null }));
  }
  compareIndicators(d: ArrayLike<number>, T: number, minShare: number, state?: string | null) {
    const ct = this.countyTable(d, T); const cm = this.countyMask(state);
    const cs = this.counties.filter((_, i) => cm[i]); const t = ct.filter((_, i) => cm[i]);
    const gap = t.map((r) => r.pct_within !== null && r.pct_within < minShare);
    const w = cs.map((c) => c.pop_2020 ?? 0);
    const rows = this.compare.map((ind) => {
      const v = cs.map((c) => (c[ind] ?? NaN) as number);
      const wmean = (sel: (i: number) => boolean) => {
        let a = 0, b = 0; v.forEach((x, i) => { if (sel(i) && Number.isFinite(x) && w[i] > 0) { a += x * w[i]; b += w[i]; } });
        return b ? round(a / b, 2) : null;
      };
      const both = v.map((x, i) => Number.isFinite(x) && t[i].mean_mi !== null);
      const xs = t.filter((_, i) => both[i]).map((r) => r.mean_mi as number), ys = v.filter((_, i) => both[i]);
      const rho = xs.length > 10 ? spearman(xs, ys) : NaN;
      return { indicator_id: ind, gap_counties: wmean((i) => gap[i]), other_counties: wmean((i) => !gap[i]),
        n_counties_with_value: v.filter(Number.isFinite).length, n_gap_with_value: v.filter((x, i) => gap[i] && Number.isFinite(x)).length,
        spearman_rho_distance: Number.isFinite(rho) ? round(rho, 3) : null, ...this.defs[ind] };
    });
    return { n_gap_counties: gap.filter(Boolean).length, n_other_counties: gap.filter((g) => !g).length,
      gap_population: w.reduce((a, x, i) => a + (gap[i] ? x : 0), 0), other_population: w.reduce((a, x, i) => a + (gap[i] ? 0 : x), 0), indicators: rows };
  }

  // ------------------------------------------------------------- simulation
  applySites(before: ArrayLike<number>, sites: { lat: number; lon: number }[]) {
    const after = Float64Array.from(before as ArrayLike<number>);
    for (const s of sites) {
      const [x, y, z] = toXyz(s.lat, s.lon);
      for (let i = 0; i < this.n; i++) {
        const dx = this.xyz[3 * i] - x, dy = this.xyz[3 * i + 1] - y, dz = this.xyz[3 * i + 2] - z;
        const m = chordToMiles(Math.sqrt(dx * dx + dy * dy + dz * dz));
        if (m < after[i]) after[i] = m;
      }
    }
    return after;
  }

  private candidateComponentsFor(before: ArrayLike<number>, T: number, state?: string | null) {
    const far: number[] = [];
    for (let i = 0; i < this.n; i++) if (before[i] > T) far.push(i);
    // 1-degree grid over the far tracts, so each candidate only scans nearby cells
    const grid = new Map<string, number[]>();
    for (const i of far) { const k = `${Math.floor(this.lat[i])}|${Math.floor(this.lon[i])}`; (grid.get(k) ?? grid.set(k, []).get(k)!).push(i); }
    const r2 = milesToChord(T) ** 2, dLat = Math.ceil(T / 69) + 1;
    const cm = this.countyMask(state);
    const out: any[] = [];
    this.counties.forEach((c, j) => {
      if (!cm[j]) return;
      const [cx, cy, cz] = this.cXyz[j];
      const la = Math.floor(c.centroid_lat), lo = Math.floor(c.centroid_lon);
      const dLon = Math.min(180, Math.ceil(T / Math.max(5, 69 * Math.cos((Math.min(Math.abs(c.centroid_lat) + dLat, 89) * Math.PI) / 180))) + 1);
      let g = 0, saved = 0, eqN = 0, eqD = 0, rural = 0, hN = 0, hD = 0;
      const touched = new Set<number>();
      for (let a = la - dLat; a <= la + dLat; a++) for (let b = lo - dLon; b <= lo + dLon; b++) {
        let bb = b; if (bb < -180) bb += 360; if (bb >= 180) bb -= 360;
        const cell = grid.get(`${a}|${bb}`); if (!cell) continue;
        for (const i of cell) {
          const dx = this.xyz[3 * i] - cx, dy = this.xyz[3 * i + 1] - cy, dz = this.xyz[3 * i + 2] - cz;
          const d2 = dx * dx + dy * dy + dz * dz; if (d2 > r2) continue;
          const p = this.pop[i]; if (p <= 0) continue;
          const tci = this.tc[i];
          g += p; const dm = chordToMiles(Math.sqrt(d2));
          if (Number.isFinite(before[i])) saved += p * (before[i] - dm);
          const e = this.cEquity[tci]; if (Number.isFinite(e)) { eqN += p * e; eqD += p; }
          if (!this.cMetro[tci]) rural += p;
          const h = this.cHealth[tci]; if (Number.isFinite(h)) { hN += p * h; hD += p; }
          touched.add(tci);
        }
      }
      out.push({ fips: c.fips, name: c.name, usps: c.usps, is_metro: c.is_metro, lat: c.centroid_lat, lon: c.centroid_lon,
        county_population: c.pop_2020, pop_newly_within: Math.round(g), miles_saved_per_person: g ? round(saved / g, 2) : 0,
        equity_index: eqD ? eqN / eqD : null, rural_share: g ? rural / g : null, health_context_pct: hD ? hN / hD : null,
        health_context_coverage: g ? hD / g : 0, counties_reached: touched.size });
    });
    return out;
  }
  async candidateComponents(cat: string, T: number, state?: string | null) {
    const key = `${cat}|${T}|${state ?? "US"}`;
    if (!this.comps.has(key)) this.comps.set(key, this.candidateComponentsFor(await this.baseline(cat), T, state));
    return this.comps.get(key)!;
  }
  score(raw: any[], weights: Record<string, number> | null | undefined, minGain: number) {
    const w = normalizeWeights(weights);
    const df = raw.filter((r) => r.pop_newly_within >= Math.max(1, minGain)).map((r) => ({ ...r }));
    if (!df.length) return { df, comp: [] as number[][], w };
    const maxG = Math.max(...df.map((r) => r.pop_newly_within));
    const comp = df.map((r) => [r.pop_newly_within / maxG, Math.min(1, Math.max(0, r.miles_saved_per_person / DISTANCE_RELIEF_CAP_MI)),
      r.equity_index ?? NaN, r.rural_share ?? NaN, r.health_context_pct ?? NaN]);
    const sc = weightedScore(comp, w);
    const rk = ranks(sc);
    df.forEach((r, i) => { r.score = round(sc[i] * 100, 2); r.rank = rk[i]; COMPONENTS.forEach((k, j) => (r[`c_${k}`] = Number.isFinite(comp[i][j]) ? round(comp[i][j], 4) : null)); });
    const order = df.map((_, i) => i).sort((a, b) => rk[a] - rk[b]);
    return { df: order.map((i) => df[i]), comp: order.map((i) => comp[i]), w };
  }
  async rank(cat: string, T: number, weights: any, state: string | null | undefined, minGain: number) {
    return this.score(await this.candidateComponents(cat, T, state), weights, minGain);
  }
  async plan(cat: string, T: number, weights: any, state: string | null | undefined, k: number, minGain: number) {
    const base = await this.baseline(cat);
    let cur: ArrayLike<number> = base;
    const mask = this.tractMask(state);
    const steps: any[] = [];
    for (let i = 0; i < k; i++) {
      const { df } = this.score(this.candidateComponentsFor(cur, T, state), weights, minGain);
      if (!df.length) break;
      const t = df[0];
      cur = this.applySites(cur, [{ lat: t.lat, lon: t.lon }]);
      const s = this.summarize(cur, T, mask);
      steps.push({ step: i + 1, fips: t.fips, name: t.name, usps: t.usps, is_metro: !!t.is_metro, lat: t.lat, lon: t.lon,
        score_at_selection: t.score, marginal_pop_newly_within: t.pop_newly_within, candidates_remaining: df.length,
        cumulative_pct_within: s.pct_within, cumulative_population_within: s.population_within, cumulative_mean_mi: s.pop_weighted_mean_mi });
    }
    const b = this.summarize(base, T, mask);
    steps.forEach((s) => (s.cumulative_pop_newly_within = s.cumulative_population_within - b.population_within));
    return { before: b, after: this.summarize(cur, T, mask), steps, stopped_early: steps.length < k };
  }
  async sensitivity(cat: string, T: number, weights: any, state: string | null | undefined, minGain: number, topN = 10, nDraws = 500) {
    const { df, comp, w } = await this.rank(cat, T, weights, state, minGain);
    if (!df.length) return { candidates: [], weight_monte_carlo: [], one_at_a_time: [], threshold: [] };
    const top = df.slice(0, topN);
    const rng = mulberry32(20260101);
    const alpha = w.map((x) => Math.max(x * 20, 1e-3));
    const draws: number[][] = [];
    for (let d = 0; d < nDraws; d++) draws.push(ranks(weightedScore(comp, dirichlet(alpha, rng))));
    const mc = top.map((r, i) => {
      const rs = draws.map((x) => x[i]).sort((a, b) => a - b);
      const pq = (q: number) => { const pos = q * (rs.length - 1), lo = Math.floor(pos); return rs[lo] + (rs[Math.min(lo + 1, rs.length - 1)] - rs[lo]) * (pos - lo); };
      return { fips: r.fips, name: r.name, usps: r.usps, baseline_rank: r.rank, median_rank: pq(0.5), p05_rank: pq(0.05), p95_rank: pq(0.95),
        share_top_n: round(rs.filter((x) => x <= topN).length / rs.length, 3) };
    });
    const baseTop = new Set(top.map((r) => r.fips));
    const oat: any[] = [];
    COMPONENTS.forEach((name, k) => [0.5, 1.5].forEach((f) => {
      const ww = w.slice(); ww[k] *= f; const s = ww.reduce((a, b) => a + b, 0); if (s <= 0) return;
      const wn = ww.map((x) => x / s); const rk = ranks(weightedScore(comp, wn));
      const newTop = new Set(df.filter((_, i) => rk[i] <= topN).map((r) => r.fips));
      oat.push({ component: name, factor: f, weights: Object.fromEntries(COMPONENTS.map((c, j) => [c, round(wn[j], 4)])),
        top_n_overlap: [...baseTop].filter((x) => newTop.has(x)).length, new_rank_of_baseline_top1: rk[0], new_top1: df[rk.indexOf(1)]?.fips });
    }));
    const thr: any[] = [];
    for (const t of [...new Set([25, 50, 75, 100, T])].sort((a, b) => a - b)) {
      const { df: d2 } = await this.rank(cat, t, weights, state, minGain);
      const r2 = new Map(d2.map((r) => [r.fips, r.rank]));
      thr.push({ threshold_mi: t, n_candidates: d2.length, top_n_overlap: d2.slice(0, topN).filter((r) => baseTop.has(r.fips)).length,
        top_n: d2.slice(0, topN).map((r) => ({ fips: r.fips, name: r.name, usps: r.usps, score: r.score })),
        baseline_top_ranks: Object.fromEntries(top.map((r) => [r.fips, r2.get(r.fips) ?? null])) });
    }
    return { top_n: topN, n_draws: nDraws, seed: 20260101, dirichlet_concentration: 20, weights: Object.fromEntries(COMPONENTS.map((c, j) => [c, round(w[j], 4)])),
      weight_monte_carlo: mc, one_at_a_time: oat, threshold: thr, rng: "mulberry32 (browser) - draws differ from the NumPy-based API, distribution is identical" };
  }
}

// ------------------------------------------------------------- scoring helpers
export function normalizeWeights(weights?: Record<string, number> | null): number[] {
  const w = COMPONENTS.map((k) => Math.max(0, Number((weights ?? DEFAULT_WEIGHTS)[k] ?? 0)));
  const s = w.reduce((a, b) => a + b, 0);
  if (s <= 0) throw new Error("at least one weight must be positive");
  return w.map((x) => x / s);
}
export function weightedScore(comp: number[][], w: number[]): number[] {
  return comp.map((row) => {
    let num = 0, den = 0;
    row.forEach((v, j) => { if (Number.isFinite(v)) { num += v * w[j]; den += w[j]; } });
    return den > 0 ? num / den : 0;
  });
}
export function ranks(scores: number[]): number[] {
  const order = scores.map((s, i) => [s, i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  const r = new Array(scores.length);
  order.forEach(([, i], k) => (r[i] = k + 1));
  return r;
}
function mulberry32(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function gamma(a: number, rng: () => number): number {
  if (a < 1) return gamma(a + 1, rng) * Math.pow(rng(), 1 / a);
  const d = a - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number, v: number;
    do { const u1 = rng() || 1e-12, u2 = rng(); x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2); v = 1 + c * x; } while (v <= 0);
    v = v * v * v; const u = rng();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
function dirichlet(alpha: number[], rng: () => number) { const g = alpha.map((a) => gamma(a, rng)); const s = g.reduce((a, b) => a + b, 0); return g.map((x) => x / s); }
