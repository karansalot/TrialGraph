"""National overview + access-gap endpoints."""
from __future__ import annotations

from functools import lru_cache
from typing import Optional

import httpx
import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.responses import PlainTextResponse

from ..analysis.engine import get_model
from ..config import get_settings
from ..db import fetch_all, fetch_one
from ..pipeline.classify import CATEGORY_LABEL, STATUS_LABEL
from .common import ANALYSIS_SITE_WHERE, DISTANCE_LABEL, category_q, records, scope_of, state_q, threshold_q

router = APIRouter(prefix="/api", tags=["access"])
PROFILE_COLS = ["acs_total_pop", "acs_median_hh_income", "acs_pct_poverty", "acs_pct_uninsured", "acs_pct_no_vehicle_hh",
                "acs_pct_no_internet_hh", "acs_pct_65_plus", "acs_pct_people_of_color", "places_cancer_aa",
                "places_csmoking_aa", "places_lacktrpt_aa"]


@lru_cache(maxsize=4)
def _geojson(layer: str, run_id: int) -> str:
    if layer == "counties":
        sql = """SELECT json_build_object('type','FeatureCollection','features', json_agg(json_build_object(
                   'type','Feature','id', fips::int, 'properties', json_build_object('fips', fips, 'name', name, 'usps', usps),
                   'geometry', ST_AsGeoJSON(coalesce(geom_display, ST_SimplifyPreserveTopology(geom, 0.02)), 3)::json)))::text AS j
                 FROM county"""
    else:
        sql = """SELECT json_build_object('type','FeatureCollection','features', json_agg(json_build_object(
                   'type','Feature','id', state_fips::int, 'properties', json_build_object('usps', usps, 'name', name),
                   'geometry', ST_AsGeoJSON(geom_display, 3)::json)))::text AS j FROM state"""
    return fetch_one(sql)["j"]


@router.get("/geo/{layer}")
def geo(layer: str):
    if layer not in ("counties", "states"):
        raise HTTPException(404)
    return Response(_geojson(layer, get_model().run_id), media_type="application/geo+json",
                    headers={"Cache-Control": "public, max-age=3600"})


@router.get("/facilities")
def facilities(category: str = Depends(category_q), state: Optional[str] = Depends(state_q)):
    """Sites currently recruiting for interventional oncology studies (the 'analysis sites')."""
    cat = "" if category == "all" else "AND :cat = ANY(s.filter_keys)"
    st = "AND f.usps = :state" if state else ""
    p = {k: v for k, v in (("cat", category), ("state", state)) if v and v != "all"}
    rows = fetch_all(f"""
        SELECT f.facility_id AS id, f.name, f.is_placeholder_name AS anon, f.city, f.usps, f.geocode_confidence AS conf,
               round(ST_Y(f.geom::geometry)::numeric, 4)::float AS lat, round(ST_X(f.geom::geometry)::numeric, 4)::float AS lon,
               count(DISTINCT ss.nct_id) AS n
        FROM study_site ss JOIN study s USING (nct_id) JOIN facility f USING (facility_id)
        WHERE {ANALYSIS_SITE_WHERE} {cat} {st}
        GROUP BY f.facility_id ORDER BY n DESC""", **p)
    return {"count": len(rows), "distinct_locations": len({(r["lat"], r["lon"]) for r in rows}), "facilities": rows,
            "note": "Coordinates are ZIP-area or city centroids, not street addresses."}


@router.get("/overview")
def overview(category: str = Depends(category_q), state: Optional[str] = Depends(state_q),
             threshold_mi: float = Depends(threshold_q)):
    m = get_model()
    scope = scope_of(state)
    p = {}
    conds = ["s.oncology_basis <> 'not_oncology'"]
    if category != "all":
        conds.append(":cat = ANY(s.filter_keys)")
        p["cat"] = category
    site_state = ""
    if state:
        p["state"] = state
        site_state = "AND f.usps = :state"
        conds.append("EXISTS (SELECT 1 FROM study_site x JOIN facility xf USING (facility_id) WHERE x.nct_id = s.nct_id AND xf.usps = :state)")
    w = " AND ".join(conds)
    status = fetch_all(f"""SELECT status_group, count(*) AS studies,
                                  count(*) FILTER (WHERE study_type = 'INTERVENTIONAL') AS interventional
                           FROM study s WHERE {w} GROUP BY 1""", **p)
    order = list(STATUS_LABEL)
    status = sorted(({**r, "label": STATUS_LABEL[r["status_group"]]} for r in status), key=lambda r: order.index(r["status_group"]))
    sites = fetch_one(f"""
        SELECT count(DISTINCT ss.nct_id) AS recruiting_studies_with_recruiting_site,
               count(DISTINCT f.facility_id) AS recruiting_facilities,
               count(DISTINCT (ST_Y(f.geom::geometry), ST_X(f.geom::geometry))) AS distinct_site_locations,
               count(DISTINCT f.county_fips) AS counties_with_recruiting_site,
               count(DISTINCT f.facility_id) FILTER (WHERE f.is_placeholder_name) AS anonymised_facilities,
               count(*) AS recruiting_study_site_links
        FROM study_site ss JOIN study s USING (nct_id) JOIN facility f USING (facility_id)
        WHERE {ANALYSIS_SITE_WHERE} AND {w} {site_state}""", **p)
    recruiting_no_site = fetch_one(f"""
        SELECT count(*) AS n FROM study s WHERE {w} AND s.status_group = 'recruiting' AND s.study_type = 'INTERVENTIONAL'
          AND NOT EXISTS (SELECT 1 FROM study_site ss WHERE ss.nct_id = s.nct_id AND ss.is_recruiting_site)""", **p)["n"]
    by_state = fetch_all(f"""
        SELECT f.usps, count(DISTINCT ss.nct_id) AS studies, count(DISTINCT f.facility_id) AS facilities
        FROM study_site ss JOIN study s USING (nct_id) JOIN facility f USING (facility_id)
        WHERE {ANALYSIS_SITE_WHERE} AND {w.replace(':state', ':state')} {site_state} GROUP BY 1 ORDER BY 2 DESC""", **p)
    by_cat = fetch_all(f"""
        SELECT cat AS category, count(DISTINCT ss.nct_id) AS studies, count(DISTINCT f.facility_id) AS facilities
        FROM study_site ss JOIN study s USING (nct_id) JOIN facility f USING (facility_id), unnest(s.cancer_categories) AS cat
        WHERE {ANALYSIS_SITE_WHERE} AND s.oncology_basis <> 'not_oncology' {site_state} GROUP BY 1 ORDER BY 2 DESC""",
        **({"state": state} if state else {}))
    by_phase = fetch_all(f"""
        SELECT coalesce(ph, 'NA') AS phase, count(DISTINCT s.nct_id) AS studies
        FROM study s LEFT JOIN LATERAL unnest(s.phases) AS ph ON TRUE
        WHERE {w} AND s.status_group = 'recruiting' AND s.study_type = 'INTERVENTIONAL' GROUP BY 1 ORDER BY 1""", **p)
    by_sponsor = fetch_all(f"""
        SELECT coalesce(s.sponsor_class, 'UNKNOWN') AS sponsor_class, count(DISTINCT s.nct_id) AS studies
        FROM study_site ss JOIN study s USING (nct_id) JOIN facility f USING (facility_id)
        WHERE {ANALYSIS_SITE_WHERE} AND {w} {site_state} GROUP BY 1 ORDER BY 2 DESC""", **p)
    mask = m.tract_mask(scope)
    base = m.baseline(category)
    ct = m.county_table(category, threshold_mi)
    cm = m.county_mask(scope)
    per_state = (m.counties.assign(within=ct.pop_within, beyond=ct.pop_beyond)[cm].groupby("usps")
                 .agg(population=("pop_2020", "sum"), pop_within=("within", "sum"), pop_beyond=("beyond", "sum")).reset_index())
    per_state["pct_within"] = (100 * per_state.pop_within / per_state.population).round(2)
    pops = {r["usps"]: r for r in records(per_state)}
    for r in by_state:
        pp = pops.get(r["usps"])
        r["studies_per_100k"] = round(1e5 * r["studies"] / pp["population"], 2) if pp and pp["population"] else None
    excluded = fetch_one("SELECT count(*) AS n FROM study WHERE oncology_basis = 'not_oncology'")["n"]
    return {
        "filters": {"category": category, "state": state, "threshold_mi": threshold_mi},
        "status_counts": status,
        "recruiting_sites": sites,
        "recruiting_interventional_studies_without_recruiting_us_site_in_snapshot": recruiting_no_site,
        "coverage": m.summarize(base, threshold_mi, mask),
        "coverage_by_group": m.group_breakdown(base, threshold_mi, mask),
        "distance_bands": m.distance_bands(category, mask),
        "by_state": by_state, "state_coverage": records(per_state.sort_values("pct_within")),
        "by_category": by_cat, "recruiting_by_phase": by_phase, "by_sponsor_class": by_sponsor,
        "records_excluded_as_not_oncology": excluded,
        "distance_label": DISTANCE_LABEL,
    }


@router.get("/access/counties")
def access_counties(category: str = Depends(category_q), state: Optional[str] = Depends(state_q),
                    threshold_mi: float = Depends(threshold_q),
                    min_share: float = Query(50, ge=0, le=100, description="A county is an 'access gap' when fewer than this % of residents are within the threshold")):
    m = get_model()
    ct = m.county_table(category, threshold_mi)
    c = m.counties
    sup = {r["fips"]: r for r in fetch_all("SELECT * FROM county_supply WHERE category = :c", c=category)}
    df = c[["fips", "name", "usps", "pop_2020", "rucc_2023", "is_metro", *PROFILE_COLS]].copy()
    df["pct_within"], df["mean_mi"], df["pop_beyond"] = ct.pct_within, ct.mean_mi, ct.pop_beyond
    df["is_gap"] = df.pct_within < min_share
    df["sites_in_county"] = [sup.get(f, {}).get("recruiting_sites_in_county", 0) for f in df.fips]
    df["studies_in_county"] = [sup.get(f, {}).get("recruiting_studies_in_county", 0) for f in df.fips]
    df["studies_50mi"] = [sup.get(f, {}).get("recruiting_studies_50mi", 0) for f in df.fips]
    df = df[m.county_mask(scope_of(state))]
    return {"filters": {"category": category, "state": state, "threshold_mi": threshold_mi, "min_share": min_share},
            "gap_definition": f"County where fewer than {min_share:g}% of residents live within {threshold_mi:g} straight-line miles "
                              "of a currently recruiting interventional oncology trial site.",
            "n_counties": len(df), "n_gap_counties": int(df.is_gap.sum()), "gap_population": int(df.pop_2020[df.is_gap].sum()),
            "distance_label": DISTANCE_LABEL, "counties": records(df)}


@router.get("/access/by-category")
def access_by_category(state: Optional[str] = Depends(state_q), threshold_mi: float = Depends(threshold_q)):
    """Coverage for every cancer category side by side."""
    m = get_model()
    st = "AND f.usps = :state" if state else ""
    counts = {r["category"]: r for r in fetch_all(f"""
        SELECT cat.category, count(DISTINCT ss.nct_id) AS studies, count(DISTINCT f.facility_id) AS facilities
        FROM study_site ss JOIN study s USING (nct_id) JOIN facility f USING (facility_id)
        CROSS JOIN LATERAL unnest(s.filter_keys) AS cat(category)
        WHERE {ANALYSIS_SITE_WHERE} {st} GROUP BY 1""", **({"state": state} if state else {}))}
    rows = []
    for r in m.category_coverage(threshold_mi, scope_of(state)):
        c = counts.get(r["category"], {})
        rows.append({**r, "label": CATEGORY_LABEL[r["category"]], "group": "lens" if r["category"].startswith("lens_") else "cancer", "recruiting_studies": c.get("studies", 0),
                     "recruiting_facilities": c.get("facilities", 0),
                     "pct_beyond": None if r["pct_within"] is None else round(100 - r["pct_within"], 3)})
    return {"filters": {"state": state, "threshold_mi": threshold_mi}, "categories": rows,
            "note": "Study and facility counts are for sites located in the selected region; coverage counts residents of the "
                    "region against sites anywhere. A study can belong to several categories.",
            "distance_label": DISTANCE_LABEL}


@router.get("/access/counties.csv", response_class=PlainTextResponse)
def access_counties_csv(category: str = Depends(category_q), state: Optional[str] = Depends(state_q),
                        threshold_mi: float = Depends(threshold_q), min_share: float = Query(50, ge=0, le=100)):
    import pandas as pd
    d = access_counties(category, state, threshold_mi, min_share)
    head = (f"# TrialGraph county access table. category={category}; scope={state or 'US'}; threshold_mi={threshold_mi:g}; "
            f"gap = fewer than {min_share:g}% of residents within threshold.\n"
            "# mean_mi and pct_within are straight-line (great-circle) measures, not driving distance. Blank = not published by the source.\n")
    return PlainTextResponse(head + pd.DataFrame(d["counties"]).to_csv(index=False), media_type="text/csv",
                             headers={"Content-Disposition": f"attachment; filename=trialgraph_counties_{category}_{state or 'US'}.csv"})


@router.get("/access/compare")
def access_compare(category: str = Depends(category_q), state: Optional[str] = Depends(state_q),
                   threshold_mi: float = Depends(threshold_q), min_share: float = Query(50, ge=0, le=100)):
    m = get_model()
    scope = scope_of(state)
    out = m.compare_indicators(category, threshold_mi, min_share, scope)
    defs = {r["indicator_id"]: r for r in fetch_all("SELECT indicator_id, label, unit, vintage, direction FROM indicator")}
    for r in out["indicators"]:
        r.update(defs[r["indicator_id"]])
    base, mask = m.baseline(category), m.tract_mask(scope)
    rucc = []
    c = m.counties
    for code in range(1, 10):
        cm = (c.rucc_2023 == code).to_numpy()[m.tract_county] & mask
        if cm.any():
            rucc.append({"rucc_2023": code, "is_metro": code <= 3, "n_counties": int(((c.rucc_2023 == code) & m.county_mask(scope)).sum()),
                         **m.summarize(base, threshold_mi, cm)})
    rucc_desc = {r["rucc_2023"]: r["rucc_description"] for r in fetch_all(
        "SELECT DISTINCT rucc_2023, rucc_description FROM county WHERE rucc_2023 IS NOT NULL")}
    for r in rucc:
        r["description"] = rucc_desc.get(r["rucc_2023"])
    return {"filters": {"category": category, "state": state, "threshold_mi": threshold_mi, "min_share": min_share},
            **out, "by_rucc": rucc, "metro_vs_nonmetro": m.group_breakdown(base, threshold_mi, mask)[:2],
            "caveat": "County-level (ecological) comparison of population-weighted means. Associations describe places, "
                      "not individuals, and do not establish that distance causes any outcome.",
            "distance_label": DISTANCE_LABEL}


@router.get("/access/county/{fips}")
def county_detail(fips: str, category: str = Depends(category_q), threshold_mi: float = Depends(threshold_q)):
    c = fetch_one("""SELECT fips, name, usps, pop_2020, n_tracts, rucc_2023, rucc_description, is_metro, land_sqmi,
                            ST_Y(pop_centroid::geometry) AS centroid_lat, ST_X(pop_centroid::geometry) AS centroid_lon
                     FROM county WHERE fips = :f""", f=fips)
    if not c:
        raise HTTPException(404, "county not found")
    m = get_model()
    i = int(np.where(m.counties.fips == fips)[0][0])
    ct = records(m.county_table(category, threshold_mi).iloc[[i]])[0]
    tm = m.tract_county == i
    indicators = fetch_all("""
        SELECT i.indicator_id, i.label, i.unit, i.vintage, i.value_type, i.direction, i.uncertainty, i.source_key,
               ci.value, ci.moe, ci.ci_low, ci.ci_high, coalesce(ci.missing_reason, CASE WHEN ci.fips IS NULL THEN 'not_published_for_this_county' END) AS missing_reason
        FROM indicator i LEFT JOIN county_indicator ci ON ci.indicator_id = i.indicator_id AND ci.fips = :f
        ORDER BY i.source_key, i.indicator_id""", f=fips)
    cat = "" if category == "all" else "AND :cat = ANY(s.filter_keys)"
    p = {"f": fips, **({"cat": category} if category != "all" else {})}
    nearest = fetch_all(f"""
        WITH site AS (SELECT f.facility_id, f.name, f.is_placeholder_name, f.city, f.usps, f.geom, f.geocode_confidence,
                             count(DISTINCT ss.nct_id) AS recruiting_studies
                      FROM study_site ss JOIN study s USING (nct_id) JOIN facility f USING (facility_id)
                      WHERE {ANALYSIS_SITE_WHERE} {cat} GROUP BY f.facility_id)
        SELECT site.facility_id, site.name, site.is_placeholder_name, site.city, site.usps, site.geocode_confidence,
               site.recruiting_studies, round((ST_Distance(site.geom, c.pop_centroid) / 1609.344)::numeric, 1)::float AS miles,
               ST_Y(site.geom::geometry) AS lat, ST_X(site.geom::geometry) AS lon
        FROM site, county c WHERE c.fips = :f ORDER BY site.geom <-> c.pop_centroid LIMIT 8""", **p)
    supply = fetch_one("SELECT * FROM county_supply WHERE fips = :f AND category = :c", f=fips, c=category)
    return {"county": c, "category": category, "threshold_mi": threshold_mi, "access": ct,
            "access_detail": m.summarize(m.baseline(category), threshold_mi, tm),
            "supply": supply, "indicators": indicators, "nearest_recruiting_sites": nearest,
            "nearest_sites_note": "Miles are straight-line from the county's population-weighted centre (PostGIS geodesic).",
            "travel_time": _travel_time(c, nearest), "distance_label": DISTANCE_LABEL}


def _travel_time(county: dict, sites: list[dict]) -> dict:
    """Optional road travel time via an OSRM-compatible server. Disabled unless TG_OSRM_URL is set."""
    base = get_settings().osrm_url.rstrip("/")
    if not base:
        return {"configured": False, "message": "No routing source configured (TG_OSRM_URL). Only straight-line distance is shown."}
    if not sites:
        return {"configured": True, "results": []}
    coords = ";".join([f"{county['centroid_lon']},{county['centroid_lat']}"] + [f"{s['lon']},{s['lat']}" for s in sites])
    try:
        r = httpx.get(f"{base}/table/v1/driving/{coords}", params={"sources": "0", "annotations": "duration,distance"}, timeout=15)
        r.raise_for_status()
        d = r.json()
        return {"configured": True, "source": base, "label": "Estimated road travel time from the routing source (free-flow, no traffic)",
                "results": [{"facility_id": s["facility_id"],
                             "drive_minutes": None if dur is None else round(dur / 60, 1),
                             "road_miles": None if dist is None else round(dist / 1609.344, 1)}
                            for s, dur, dist in zip(sites, d["durations"][0][1:], d["distances"][0][1:])]}
    except Exception as e:
        return {"configured": True, "error": f"routing request failed: {e}"}
