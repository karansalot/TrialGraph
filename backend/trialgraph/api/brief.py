"""Executive Strategy Brief: every sentence is assembled from computed values, never free-written numbers."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends
from fastapi.responses import PlainTextResponse

from ..analysis import scoring as S
from ..analysis.engine import get_model
from ..analysis.freshness import freshness_report
from ..pipeline.classify import CATEGORY_LABEL
from .access import access_compare, overview
from .common import (
    ANALYSIS_SITE_DEFINITION,
    DISTANCE_LABEL,
    category_q,
    records,
    scope_of,
    state_q,
    threshold_q,
)
from .simulator import HYPOTHETICAL

router = APIRouter(prefix="/api", tags=["brief"])

LIMITATIONS = [
    "Distances are straight-line (great-circle) miles, not driving distance or travel time; real travel burden is larger and varies with roads, terrain and transit.",
    "Site coordinates are ZIP-area or city centroids derived from registry text, not street addresses; individual site positions can be off by several miles.",
    "Proximity is not access. A nearby recruiting site does not mean a resident is eligible, that the study has open slots, or that they would be referred.",
    "The registry does not report site capacity. Study enrollment figures are study-wide targets and are never used as local capacity.",
    "ClinicalTrials.gov statuses are sponsor-maintained and can lag reality; 'Unknown status' studies and sites without a site-level status are not counted as recruiting.",
    "Cancer categories are assigned by transparent keyword rules over conditions and MeSH terms; some studies are multi-category or mis-categorised.",
    "Facility de-duplication is conservative (exact normalised name + city + state + ZIP); one institution can appear under several names, so facility counts are upper bounds. Distance results are unaffected.",
    "Population is the 2020 Census at tract centres of population; socioeconomic indicators are county-level ACS 5-year estimates with sampling error; CDC PLACES values are model-based estimates and are absent for some counties.",
    "County-level comparisons are ecological: they describe places, not individuals, and do not establish causation.",
    "Cancer prevalence is context only and is not treated as confirmed trial demand.",
    "Opportunity scores rank geographic need under adjustable assumptions. They say nothing about feasibility (investigators, staff, infrastructure, sponsor interest) and are not institutional recommendations.",
]

METHODOLOGY = [
    ("Trial sites", ANALYSIS_SITE_DEFINITION),
    ("Population surface", "Each 2020 census tract is represented by its Census-published centre of population and 2020 population."),
    ("Distance", "Great-circle distance on a sphere of radius 6371.0088 km from each tract centre to the nearest analysis site; cross-checked against PostGIS geodesic distance."),
    ("Coverage", "Share of residents whose tract centre lies within the chosen threshold; county and state figures are population-weighted aggregates of tracts."),
    ("Access gap", "A county where fewer than the chosen share of residents (default 50%) are within the threshold."),
    ("Opportunity score", "100 x weighted average of five 0-1 components (coverage gain, distance relief, socioeconomic barrier index, rurality, cancer-prevalence context) for a hypothetical site at a county's population centre."),
    ("Sensitivity", "Rankings are re-computed under 500 seeded random weight sets, one-at-a-time weight changes, and alternative distance thresholds."),
]


def build_brief(category: str, state: Optional[str], threshold_mi: float) -> dict:
    m = get_model()
    scope = scope_of(state)
    ov = overview(category, state, threshold_mi)
    cmp_ = access_compare(category, state, threshold_mi, 50)
    df, comp, w = m.rank_candidates(category, threshold_mi, None, scope)
    sens = m.sensitivity(category, threshold_mi, None, scope) if len(df) else None
    cov, sites = ov["coverage"], ov["recruiting_sites"]
    rec = next((s for s in ov["status_counts"] if s["status_group"] == "recruiting"), {"studies": 0, "interventional": 0})
    total_studies = sum(s["studies"] for s in ov["status_counts"])
    metro, nonmetro = cmp_["metro_vs_nonmetro"]
    where = state or "the 50 states and DC"
    label = CATEGORY_LABEL[category].lower() if category != "all" else "oncology"
    ind = {r["indicator_id"]: r for r in cmp_["indicators"]}
    findings = [
        {"title": "Only a minority of registered studies are recruiting now",
         "text": f"Of {total_studies:,} {label} studies with sites in {where} in the snapshot, {rec['studies']:,} are listed as Recruiting "
                 f"({rec['interventional']:,} interventional). {sites['recruiting_studies_with_recruiting_site']:,} interventional studies have at "
                 f"least one site that is itself recruiting, across {sites['recruiting_facilities']:,} facility records in "
                 f"{sites['counties_with_recruiting_site']:,} counties.",
         "trace": "ClinicalTrials.gov API v2: overallStatus and per-location status"},
        {"title": f"{cov['pct_within']:.1f}% of residents live within {threshold_mi:g} straight-line miles of a recruiting site",
         "text": f"{cov['population_beyond']:,} of {cov['population']:,} residents (2020 Census) live farther than {threshold_mi:g} miles. "
                 f"The population-weighted median distance is {cov['pop_weighted_median_mi']} miles and the 90th percentile is {cov['pop_weighted_p90_mi']} miles.",
         "trace": "Calculation: tract centres of population (2020 Census) to nearest analysis site"},
    ]
    if metro["population"] and nonmetro["population"]:
        findings.append({
            "title": "Non-metro residents are farther from recruiting sites",
            "text": f"{nonmetro['pct_within']:.1f}% of non-metro residents are within {threshold_mi:g} miles, versus {metro['pct_within']:.1f}% of metro residents; "
                    f"population-weighted mean distance is {nonmetro['pop_weighted_mean_mi']} vs {metro['pop_weighted_mean_mi']} miles.",
            "trace": "Calculation grouped by USDA ERS Rural-Urban Continuum Codes 2023"})
    if cmp_["n_gap_counties"]:
        pv, ui = ind["acs_pct_poverty"], ind["acs_pct_uninsured"]
        findings.append({
            "title": f"{cmp_['n_gap_counties']:,} counties are access gaps at this threshold",
            "text": f"They hold {cmp_['gap_population']:,} residents. Population-weighted poverty is {pv['gap_counties']}% in gap counties vs "
                    f"{pv['other_counties']}% elsewhere; the uninsured rate is {ui['gap_counties']}% vs {ui['other_counties']}% (ACS {pv['vintage']}). "
                    "These are county-level associations, not causal findings.",
            "trace": "Calculation joined to ACS 5-year county estimates"})
    if len(df):
        t = df.iloc[0]
        stab = sens["weight_monte_carlo"][0]
        findings.append({
            "title": "Largest modelled coverage opportunity (hypothetical)",
            "text": f"A hypothetical site at the population centre of {t['name']}, {t.usps} would bring {int(t.pop_newly_within):,} more residents within "
                    f"{threshold_mi:g} miles (score {t.score}). It stays in the top {sens['top_n']} in {stab['share_top_n'] * 100:.0f}% of "
                    f"{sens['n_draws']} alternative weightings.",
            "trace": "Site Strategy Simulator, default weights; sensitivity analysis"})
    fr = freshness_report()
    return {
        "title": f"Geographic access to recruiting {label} trials - {state or 'United States'}",
        "generated_at": datetime.now(timezone.utc), "filters": {"category": category, "state": state, "threshold_mi": threshold_mi},
        "key_findings": findings,
        "headline": {"coverage": cov, "recruiting_sites": sites, "status_counts": ov["status_counts"],
                     "metro": metro, "nonmetro": nonmetro, "n_gap_counties": cmp_["n_gap_counties"], "gap_population": cmp_["gap_population"]},
        "ranked_opportunities": records(df.head(10)),
        "weights": {k: round(float(v), 4) for k, v in zip(S.COMPONENTS, w)}, "component_labels": S.COMPONENT_LABELS,
        "sensitivity": sens, "indicator_comparison": cmp_["indicators"],
        "methodology": [{"topic": a, "text": b} for a, b in METHODOLOGY], "limitations": LIMITATIONS,
        "sources": fr["sources"], "freshness": fr["overall_status"], "disclaimer": HYPOTHETICAL, "distance_label": DISTANCE_LABEL,
    }


@router.get("/brief")
def brief(category: str = Depends(category_q), state: Optional[str] = Depends(state_q), threshold_mi: float = Depends(threshold_q)):
    return build_brief(category, state, threshold_mi)


@router.get("/brief.md", response_class=PlainTextResponse)
def brief_markdown(category: str = Depends(category_q), state: Optional[str] = Depends(state_q),
                   threshold_mi: float = Depends(threshold_q)):
    b = build_brief(category, state, threshold_mi)
    L = [f"# {b['title']}", "", f"_TrialGraph executive strategy brief - generated {b['generated_at']:%Y-%m-%d %H:%M} UTC. "
         f"Threshold: {threshold_mi:g} straight-line miles._", "", f"> {b['disclaimer']}", "", "## Key findings", ""]
    for i, f in enumerate(b["key_findings"], 1):
        L += [f"{i}. **{f['title']}.** {f['text']}  ", f"   _Source: {f['trace']}_"]
    L += ["", "## Ranked hypothetical site opportunities", "",
          "| Rank | Candidate county | Residents newly within threshold | Miles saved / person | Non-metro share | Score |", "|---|---|---|---|---|---|"]
    for r in b["ranked_opportunities"]:
        L.append(f"| {r['rank']} | {r['name']}, {r['usps']} | {r['pop_newly_within']:,} | {r['miles_saved_per_person']} | "
                 f"{(r['rural_share'] or 0) * 100:.0f}% | {r['score']} |")
    if not b["ranked_opportunities"]:
        L.append("| - | No candidate meets the minimum coverage-gain filter in this scope | | | | |")
    L += ["", "Weights: " + ", ".join(f"{S.COMPONENT_LABELS[k]} {v:.0%}" for k, v in b["weights"].items()), ""]
    if b["sensitivity"]:
        L += ["### Rank stability", "", "| Candidate | Baseline rank | Median rank | 5th-95th pct rank | Share of weightings in top N |", "|---|---|---|---|---|"]
        for r in b["sensitivity"]["weight_monte_carlo"]:
            L.append(f"| {r['name']}, {r['usps']} | {r['baseline_rank']} | {r['median_rank']:g} | {r['p05_rank']:g}-{r['p95_rank']:g} | {r['share_top_n']:.0%} |")
        L.append("")
    L += ["## Methodology", ""] + [f"- **{m['topic']}.** {m['text']}" for m in b["methodology"]]
    L += ["", "## Limitations", ""] + [f"- {x}" for x in b["limitations"]]
    L += ["", "## Sources", "", "| Source | Publisher | Vintage | Retrieved (UTC) |", "|---|---|---|---|"]
    for s in b["sources"]:
        L.append(f"| [{s['source_name']}]({s['url']}) | {s['publisher']} | {s['vintage'] or ''} | {s['retrieved_at']:%Y-%m-%d %H:%M} |")
    return "\n".join(L) + "\n"
