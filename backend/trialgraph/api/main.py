from __future__ import annotations

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from ..analysis import scoring as S
from ..analysis.access import CATEGORIES
from ..analysis.freshness import freshness_report
from ..config import get_settings
from ..db import fetch_all, fetch_one
from ..pipeline.classify import CATEGORY_LABEL, CATEGORY_RULES, LENS_RULES, STATUS_LABEL
from ..pipeline.reference import USPS_TO_NAME
from . import access, brief, simulator, trials
from .common import ANALYSIS_SITE_DEFINITION, DISTANCE_LABEL

app = FastAPI(
    title="TrialGraph API",
    version="0.1.0",
    description="Population-level geographic access to recruiting oncology clinical trials. "
                "Not for individual eligibility or care decisions.",
)
app.add_middleware(GZipMiddleware, minimum_size=1024)
app.add_middleware(CORSMiddleware, allow_origins=get_settings().cors_origins.split(","), allow_methods=["*"], allow_headers=["*"])
for r in (trials.router, access.router, simulator.router, brief.router):
    app.include_router(r)


@app.get("/api/health", tags=["meta"])
def health():
    return {"status": "ok", "studies": fetch_one("SELECT count(*) AS n FROM study")["n"]}


@app.get("/api/meta", tags=["meta"])
def meta():
    s = get_settings()
    run = fetch_one("SELECT run_id, finished_at, scope FROM pipeline_run ORDER BY run_id DESC LIMIT 1")
    states = [r["usps"] for r in fetch_all("SELECT DISTINCT usps FROM county ORDER BY 1")]
    return {
        "categories": [{"id": c, "label": CATEGORY_LABEL[c], "group": "lens" if c in LENS_RULES else "cancer",
                        "rule": CATEGORY_RULES[c][1] if c in CATEGORY_RULES else LENS_RULES[c][1] if c in LENS_RULES else None}
                       for c in CATEGORIES],
        "statuses": [{"id": k, "label": v} for k, v in STATUS_LABEL.items()],
        "states": [{"usps": u, "name": USPS_TO_NAME[u]} for u in states],
        "scope": run["scope"] if run else None, "pipeline_run": run,
        "defaults": {"threshold_mi": 50, "min_share": 50, "weights": S.DEFAULT_WEIGHTS, "min_gain_pop": 5000},
        "score_components": [{"id": k, "label": S.COMPONENT_LABELS[k]} for k in S.COMPONENTS],
        "analysis_site_definition": ANALYSIS_SITE_DEFINITION, "distance_label": DISTANCE_LABEL,
        "routing_configured": bool(s.osrm_url),
    }


_insights_cache: dict = {}


@app.get("/api/insights", tags=["insights"])
def insights(threshold_mi: float = Query(50, ge=5, le=250)):
    """Auto-generated, data-driven findings with evidence and deep links."""
    from ..analysis import insights as I
    from ..analysis.engine import get_model
    m = get_model()
    key = (m.run_id, float(threshold_mi))
    if key not in _insights_cache:
        _insights_cache.clear()
        _insights_cache[key] = I.build(m, float(threshold_mi))
    return _insights_cache[key]


@app.get("/api/meta/freshness", tags=["meta"])
def freshness(live: bool = Query(False, description="Also ask ClinicalTrials.gov whether newer data exists")):
    return freshness_report(live=live)


@app.get("/api/meta/indicators", tags=["meta"])
def indicators():
    """The machine-readable data dictionary for every county indicator."""
    return fetch_all("""SELECT i.*, sd.source_name, sd.publisher, sd.url AS source_url, sd.retrieved_at
                        FROM indicator i JOIN source_dataset sd USING (source_key) ORDER BY i.source_key, i.indicator_id""")


@app.get("/api/meta/quality", tags=["meta"])
def quality():
    """Data-quality counters surfaced in the UI (geocoding confidence, de-duplication, exclusions)."""
    return {
        "geocoding": fetch_all("SELECT geocode_method, geocode_confidence, count(*) AS facilities FROM facility GROUP BY 1, 2 ORDER BY 3 DESC"),
        "facilities": fetch_one("""SELECT count(*) AS total, count(*) FILTER (WHERE is_placeholder_name) AS anonymised_name,
                                          sum(n_source_records) AS source_site_records, count(*) FILTER (WHERE state_mismatch) AS state_mismatch,
                                          count(*) FILTER (WHERE n_name_variants > 1) AS merged_spelling_variants FROM facility"""),
        "oncology_basis": fetch_all("SELECT oncology_basis, count(*) AS studies FROM study GROUP BY 1 ORDER BY 2 DESC"),
        "site_status_of_recruiting_studies": fetch_all("""
            SELECT coalesce(ss.site_status, '(not reported)') AS site_status, count(*) AS site_links
            FROM study_site ss JOIN study s USING (nct_id) WHERE s.status_group = 'recruiting' GROUP BY 1 ORDER BY 2 DESC"""),
        "tract_county_assignment": fetch_all("SELECT county_assign_method, count(*) AS tracts FROM tract_center GROUP BY 1"),
        "indicator_coverage": fetch_all("SELECT indicator_id, label, n_counties_with_value, (SELECT count(*) FROM county) AS n_counties FROM indicator ORDER BY 1"),
    }
