"""In-memory access model used by the API: county summaries, what-if simulation, candidate ranking.

The model holds ~84k tract centres of population and, per cancer category, each tract's
baseline distance to the nearest currently-recruiting site (from `tract_access`). A
hypothetical site can only shorten a tract's distance, so every scenario is

    after_i = min(before_i, great_circle(tract_i, new_site))

which makes recalculation exact and fast (no re-run of the baseline needed).
"""
from __future__ import annotations

import threading
from dataclasses import dataclass

import numpy as np
import pandas as pd
from scipy.spatial import cKDTree
from scipy.stats import rankdata, spearmanr
from sqlalchemy import text

from ..db import get_read_engine
from . import scoring as S
from .access import CATEGORIES
from .distance import chord_to_miles, miles_to_chord, to_unit_xyz

EQUITY_INDICATORS = ["acs_pct_poverty", "acs_pct_uninsured", "acs_pct_no_vehicle_hh"]
HEALTH_CONTEXT_INDICATOR = "places_cancer_aa"
COMPARE_INDICATORS = ["acs_median_hh_income", "acs_pct_poverty", "acs_pct_uninsured", "acs_pct_no_vehicle_hh",
                      "acs_pct_no_internet_hh", "acs_pct_65_plus", "acs_pct_people_of_color", "places_cancer_aa",
                      "places_csmoking_aa", "places_lacktrpt_aa", "places_colon_screen_aa", "places_mammouse_aa"]
DISTANCE_BANDS = [(0, 25, "0-25 mi"), (25, 50, "25-50 mi"), (50, 100, "50-100 mi"), (100, np.inf, "100+ mi")]


def pct_rank(values: np.ndarray) -> np.ndarray:
    """National percentile rank in [0,1] among non-missing values; NaN stays NaN."""
    out = np.full(len(values), np.nan)
    ok = ~np.isnan(values)
    if ok.sum() > 1:
        out[ok] = (rankdata(values[ok], method="average") - 1) / (ok.sum() - 1)
    return out


def weighted_quantile(values: np.ndarray, weights: np.ndarray, q: float) -> float | None:
    ok = np.isfinite(values) & (weights > 0)
    if not ok.any():
        return None
    v, w = values[ok], weights[ok]
    o = np.argsort(v)
    cw = np.cumsum(w[o])
    return float(v[o][np.searchsorted(cw, q * cw[-1])])


@dataclass
class Scope:
    """Subset of tracts/counties an analysis is reported for."""
    state: str | None = None

    def key(self) -> str:
        return self.state or "US"


class AccessModel:
    def __init__(self) -> None:
        eng = get_read_engine()
        with eng.connect() as conn:
            self.run_id = conn.execute(text("SELECT max(run_id) FROM pipeline_run")).scalar()
            self.counties = pd.read_sql(text("SELECT * FROM county_profile ORDER BY fips"), conn)
            tr = pd.read_sql(text("""
                SELECT t.geoid, t.county_fips, t.pop_2020 AS pop, ST_Y(t.geom::geometry) AS lat, ST_X(t.geom::geometry) AS lon
                FROM tract_center t ORDER BY t.geoid"""), conn)
        self.tracts = tr
        self.pop = tr["pop"].to_numpy(dtype=float)
        self.xyz = to_unit_xyz(tr.lat, tr.lon)
        self.tree = cKDTree(self.xyz)
        c = self.counties
        self.n_c = len(c)
        cidx = {f: i for i, f in enumerate(c.fips)}
        self.tract_county = tr.county_fips.map(cidx).to_numpy(dtype=int)
        self.county_xyz = to_unit_xyz(c.centroid_lat, c.centroid_lon)
        self.c_usps = c.usps.to_numpy()
        self.c_metro = c.is_metro.fillna(False).to_numpy(dtype=bool)
        self.tract_usps = self.c_usps[self.tract_county]
        self.tract_metro = self.c_metro[self.tract_county]
        # county-level need inputs as national percentiles (transparent, unit-free)
        pr = np.column_stack([pct_rank(c[i].to_numpy(dtype=float)) for i in EQUITY_INDICATORS])
        self.c_equity = np.nanmean(pr, axis=1)
        self.c_health = pct_rank(c[HEALTH_CONTEXT_INDICATOR].to_numpy(dtype=float))
        self._baseline: dict[str, np.ndarray] = {}
        self._components: dict[tuple, pd.DataFrame] = {}
        self._lock = threading.Lock()

    # ------------------------------------------------------------------ baseline
    def baseline(self, category: str) -> np.ndarray:
        if category not in CATEGORIES:
            raise KeyError(category)
        with self._lock:
            if category not in self._baseline:
                with get_read_engine().connect() as conn:
                    df = pd.read_sql(text("SELECT geoid, nearest_mi FROM tract_access WHERE category = :c ORDER BY geoid"),
                                     conn, params={"c": category})
                if not df.geoid.equals(self.tracts.geoid):
                    raise RuntimeError("tract_access is out of sync with tract_center - re-run `trialgraph analyze`")
                self._baseline[category] = df.nearest_mi.fillna(np.inf).to_numpy(dtype=float)
            return self._baseline[category]

    def tract_mask(self, scope: Scope) -> np.ndarray:
        return np.ones(len(self.pop), bool) if not scope.state else (self.tract_usps == scope.state)

    def county_mask(self, scope: Scope) -> np.ndarray:
        return np.ones(self.n_c, bool) if not scope.state else (self.c_usps == scope.state)

    # ------------------------------------------------------------------ summaries
    def summarize(self, dist: np.ndarray, threshold: float, mask: np.ndarray | None = None) -> dict:
        m = np.ones(len(dist), bool) if mask is None else mask
        pop, d = self.pop[m], dist[m]
        total = pop.sum()
        within = pop[d <= threshold].sum()
        finite = np.isfinite(d)
        return {
            "population": int(total),
            "population_within": int(within),
            "population_beyond": int(total - within),
            "pct_within": round(float(100 * within / total), 3) if total else None,
            "pop_weighted_mean_mi": round(float((pop[finite] * d[finite]).sum() / pop[finite].sum()), 2) if pop[finite].sum() else None,
            "pop_weighted_median_mi": (lambda v: round(v, 2) if v is not None else None)(weighted_quantile(d, pop, 0.5)),
            "pop_weighted_p90_mi": (lambda v: round(v, 2) if v is not None else None)(weighted_quantile(d, pop, 0.9)),
        }

    def group_breakdown(self, dist: np.ndarray, threshold: float, mask: np.ndarray) -> list[dict]:
        """Coverage for population groups defined at COUNTY level (ecological, not individual)."""
        c = self.counties
        groups = [("Metro counties (RUCC 1-3)", self.tract_metro), ("Non-metro counties (RUCC 4-9)", ~self.tract_metro)]
        for ind, label in [("acs_pct_poverty", "Highest-poverty quartile of counties"),
                           ("acs_pct_uninsured", "Highest-uninsured quartile of counties"),
                           ("acs_pct_no_vehicle_hh", "Highest no-vehicle quartile of counties")]:
            groups.append((label, (pct_rank(c[ind].to_numpy(dtype=float)) >= 0.75)[self.tract_county]))
        return [{"group": g, **self.summarize(dist, threshold, mask & gm)} for g, gm in groups]

    def county_table(self, category: str, threshold: float, dist: np.ndarray | None = None) -> pd.DataFrame:
        d = self.baseline(category) if dist is None else dist
        ci, pop = self.tract_county, self.pop
        tot = np.bincount(ci, pop, self.n_c)
        within = np.bincount(ci, pop * (d <= threshold), self.n_c)
        fin = np.isfinite(d)
        dsum = np.bincount(ci[fin], (pop * np.where(fin, d, 0))[fin], self.n_c)
        popfin = np.bincount(ci[fin], pop[fin], self.n_c)
        with np.errstate(divide="ignore", invalid="ignore"):
            out = pd.DataFrame({
                "fips": self.counties.fips,
                "pct_within": np.round(100 * within / tot, 2),
                "pop_within": within.astype(int),
                "pop_beyond": (tot - within).astype(int),
                "mean_mi": np.round(dsum / popfin, 2),
            })
        return out

    def distance_bands(self, category: str, mask: np.ndarray) -> list[dict]:
        d, pop = self.baseline(category)[mask], self.pop[mask]
        total = pop.sum()
        out = []
        for lo, hi, lab in DISTANCE_BANDS:
            p = float(pop[(d > lo) & (d <= hi) if lo else (d <= hi)].sum())
            out.append({"band": lab, "population": int(p), "pct": round(100 * p / total, 3) if total else None})
        return out

    def compare_indicators(self, category: str, threshold: float, min_share: float, scope: Scope) -> dict:
        """Access vs socioeconomic indicators at county level. Associations, not causal claims."""
        ct = self.county_table(category, threshold)
        cm = self.county_mask(scope)
        c = self.counties[cm].reset_index(drop=True)
        ct = ct[cm].reset_index(drop=True)
        gap = (ct.pct_within < min_share).to_numpy()
        w = c.pop_2020.to_numpy(dtype=float)
        rows = []
        for ind in COMPARE_INDICATORS:
            v = c[ind].to_numpy(dtype=float)
            ok = ~np.isnan(v)

            def wmean(sel, v=v, ok=ok):
                s = sel & ok & (w > 0)
                return round(float((v[s] * w[s]).sum() / w[s].sum()), 2) if s.any() else None
            both = ok & ct.mean_mi.notna().to_numpy()
            rho = spearmanr(ct.mean_mi[both], v[both]).statistic if both.sum() > 10 else np.nan
            rows.append({"indicator_id": ind, "gap_counties": wmean(gap), "other_counties": wmean(~gap),
                         "n_counties_with_value": int(ok.sum()), "n_gap_with_value": int((gap & ok).sum()),
                         "spearman_rho_distance": None if np.isnan(rho) else round(float(rho), 3)})
        return {"n_gap_counties": int(gap.sum()), "n_other_counties": int((~gap).sum()),
                "gap_population": int(w[gap].sum()), "other_population": int(w[~gap].sum()), "indicators": rows}

    # ------------------------------------------------------------------ simulation
    def apply_sites(self, before: np.ndarray, sites: list[tuple[float, float]]) -> np.ndarray:
        after = before.copy()
        for lat, lon in sites:
            chord = np.linalg.norm(self.xyz - to_unit_xyz([lat], [lon])[0], axis=1)
            np.minimum(after, chord_to_miles(chord), out=after)
        return after

    def simulate(self, category: str, threshold: float, sites: list[tuple[float, float]], scope: Scope) -> dict:
        before = self.baseline(category)
        after = self.apply_sites(before, sites)
        m = self.tract_mask(scope)
        b_ct, a_ct = self.county_table(category, threshold, before), self.county_table(category, threshold, after)
        changed = (a_ct.pop_within > b_ct.pop_within) | ((b_ct.mean_mi - a_ct.mean_mi) > 0.05)
        changed &= self.county_mask(scope)
        c = self.counties
        aff = pd.DataFrame({
            "fips": c.fips, "name": c.name, "usps": c.usps, "is_metro": c.is_metro, "population": c.pop_2020,
            "pct_within_before": b_ct.pct_within, "pct_within_after": a_ct.pct_within,
            "pop_newly_within": a_ct.pop_within - b_ct.pop_within,
            "mean_mi_before": b_ct.mean_mi, "mean_mi_after": a_ct.mean_mi,
        })[changed].sort_values("pop_newly_within", ascending=False)
        return {
            "before": self.summarize(before, threshold, m),
            "after": self.summarize(after, threshold, m),
            "groups_before": self.group_breakdown(before, threshold, m),
            "groups_after": self.group_breakdown(after, threshold, m),
            "affected_counties": aff,
            "n_affected_counties": int(changed.sum()),
        }

    # ------------------------------------------------------------------ candidate ranking
    def candidate_components(self, category: str, threshold: float, scope_key: str) -> pd.DataFrame:
        """Raw component values for every candidate county (hypothetical site at its population centroid). Cached."""
        key = (category, float(threshold), scope_key)
        if key not in self._components:
            if len(self._components) > 128:
                self._components.clear()
            self._components[key] = self._candidate_components(*key)
        return self._components[key]

    def _candidate_components(self, category: str, threshold: float, scope_key: str,
                              before: np.ndarray | None = None) -> pd.DataFrame:
        scope = Scope(None if scope_key == "US" else scope_key)
        before = self.baseline(category) if before is None else before
        far = np.where(before > threshold)[0]          # only tracts currently beyond the threshold can be "newly covered"
        cand = np.where(self.county_mask(scope))[0]
        n = len(cand)
        gain = np.zeros(n); saved = np.zeros(n); eq = np.full(n, np.nan); rural = np.full(n, np.nan)
        hc = np.full(n, np.nan); hc_cov = np.zeros(n); ncount = np.zeros(n, dtype=int)
        if len(far):
            tree = cKDTree(self.xyz[far])
            hits = tree.query_ball_point(self.county_xyz[cand], r=float(miles_to_chord(threshold)))
            for j, h in enumerate(hits):
                if not h:
                    continue
                ti = far[np.asarray(h)]
                p = self.pop[ti]
                g = p.sum()
                if g <= 0:
                    continue
                d = chord_to_miles(np.linalg.norm(self.xyz[ti] - self.county_xyz[cand[j]], axis=1))
                b = np.where(np.isfinite(before[ti]), before[ti], np.nan)
                gain[j] = g
                saved[j] = np.nansum(p * (b - d)) / g
                tc = self.tract_county[ti]
                e = self.c_equity[tc]
                eq[j] = np.nansum(p * e) / p[~np.isnan(e)].sum() if (~np.isnan(e)).any() else np.nan
                rural[j] = (p * ~self.c_metro[tc]).sum() / g
                hv = self.c_health[tc]
                okh = ~np.isnan(hv)
                if okh.any() and p[okh].sum() > 0:
                    hc[j] = (p[okh] * hv[okh]).sum() / p[okh].sum()
                    hc_cov[j] = p[okh].sum() / g
                ncount[j] = len(np.unique(tc))
        c = self.counties.iloc[cand]
        return pd.DataFrame({
            "fips": c.fips.values, "name": c.name.values, "usps": c.usps.values, "is_metro": c.is_metro.values,
            "lat": c.centroid_lat.values, "lon": c.centroid_lon.values, "county_population": c.pop_2020.values,
            "pop_newly_within": gain.astype(int), "miles_saved_per_person": np.round(saved, 2),
            "equity_index": eq, "rural_share": rural, "health_context_pct": hc, "health_context_coverage": hc_cov,
            "counties_reached": ncount,
        })

    def rank_candidates(self, category: str, threshold: float, weights: dict | None, scope: Scope,
                        min_gain_pop: int = 5000) -> tuple[pd.DataFrame, np.ndarray, np.ndarray]:
        raw = self.candidate_components(category, float(threshold), scope.key())
        return self._score(raw, weights, min_gain_pop)

    def _score(self, raw: pd.DataFrame, weights: dict | None, min_gain_pop: int) -> tuple[pd.DataFrame, np.ndarray, np.ndarray]:
        df = raw[raw.pop_newly_within >= max(1, min_gain_pop)].reset_index(drop=True).copy()
        w = S.normalize_weights(weights)
        if df.empty:
            return df.assign(score=[], rank=[]), np.empty((0, len(S.COMPONENTS))), w
        comp = np.column_stack([
            df.pop_newly_within / df.pop_newly_within.max(),
            np.clip(df.miles_saved_per_person / S.DISTANCE_RELIEF_CAP_MI, 0, 1),
            df.equity_index, df.rural_share, df.health_context_pct,
        ]).astype(float)
        df["score"] = np.round(S.weighted_score(comp, w) * 100, 2)
        df["rank"] = S.ranks(df.score.to_numpy())
        for k, name in enumerate(S.COMPONENTS):
            df[f"c_{name}"] = np.round(comp[:, k], 4)
        order = np.argsort(df["rank"].to_numpy())
        return df.iloc[order].reset_index(drop=True), comp[order], w

    def greedy_plan(self, category: str, threshold: float, weights: dict | None, scope: Scope, k: int = 3,
                    min_gain_pop: int = 5000) -> dict:
        """Sequential (greedy) multi-site plan.

        Step 1 picks the top-scoring candidate against today's baseline. Each later step re-scores every
        candidate against the baseline *plus the sites already chosen*, so overlapping candidates that
        would serve the same residents are not picked twice. Greedy selection is a standard heuristic
        for coverage problems; it is not guaranteed to be the optimal set of k sites.
        """
        base = self.baseline(category)
        current = base.copy()
        mask = self.tract_mask(scope)
        steps: list[dict] = []
        for i in range(k):
            raw = self._candidate_components(category, float(threshold), scope.key(), before=current)
            df, _, _ = self._score(raw, weights, min_gain_pop)
            if df.empty:
                break
            t = df.iloc[0]
            current = self.apply_sites(current, [(float(t.lat), float(t.lon))])
            s = self.summarize(current, threshold, mask)
            steps.append({
                "step": i + 1, "fips": t.fips, "name": t["name"], "usps": t.usps, "is_metro": bool(t.is_metro),
                "lat": float(t.lat), "lon": float(t.lon), "score_at_selection": float(t.score),
                "marginal_pop_newly_within": int(t.pop_newly_within), "candidates_remaining": int(len(df)),
                "cumulative_pct_within": s["pct_within"], "cumulative_population_within": s["population_within"],
                "cumulative_mean_mi": s["pop_weighted_mean_mi"],
            })
        b = self.summarize(base, threshold, mask)
        for st in steps:
            st["cumulative_pop_newly_within"] = st["cumulative_population_within"] - b["population_within"]
        return {"before": b, "after": self.summarize(current, threshold, mask), "steps": steps,
                "stopped_early": len(steps) < k}

    def category_coverage(self, threshold: float, scope: Scope) -> list[dict]:
        """Coverage summary for every cancer category (same tracts, different site sets)."""
        mask = self.tract_mask(scope)
        return [{"category": c, **self.summarize(self.baseline(c), threshold, mask)} for c in CATEGORIES]

    def sensitivity(self, category: str, threshold: float, weights: dict | None, scope: Scope, min_gain_pop: int = 5000,
                    top_n: int = 10, n_draws: int = 500) -> dict:
        df, comp, w = self.rank_candidates(category, threshold, weights, scope, min_gain_pop)
        if df.empty:
            return {"candidates": [], "weight_monte_carlo": [], "one_at_a_time": [], "threshold": []}
        top = df.head(top_n)
        mc = S.weight_monte_carlo(comp, w, n_draws=n_draws)
        mc_rows = [{
            "fips": r.fips, "name": r["name"], "usps": r.usps, "baseline_rank": int(r["rank"]),
            "median_rank": float(np.median(mc[:, i])), "p05_rank": float(np.percentile(mc[:, i], 5)),
            "p95_rank": float(np.percentile(mc[:, i], 95)), "share_top_n": round(float((mc[:, i] <= top_n).mean()), 3),
        } for i, (_, r) in enumerate(top.iterrows())]
        base_top = set(top.fips)
        oat = []
        for o in S.one_at_a_time(comp, w):
            new_top = set(df.fips[o["ranks"] <= top_n])
            oat.append({"component": o["component"], "factor": o["factor"],
                        "weights": {k: round(float(v), 4) for k, v in zip(S.COMPONENTS, o["weights"])},
                        "top_n_overlap": len(base_top & new_top),
                        "new_rank_of_baseline_top1": int(o["ranks"][0]),
                        "new_top1": df.fips[int(np.argmin(o["ranks"]))]})
        thr = []
        for t in sorted({25.0, 50.0, 75.0, 100.0, float(threshold)}):
            d2, _, _ = self.rank_candidates(category, t, weights, scope, min_gain_pop)
            r2 = dict(zip(d2.fips, d2["rank"]))
            thr.append({"threshold_mi": t, "n_candidates": int(len(d2)),
                        "top_n_overlap": len(base_top & set(d2.head(top_n).fips)),
                        "top_n": [{"fips": r.fips, "name": r["name"], "usps": r.usps, "score": float(r.score)}
                                  for _, r in d2.head(top_n).iterrows()],
                        "baseline_top_ranks": {f: (int(r2[f]) if f in r2 else None) for f in top.fips}})
        return {"top_n": top_n, "n_draws": n_draws, "seed": 20260101, "dirichlet_concentration": 20.0,
                "weights": {k: round(float(v), 4) for k, v in zip(S.COMPONENTS, w)},
                "weight_monte_carlo": mc_rows, "one_at_a_time": oat, "threshold": thr}


_model: AccessModel | None = None
_model_lock = threading.Lock()


def get_model() -> AccessModel:
    """Process-wide singleton, rebuilt automatically after a new pipeline run."""
    global _model
    with _model_lock:
        with get_read_engine().connect() as conn:
            run_id = conn.execute(text("SELECT max(run_id) FROM pipeline_run")).scalar()
        if _model is None or _model.run_id != run_id:
            _model = AccessModel()
        return _model
