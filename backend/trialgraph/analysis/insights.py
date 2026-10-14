"""Auto-generated insights.

Each insight is computed from the loaded data at request time - no number is hard-coded - and
carries the evidence behind it plus a deep link into the page where it can be explored.
"""
from __future__ import annotations

import numpy as np

from ..db import fetch_all, fetch_one
from ..pipeline.classify import CATEGORY_LABEL, CATEGORY_RULES
from ..pipeline.reference import USPS_TO_NAME
from .engine import AccessModel, Scope, pct_rank

ANALYSIS_SITE = ("ss.is_recruiting_site AND s.study_type = 'INTERVENTIONAL' AND s.oncology_basis <> 'not_oncology' "
                 "AND f.geom IS NOT NULL")


def _f(v: float, d: int = 1) -> str:
    return f"{v:,.{d}f}"


def _people(n: float) -> str:
    return f"{n / 1e6:,.1f} million" if n >= 1e6 else f"{n:,.0f}"


def build(m: AccessModel, threshold: float) -> dict:
    T = threshold
    us = Scope()
    mask = m.tract_mask(us)
    cov = {c: m.summarize(m.baseline(c), T, mask) for c in ("all", "lens_phase1", "lens_phase3", "lens_age75",
                                                              "lens_pediatric", "lens_verified", *CATEGORY_RULES)}
    base = cov["all"]
    out: list[dict] = []
    q = f"threshold={int(T)}" if T != 50 else ""

    def link(path: str, **kw) -> str:
        parts = [f"{k}={v}" for k, v in kw.items()] + ([q] if q else [])
        return path + ("?" + "&".join(parts) if parts else "")

    # 1. early-phase deserts --------------------------------------------------------------------
    p1 = cov["lens_phase1"]
    extra = p1["population_beyond"] - base["population_beyond"]
    out.append({
        "id": "early_phase", "theme": "Trial type", "title": "Early-phase trials are a much longer trip",
        "headline": _people(p1["population_beyond"]), "headline_label": f"residents beyond {T:g} mi of a recruiting Phase 1 site",
        "text": f"Phase 1 studies are where new drugs first reach patients. Only {_f(p1['pct_within'])}% of residents live within {T:g} miles of a "
                f"site recruiting for one, against {_f(base['pct_within'])}% for any oncology trial: {_people(extra)} more people are out of range. "
                f"The median resident is {_f(p1['pop_weighted_median_mi'])} miles from an early-phase site versus {_f(base['pop_weighted_median_mi'])} miles from any site.",
        "evidence": {"pct_within_phase1": p1["pct_within"], "pct_within_any": base["pct_within"], "additional_beyond": extra,
                     "median_mi_phase1": p1["pop_weighted_median_mi"], "median_mi_any": base["pop_weighted_median_mi"]},
        "chart": [{"label": "Any oncology trial", "value": base["pct_within"]}, {"label": "Phase 3", "value": cov["lens_phase3"]["pct_within"]},
                  {"label": "Phase 1 / early phase", "value": p1["pct_within"]}],
        "chart_label": f"% of residents within {T:g} mi", "link": link("/access", category="lens_phase1"),
    })

    # 2. registry reliability -------------------------------------------------------------------
    release = (fetch_one("SELECT source_updated_at FROM source_dataset WHERE source_key = 'ctgov_studies'") or {}).get("source_updated_at")
    cutoff24 = f"{release.year - 2}-{release.month:02d}" if release else "0000-00"
    r = fetch_one("""SELECT count(*) AS n, count(*) FILTER (WHERE 'lens_verified' = ANY(lenses)) AS verified,
                            count(*) FILTER (WHERE status_verified_date < :c24) AS very_old
                     FROM study WHERE status_group = 'recruiting' AND oncology_basis <> 'not_oncology'""", c24=cutoff24)
    unver = r["n"] - r["verified"]
    v = cov["lens_verified"]
    lost = v["population_beyond"] - base["population_beyond"]
    out.append({
        "id": "registry_reliability", "theme": "Data quality", "title": "Some 'recruiting' records have not been checked in over a year",
        "headline": f"{100 * unver / r['n']:.1f}%", "headline_label": "of recruiting oncology studies not status-verified in the last 12 months",
        "text": f"{unver:,} of {r['n']:,} studies listed as Recruiting were last verified by their sponsor more than 12 months before this registry "
                f"release ({r['very_old']:,} more than two years before). Counting only recently verified studies moves {_people(lost)} residents "
                f"outside {T:g} miles. TrialGraph keeps both views so planners can see how much a stale record could flatter a region.",
        "evidence": {"recruiting_studies": r["n"], "not_verified_12m": unver, "not_verified_24m": r["very_old"],
                     "pct_within_verified_only": v["pct_within"], "population_losing_coverage": lost},
        "link": link("/access", category="lens_verified"),
    })

    # 3. older adults ------------------------------------------------------------------------------
    a = fetch_one(f"""SELECT count(DISTINCT s.nct_id) AS n,
                             count(DISTINCT s.nct_id) FILTER (WHERE NOT 'lens_age75' = ANY(s.lenses)) AS capped
                      FROM study_site ss JOIN study s USING (nct_id) JOIN facility f USING (facility_id) WHERE {ANALYSIS_SITE}""")
    old = cov["lens_age75"]
    out.append({
        "id": "older_adults", "theme": "Eligibility", "title": "Upper age limits quietly shrink access for older adults",
        "headline": f"{100 * a['capped'] / a['n']:.1f}%", "headline_label": "of recruiting interventional studies exclude people aged 75+",
        "text": f"{a['capped']:,} of {a['n']:,} recruiting interventional oncology studies set a maximum age below 75, even though cancer incidence peaks in "
                f"older adults. Restricted to studies open to people 75 and over, {_f(old['pct_within'])}% of residents are within {T:g} miles "
                f"({_people(old['population_beyond'] - base['population_beyond'])} fewer than for all studies). This uses registry age limits only - "
                "real eligibility criteria are stricter.",
        "evidence": {"studies": a["n"], "studies_with_max_age_below_75": a["capped"], "pct_within_age75": old["pct_within"]},
        "link": link("/trials", category="lens_age75"),
    })

    # 4. double burden ----------------------------------------------------------------------------
    c = m.counties
    ct = m.county_table("all", T)
    pov = pct_rank(c.acs_pct_poverty.to_numpy(float))
    unins = pct_rank(c.acs_pct_uninsured.to_numpy(float))
    burden = ((pov >= 0.75) | (unins >= 0.75)) & (ct.pct_within.to_numpy() < 50)
    db = c[burden].assign(pct_within=ct.pct_within[burden], mean_mi=ct.mean_mi[burden]).sort_values("pop_2020", ascending=False)
    out.append({
        "id": "double_burden", "theme": "Equity", "title": "Where distance and economic barriers stack up",
        "headline": f"{len(db):,}", "headline_label": "counties are both an access gap and in the top quartile for poverty or uninsurance",
        "text": f"These {len(db):,} counties are home to {_people(db.pop_2020.sum())} people. Most of their residents live more than {T:g} miles from "
                f"a recruiting site, and they rank in the highest-need quarter of U.S. counties for poverty or lack of insurance (ACS). "
                f"The largest are {', '.join(f'{r.name}, {r.usps}' for r in db.head(3).itertuples())}.",
        "evidence": {"counties": int(len(db)), "population": int(db.pop_2020.sum())},
        "table": [{"fips": r.fips, "name": f"{r.name}, {r.usps}", "population": int(r.pop_2020), "pct_within": float(r.pct_within),
                   "mean_mi": float(r.mean_mi), "poverty": float(r.acs_pct_poverty), "uninsured": float(r.acs_pct_uninsured)}
                  for r in db.head(8).itertuples()],
        "link": link("/access"),
    })

    # 5. rural gap by state -------------------------------------------------------------------------
    rows = []
    d = m.baseline("all")
    for usps in sorted(set(m.c_usps)):
        sm = m.tract_usps == usps
        nm = sm & ~m.tract_metro
        if m.pop[nm].sum() < 1:
            continue
        s_non = m.summarize(d, T, nm)
        s_met = m.summarize(d, T, sm & m.tract_metro) if (sm & m.tract_metro).any() else None
        rows.append({"usps": usps, "state": USPS_TO_NAME[usps], "nonmetro_population": s_non["population"],
                     "nonmetro_beyond": s_non["population_beyond"], "nonmetro_pct_within": s_non["pct_within"],
                     "metro_pct_within": s_met["pct_within"] if s_met else None})
    rows.sort(key=lambda r: -r["nonmetro_beyond"])
    top = rows[0]
    out.append({
        "id": "rural_states", "theme": "Rurality", "title": f"{top['state']} has the most rural residents out of range",
        "headline": _people(top["nonmetro_beyond"]), "headline_label": f"non-metro {top['state']} residents beyond {T:g} mi",
        "text": "Ranked by the number of non-metro residents farther than the threshold from a recruiting site: "
                + "; ".join(f"{r['state']} {_people(r['nonmetro_beyond'])} ({_f(r['nonmetro_pct_within'], 0)}% within)" for r in rows[:5]) + ".",
        "evidence": {"states": rows[:10]},
        "chart": [{"label": r["usps"], "value": r["nonmetro_beyond"]} for r in rows[:10]], "chart_label": f"Non-metro residents beyond {T:g} mi",
        "link": link("/access", state=top["usps"]),
    })

    # 6. concentration -----------------------------------------------------------------------------
    links = fetch_all(f"""SELECT f.facility_id, count(*) AS n FROM study_site ss JOIN study s USING (nct_id) JOIN facility f USING (facility_id)
                          WHERE {ANALYSIS_SITE} GROUP BY 1 ORDER BY 2 DESC""")
    n = np.array([x["n"] for x in links])
    k = max(1, int(round(len(n) * 0.05)))
    in_cty = fetch_one(f"""SELECT count(DISTINCT f.county_fips) AS c FROM study_site ss JOIN study s USING (nct_id)
                           JOIN facility f USING (facility_id) WHERE {ANALYSIS_SITE}""")["c"]
    has_site = set(r["fips"] for r in fetch_all("SELECT fips FROM county_supply WHERE category = 'all' AND recruiting_sites_in_county > 0"))
    pop_in = float(c.pop_2020[c.fips.isin(has_site)].sum())
    out.append({
        "id": "concentration", "theme": "Supply", "title": "Trial activity is concentrated in a few hubs",
        "headline": f"{100 * n[:k].sum() / n.sum():.0f}%", "headline_label": "of recruiting study-site slots are at the busiest 5% of sites",
        "text": f"{len(n):,} facility records host a recruiting interventional oncology study, but the busiest {k:,} account for "
                f"{100 * n[:k].sum() / n.sum():.0f}% of all recruiting study-site listings. Only {in_cty:,} of {len(c):,} counties contain any recruiting site; "
                f"they hold {100 * pop_in / c.pop_2020.sum():.0f}% of the population.",
        "evidence": {"facilities": int(len(n)), "top_5pct_facilities": k, "share_of_links": float(n[:k].sum() / n.sum()),
                     "counties_with_site": in_cty, "population_share_in_those_counties": pop_in / float(c.pop_2020.sum())},
        "link": link("/"),
    })

    # 7. worst-served cancer type ---------------------------------------------------------------------
    worst = max(CATEGORY_RULES, key=lambda k: cov[k]["population_beyond"])
    best = min(CATEGORY_RULES, key=lambda k: cov[k]["population_beyond"])
    out.append({
        "id": "cancer_type", "theme": "Cancer type", "title": f"{CATEGORY_LABEL[worst]} trials are the hardest to reach",
        "headline": _people(cov[worst]["population_beyond"]), "headline_label": f"residents beyond {T:g} mi of a recruiting {CATEGORY_LABEL[worst].lower()} site",
        "text": f"Coverage varies sharply by cancer type: {_f(cov[best]['pct_within'])}% of residents are within {T:g} miles of a recruiting "
                f"{CATEGORY_LABEL[best].lower()} site, but only {_f(cov[worst]['pct_within'])}% for {CATEGORY_LABEL[worst].lower()}. "
                "Planning on the all-oncology map hides these gaps.",
        "chart": sorted([{"label": CATEGORY_LABEL[k], "value": cov[k]["pct_within"]} for k in CATEGORY_RULES], key=lambda x: x["value"]),
        "chart_label": f"% of residents within {T:g} mi", "link": link("/access", category=worst),
        "evidence": {k: cov[k]["pct_within"] for k in CATEGORY_RULES},
    })

    # 8. diminishing returns -------------------------------------------------------------------------
    plan = m.greedy_plan("all", T, {"coverage": 1.0}, us, k=10, min_gain_pop=1000)
    steps = plan["steps"]
    gap = base["population_beyond"]
    curve = [{"label": "0", "value": 0.0}] + [{"label": str(s["step"]), "value": round(100 * s["cumulative_pop_newly_within"] / gap, 2)} for s in steps]
    if steps:
        third = steps[min(2, len(steps) - 1)]
        out.append({
            "id": "diminishing_returns", "theme": "Strategy", "title": "New sites alone cannot close the gap",
            "headline": f"{curve[-1]['value']:.0f}%", "headline_label": f"of the {T:g}-mile gap closed by {len(steps)} well-placed hypothetical sites",
            "text": f"Placing hypothetical sites one at a time purely for coverage, the first three ({', '.join(s['name'] + ', ' + s['usps'] for s in steps[:3])}) "
                    f"would bring {_people(third['cumulative_pop_newly_within'])} of the {_people(gap)} out-of-range residents within {T:g} miles "
                    f"({curve[min(3, len(curve) - 1)]['value']:.0f}%); {len(steps)} sites reach {curve[-1]['value']:.0f}%. Even the best-placed site adds only "
                    f"{100 * steps[0]['marginal_pop_newly_within'] / gap:.0f}% because the remaining gap is spread across many small, remote communities. "
                    "That pattern suggests decentralised or "
                    "remote-participation models may matter more than additional brick-and-mortar sites for the last stretch.",
            "chart": curve, "chart_label": "% of out-of-range residents covered, by number of hypothetical sites",
            "evidence": {"gap_population": gap, "steps": steps}, "link": link("/simulator"),
            "hypothetical": True,
        })

    order = ["early_phase", "registry_reliability", "double_burden", "older_adults", "rural_states", "concentration",
             "cancer_type", "diminishing_returns"]
    out.sort(key=lambda i: order.index(i["id"]))
    return {"threshold_mi": T, "generated_from_run": m.run_id, "insights": out,
            "note": "Every insight is computed from the current data snapshot at request time. Distances are straight-line. "
                    "County comparisons are ecological. Hypothetical sites are not real or planned facilities."}
