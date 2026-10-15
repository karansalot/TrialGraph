"""Trial Explorer endpoints - every record is a real ClinicalTrials.gov study, linked to its source page."""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from ..db import fetch_all, fetch_one
from ..pipeline.classify import STATUS_GROUP
from .common import category_q, state_q

router = APIRouter(prefix="/api", tags=["trials"])
STATUS_GROUPS = list(dict.fromkeys(STATUS_GROUP.values()))
SORTS = {"updated": "s.last_update_posted DESC NULLS LAST, s.nct_id", "sites": "n_us_sites DESC, s.nct_id",
         "recruiting_sites": "n_recruiting_sites DESC, s.nct_id", "nct": "s.nct_id"}


@router.get("/trials")
def list_trials(
    q: Optional[str] = Query(None, description="Full-text search over title, conditions, sponsor; or an NCT id"),
    status: Optional[str] = Query(None, description="Comma-separated status groups"),
    category: str = Depends(category_q),
    state: Optional[str] = Depends(state_q),
    phase: Optional[str] = Query(None, description="e.g. PHASE2"),
    study_type: Optional[str] = Query(None, pattern="^(INTERVENTIONAL|OBSERVATIONAL)$"),
    include_non_oncology: bool = Query(False, description="Include records the classifier could not confirm as oncology"),
    sort: str = Query("updated"),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100),
):
    where, p = ["TRUE"], {}
    if not include_non_oncology:
        where.append("s.oncology_basis <> 'not_oncology'")
    q = (q or "").replace("\x00", "")[:200]
    if q.strip():
        p["q"] = q.strip()
        where.append("(to_tsvector('english', s.search_text) @@ websearch_to_tsquery('english', :q) OR s.nct_id = upper(:q))")
    if status:
        groups = [g for g in status.split(",") if g in STATUS_GROUPS]
        if not groups:
            raise HTTPException(422, f"status must be one of {STATUS_GROUPS}")
        p["groups"] = groups
        where.append("s.status_group = ANY(:groups)")
    if category != "all":
        p["cat"] = category
        where.append(":cat = ANY(s.filter_keys)")
    if phase:
        p["phase"] = phase.upper()
        where.append(":phase = ANY(s.phases)")
    if study_type:
        p["stype"] = study_type
        where.append("s.study_type = :stype")
    if state:
        p["state"] = state
        where.append("EXISTS (SELECT 1 FROM study_site x JOIN facility xf USING (facility_id) WHERE x.nct_id = s.nct_id AND xf.usps = :state)")
    w = " AND ".join(where)
    total = fetch_one(f"SELECT count(*) AS n FROM study s WHERE {w}", **p)["n"]
    state_cond = "AND f.usps = :state" if state else ""
    rows = fetch_all(f"""
        SELECT s.nct_id, s.brief_title, s.overall_status, s.status_group, s.study_type, s.phases, s.lead_sponsor,
               s.sponsor_class, s.conditions, s.cancer_categories, s.lenses, s.last_update_posted, s.enrollment_count,
               s.enrollment_type, s.source_url, s.oncology_basis, k.n_us_sites, k.n_recruiting_sites, k.states
        FROM study s
        LEFT JOIN LATERAL (
            SELECT count(*) AS n_us_sites, count(*) FILTER (WHERE ss.is_recruiting_site) AS n_recruiting_sites,
                   array_agg(DISTINCT f.usps ORDER BY f.usps) AS states
            FROM study_site ss JOIN facility f USING (facility_id) WHERE ss.nct_id = s.nct_id {state_cond}) k ON TRUE
        WHERE {w}
        ORDER BY {SORTS.get(sort, SORTS['updated'])}
        LIMIT :lim OFFSET :off""", lim=page_size, off=(page - 1) * page_size, **p)
    return {"total": total, "page": page, "page_size": page_size, "site_counts_scope": state or "US", "trials": rows}


@router.get("/trials/{nct_id}")
def get_trial(nct_id: str):
    s = fetch_one("SELECT * FROM study WHERE nct_id = :n", n=nct_id.upper())
    if not s:
        raise HTTPException(404, "study not in the TrialGraph snapshot")
    s.pop("search_text", None)
    sites = fetch_all("""
        SELECT f.facility_id, ss.facility_raw AS name_on_record, f.name AS facility_name, f.is_placeholder_name, f.city, f.usps,
               f.zip5, ss.site_status, ss.is_recruiting_site, f.geocode_method, f.geocode_confidence,
               ST_Y(f.geom::geometry) AS lat, ST_X(f.geom::geometry) AS lon, c.name AS county_name, f.county_fips
        FROM study_site ss JOIN facility f USING (facility_id) LEFT JOIN county c ON c.fips = f.county_fips
        WHERE ss.nct_id = :n ORDER BY ss.is_recruiting_site DESC, f.usps, f.city, f.name""", n=nct_id.upper())
    return {"study": s, "sites": sites,
            "site_summary": {"us_sites": len(sites), "recruiting_sites": sum(x["is_recruiting_site"] for x in sites)},
            "notes": ["Sites outside the 50 states and DC are not included.",
                      "Enrollment counts are sponsor-reported targets or actuals for the whole study, not site capacity.",
                      "Eligibility is summarised from registry metadata only; this tool does not assess individual eligibility."]}


@router.get("/facilities/{facility_id}")
def get_facility(facility_id: int):
    f = fetch_one("""SELECT f.facility_id, f.name, f.is_placeholder_name, f.city, f.usps, f.zip5, f.geocode_method,
                            f.geocode_confidence, f.zip_city_gap_mi, f.county_fips, c.name AS county_name,
                            f.n_source_records, f.n_name_variants, ST_Y(f.geom::geometry) AS lat, ST_X(f.geom::geometry) AS lon
                     FROM facility f LEFT JOIN county c ON c.fips = f.county_fips WHERE facility_id = :i""", i=facility_id)
    if not f:
        raise HTTPException(404, "facility not found")
    studies = fetch_all("""
        SELECT s.nct_id, s.brief_title, s.status_group, s.overall_status, ss.site_status, ss.is_recruiting_site, s.phases,
               s.study_type, s.cancer_categories, s.source_url
        FROM study_site ss JOIN study s USING (nct_id)
        WHERE ss.facility_id = :i AND s.oncology_basis <> 'not_oncology'
        ORDER BY ss.is_recruiting_site DESC, s.last_update_posted DESC NULLS LAST LIMIT 200""", i=facility_id)
    return {"facility": f, "studies": studies}
