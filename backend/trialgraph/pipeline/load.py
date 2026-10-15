"""Load staging tables into PostGIS and run the SQL-side geographic normalisation.

The load is a full, idempotent rebuild: schema.sql drops and recreates every table, so
re-running the pipeline can never leave a mixture of two retrieval dates.
"""
from __future__ import annotations

import io
import json
from datetime import datetime, timezone
from pathlib import Path

import geopandas as gpd
import pandas as pd
from sqlalchemy import text

from ..config import get_settings
from ..db import get_engine
from ..sources.fetch import read_manifest
from .reference import FIPS_TO_USPS

SCHEMA_SQL = Path(__file__).resolve().parents[1] / "schema.sql"

# Static descriptive metadata for each manifest key (prefix match).
SOURCE_META = {
    "ctgov_studies": dict(source_name="ClinicalTrials.gov API v2 - study records", publisher="U.S. National Library of Medicine (NIH)",
                          license="Public domain (U.S. Government work); see ClinicalTrials.gov Terms and Conditions",
                          geographic_grain="study site (city / ZIP)"),
    "acs5_": dict(source_name="American Community Survey 5-year table-based Summary File", publisher="U.S. Census Bureau",
                  license="Public domain (U.S. Government work)", geographic_grain="county"),
    "cdc_places_county": dict(source_name="PLACES: Local Data for Better Health, County Data", publisher="Centers for Disease Control and Prevention",
                              license="Public domain (U.S. Government work)", geographic_grain="county"),
    "census_cb_": dict(source_name="Cartographic Boundary Files", publisher="U.S. Census Bureau",
                       license="Public domain (U.S. Government work)", geographic_grain="county / state polygons"),
    "census_cenpop2020_tract": dict(source_name="2020 Census Centers of Population by Census Tract", publisher="U.S. Census Bureau",
                                    license="Public domain (U.S. Government work)", geographic_grain="census tract"),
    "census_gazetteer_zcta": dict(source_name="Gazetteer Files - ZIP Code Tabulation Areas", publisher="U.S. Census Bureau",
                                  license="Public domain (U.S. Government work)", geographic_grain="ZCTA"),
    "usda_rucc_2023": dict(source_name="Rural-Urban Continuum Codes 2023", publisher="USDA Economic Research Service",
                           license="Public domain (U.S. Government work)", geographic_grain="county"),
}


def _meta_for(key: str) -> dict:
    for k, v in SOURCE_META.items():
        if key == k or (k.endswith("_") and key.startswith(k)):
            return v
    raise KeyError(key)


def copy_df(conn, df: pd.DataFrame, table: str) -> None:
    """Fast bulk load through PostgreSQL COPY. Lists/dicts must already be JSON strings."""
    buf = io.StringIO()
    df.to_csv(buf, index=False, header=False, na_rep="\\N")
    buf.seek(0)
    cols = ", ".join(f'"{c}"' for c in df.columns)
    raw = conn.connection.dbapi_connection
    with raw.cursor() as cur, cur.copy(f"COPY {table} ({cols}) FROM STDIN WITH (FORMAT csv, NULL '\\N')") as cp:
        while chunk := buf.read(1 << 20):
            cp.write(chunk)


def _stage(conn, df: pd.DataFrame, name: str, types: dict[str, str] | None = None) -> None:
    types = types or {}
    cols = ", ".join(f'"{c}" {types.get(c, "text")}' for c in df.columns)
    conn.execute(text(f"DROP TABLE IF EXISTS {name}; CREATE TEMP TABLE {name} ({cols})"))
    copy_df(conn, df, name)


def _json_list(col: pd.Series) -> pd.Series:
    return col.map(lambda v: json.dumps([str(x) for x in v]) if v is not None and len(v) else "[]")


def grant_read_only(role: str = "trialgraph_ro") -> None:
    """Give the API's read-only role SELECT on everything (idempotent; skipped when the role does not exist)."""
    with get_engine().begin() as conn:
        if conn.execute(text("SELECT 1 FROM pg_roles WHERE rolname = :r"), {"r": role}).scalar():
            conn.execute(text(f"GRANT USAGE ON SCHEMA public TO {role}; GRANT SELECT ON ALL TABLES IN SCHEMA public TO {role}"))


def load_all() -> dict:
    s = get_settings()
    st = s.staging_dir
    eng = get_engine()
    started = datetime.now(timezone.utc)
    summary: dict = {}
    with eng.begin() as conn:
        conn.execute(text(SCHEMA_SQL.read_text()))

        # ---- lineage
        for key, m in read_manifest().items():
            meta = _meta_for(key)
            upd = m.get("source_data_timestamp") or m.get("source_rows_updated_at")
            if isinstance(upd, (int, float)):
                upd = datetime.fromtimestamp(upd, timezone.utc).isoformat()
            notes = []
            if m.get("filtered"):
                notes.append("Only county rows (GEO_ID 0500000US*) are kept on disk; hash/bytes describe the full upstream file.")
            if m.get("api_version"):
                notes.append(f"API version {m['api_version']}; upstream totalCount {m.get('upstream_total_count')}.")
            if m.get("table_title"):
                notes.append(f"Table {m['table']}: {m['table_title']}.")
            conn.execute(text("""
                INSERT INTO source_dataset (source_key, source_name, publisher, url, license, vintage, geographic_grain,
                    retrieved_at, source_updated_at, upstream_sha256, upstream_bytes, row_count, params, notes)
                VALUES (:k, :n, :p, :u, :l, :v, :g, :r, :su, :sha, :b, :rc, CAST(:params AS jsonb), :notes)"""),
                dict(k=key, n=meta["source_name"], p=meta["publisher"], u=m["url"], l=meta["license"],
                     v=m.get("vintage") or ("live registry snapshot" if key == "ctgov_studies" else None),
                     g=meta["geographic_grain"], r=m["retrieved_at"], su=upd, sha=m.get("upstream_sha256"),
                     b=m.get("upstream_bytes"), rc=m.get("row_count"), params=json.dumps(m.get("params")),
                     notes=" ".join(notes) or None))

        # ---- states and counties
        y = s.boundary_year
        g = s.raw_dir / "geo"
        states = gpd.read_file(f"zip://{g / f'cb_{y}_us_state_20m.zip'}").to_crs(4326)
        states = states[states.STATEFP.isin(FIPS_TO_USPS)]
        c5 = gpd.read_file(f"zip://{g / f'cb_{y}_us_county_5m.zip'}").to_crs(4326)
        c20 = gpd.read_file(f"zip://{g / f'cb_{y}_us_county_20m.zip'}").to_crs(4326)
        c5 = c5[c5.STATEFP.isin(FIPS_TO_USPS)]
        if s.pilot_state_list:
            c5 = c5[c5.STUSPS.isin(s.pilot_state_list)]
        _stage(conn, pd.DataFrame({"state_fips": states.STATEFP, "usps": states.STUSPS, "name": states.NAME,
                                   "wkt": states.geometry.to_wkt()}), "stg_state")
        conn.execute(text("""INSERT INTO state SELECT state_fips, usps, name,
                             ST_Multi(ST_GeomFromText(wkt, 4326)) FROM stg_state"""))
        _stage(conn, pd.DataFrame({"fips": c5.GEOID, "state_fips": c5.STATEFP, "usps": c5.STUSPS, "name": c5.NAMELSAD,
                                   "aland": c5.ALAND.astype("int64"), "wkt": c5.geometry.to_wkt()}), "stg_county",
               {"aland": "bigint"})
        _stage(conn, pd.DataFrame({"fips": c20.GEOID, "wkt": c20.geometry.to_wkt()}), "stg_county20")
        conn.execute(text("""
            INSERT INTO county (fips, state_fips, usps, name, land_sqmi, geom, geom_display)
            SELECT a.fips, a.state_fips, a.usps, a.name, a.aland / 2589988.110336,
                   ST_Multi(ST_MakeValid(ST_GeomFromText(a.wkt, 4326))),
                   ST_Multi(ST_GeomFromText(b.wkt, 4326))
            FROM stg_county a LEFT JOIN stg_county20 b USING (fips)"""))

        # ---- tracts: load, then assign to *current* counties by point-in-polygon.
        # (2020 tract GEOIDs embed 2020 county codes; Connecticut replaced its counties with planning
        #  regions in 2022, so a GEOID-prefix join would orphan every Connecticut tract.)
        tr = pd.read_parquet(st / "tract_center.parquet")
        _stage(conn, tr, "stg_tract", {"pop_2020": "integer", "lat": "double precision", "lon": "double precision"})
        conn.execute(text("""
            INSERT INTO tract_center (geoid, pop_2020, geom)
            SELECT geoid, pop_2020, ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography FROM stg_tract;
            UPDATE tract_center t SET county_fips = c.fips, county_assign_method = 'contains'
              FROM county c WHERE ST_Contains(c.geom, t.geom::geometry);
            UPDATE tract_center t SET county_fips = n.fips, county_assign_method = 'nearest_in_state'
              FROM (SELECT t2.geoid, (SELECT c.fips FROM county c WHERE c.state_fips = left(t2.geoid, 2)
                                      ORDER BY c.geom <-> t2.geom::geometry LIMIT 1) AS fips
                    FROM tract_center t2 WHERE t2.county_fips IS NULL) n
              WHERE t.geoid = n.geoid;
            -- population-weighted county centre: 3-D mean of tract centres (safe across the antimeridian)
            WITH w AS (
              SELECT county_fips, sum(pop_2020) AS pop, count(*) AS n,
                     sum(pop_2020 * cos(radians(ST_Y(geom::geometry))) * cos(radians(ST_X(geom::geometry)))) AS x,
                     sum(pop_2020 * cos(radians(ST_Y(geom::geometry))) * sin(radians(ST_X(geom::geometry)))) AS y,
                     sum(pop_2020 * sin(radians(ST_Y(geom::geometry)))) AS z
              FROM tract_center GROUP BY county_fips)
            UPDATE county c SET pop_2020 = w.pop, n_tracts = w.n,
                   pop_centroid = CASE WHEN w.pop > 0 THEN
                       ST_SetSRID(ST_MakePoint(degrees(atan2(w.y, w.x)), degrees(atan2(w.z, sqrt(w.x*w.x + w.y*w.y)))), 4326)::geography
                     ELSE ST_PointOnSurface(c.geom)::geography END
              FROM w WHERE w.county_fips = c.fips;
            UPDATE county SET pop_centroid = ST_PointOnSurface(geom)::geography, pop_2020 = 0, n_tracts = 0
              WHERE pop_centroid IS NULL;
            -- island-chain counties (e.g. Florida Keys, Aleutians): the weighted mean can fall in open water.
            -- Snap it to the nearest tract centre so the county's reference point is a place people live.
            UPDATE county c SET pop_centroid = (SELECT t.geom FROM tract_center t WHERE t.county_fips = c.fips
                                               ORDER BY ST_Distance(t.geom, c.pop_centroid) LIMIT 1)
              WHERE c.pop_2020 > 0 AND NOT ST_DWithin(c.geom::geography, c.pop_centroid, 5000);"""))

        rucc = pd.read_parquet(st / "rucc.parquet")
        _stage(conn, rucc, "stg_rucc", {"rucc_2023": "smallint"})
        conn.execute(text("""UPDATE county c SET rucc_2023 = r.rucc_2023, rucc_description = r.rucc_description,
                             is_metro = (r.rucc_2023 <= 3) FROM stg_rucc r WHERE r.fips = c.fips"""))

        # ---- indicators
        defs = pd.concat([pd.read_parquet(st / "indicator_def_acs.parquet"),
                          pd.read_parquet(st / "indicator_def_places.parquet")], ignore_index=True)
        copy_df(conn, defs, "indicator")
        vals = pd.concat([pd.read_parquet(st / "indicator_acs.parquet"),
                          pd.read_parquet(st / "indicator_places.parquet")], ignore_index=True)
        vals = vals[["fips", "indicator_id", "value", "moe", "ci_low", "ci_high", "missing_reason"]]
        _stage(conn, vals, "stg_ind", {c: "double precision" for c in ("value", "moe", "ci_low", "ci_high")})
        conn.execute(text("INSERT INTO county_indicator SELECT s.* FROM stg_ind s JOIN county c USING (fips)"))
        summary["indicator_rows_without_matching_county"] = conn.execute(text(
            "SELECT count(*) FROM stg_ind s LEFT JOIN county c USING (fips) WHERE c.fips IS NULL")).scalar()
        conn.execute(text("""UPDATE indicator i SET n_counties_with_value =
                             (SELECT count(*) FROM county_indicator ci WHERE ci.indicator_id = i.indicator_id AND ci.value IS NOT NULL)"""))

        # ---- studies
        sd = pd.read_parquet(st / "study.parquet")
        for col in ("phases", "conditions", "mesh_terms", "intervention_types", "std_ages", "cancer_categories", "lenses"):
            sd[col] = _json_list(sd[col])
        sd["enrollment_count"] = sd.enrollment_count.astype("Int64")
        _stage(conn, sd, "stg_study", {"enrollment_count": "integer", "min_age_years": "double precision",
                                       "max_age_years": "double precision", "healthy_volunteers": "boolean"})
        arr = lambda c: f"ARRAY(SELECT jsonb_array_elements_text({c}::jsonb))"  # noqa: E731
        conn.execute(text(f"""
            INSERT INTO study (nct_id, brief_title, overall_status, status_group, status_verified_date, last_update_posted,
                start_date, primary_completion_date, study_type, phases, enrollment_count, enrollment_type, lead_sponsor,
                sponsor_class, conditions, mesh_terms, interventions, intervention_types, sex, min_age_years, max_age_years,
                std_ages, healthy_volunteers, oncology_basis, cancer_categories, lenses)
            SELECT nct_id, brief_title, overall_status, status_group, status_verified_date, last_update_posted::date,
                start_date, primary_completion_date, study_type, {arr('phases')}, enrollment_count, enrollment_type,
                lead_sponsor, sponsor_class, {arr('conditions')}, {arr('mesh_terms')}, interventions::jsonb,
                {arr('intervention_types')}, sex, min_age_years, max_age_years, {arr('std_ages')}, healthy_volunteers,
                oncology_basis, {arr('cancer_categories')}, {arr('lenses')}
            FROM stg_study;
            UPDATE study SET filter_keys = ARRAY['all']::text[] || cancer_categories || lenses;
            UPDATE study SET search_text = concat_ws(' ', nct_id, brief_title, array_to_string(conditions, ' '),
                                                     array_to_string(mesh_terms, ' '), lead_sponsor);"""))

        # ---- facilities
        fac = pd.read_parquet(st / "facility.parquet")
        _stage(conn, fac, "stg_fac", {"facility_id": "integer", "is_placeholder_name": "boolean", "lat": "double precision",
                                      "lon": "double precision", "zip_city_gap_mi": "double precision",
                                      "n_source_records": "integer", "n_name_variants": "integer"})
        conn.execute(text("""
            INSERT INTO facility (facility_id, name, name_norm, is_placeholder_name, city, usps, zip5, geom, geocode_method,
                                  geocode_confidence, zip_city_gap_mi, n_source_records, n_name_variants)
            SELECT facility_id, name, name_norm, is_placeholder_name, city, usps, zip5,
                   CASE WHEN lat IS NOT NULL THEN ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography END,
                   geocode_method, geocode_confidence, zip_city_gap_mi, n_source_records, n_name_variants
            FROM stg_fac;
            UPDATE facility f SET county_fips = c.fips FROM county c
              WHERE f.geom IS NOT NULL AND ST_Contains(c.geom, f.geom::geometry);
            -- coastal / generalised-boundary misses: nearest county within 10 km
            UPDATE facility f SET county_fips = (SELECT c.fips FROM county c
                    WHERE ST_DWithin(c.geom::geography, f.geom, 10000) ORDER BY c.geom::geography <-> f.geom LIMIT 1)
              WHERE f.geom IS NOT NULL AND f.county_fips IS NULL;
            UPDATE facility f SET state_mismatch = (c.usps <> f.usps) FROM county c WHERE c.fips = f.county_fips;
            -- a coordinate that lands in a different state than the registry reports is not trustworthy
            UPDATE facility SET geocode_confidence = 'low' WHERE state_mismatch AND geocode_confidence <> 'none';"""))

        ss = pd.read_parquet(st / "study_site.parquet")
        copy_df(conn, ss[["nct_id", "facility_id", "site_status", "is_recruiting_site", "facility_raw"]], "study_site")

        # ---- wide county profile for the API (generated from the indicator table, so it cannot drift)
        ids = [r[0] for r in conn.execute(text("SELECT indicator_id FROM indicator ORDER BY 1"))]
        pivots = ",\n".join(f"max(ci.value) FILTER (WHERE ci.indicator_id = '{i}') AS {i}" for i in ids)
        conn.execute(text(f"""
            CREATE MATERIALIZED VIEW county_profile AS
            SELECT c.fips, c.usps, c.name, c.pop_2020, c.rucc_2023, c.is_metro, c.land_sqmi,
                   ST_Y(c.pop_centroid::geometry) AS centroid_lat, ST_X(c.pop_centroid::geometry) AS centroid_lon,
                   {pivots}
            FROM county c LEFT JOIN county_indicator ci USING (fips)
            GROUP BY c.fips;
            CREATE UNIQUE INDEX county_profile_pk ON county_profile (fips);"""))

        for t in ("state", "county", "tract_center", "indicator", "county_indicator", "study", "facility", "study_site"):
            summary[f"rows_{t}"] = conn.execute(text(f"SELECT count(*) FROM {t}")).scalar()
        summary["tracts_assigned_by_nearest"] = conn.execute(text(
            "SELECT count(*) FROM tract_center WHERE county_assign_method = 'nearest_in_state'")).scalar()
        summary["facilities_state_mismatch"] = conn.execute(text(
            "SELECT count(*) FROM facility WHERE state_mismatch")).scalar()
        summary["facilities_without_county"] = conn.execute(text(
            "SELECT count(*) FROM facility WHERE geom IS NOT NULL AND county_fips IS NULL")).scalar()
        conn.execute(text("INSERT INTO pipeline_run (started_at, finished_at, scope, summary) VALUES (:s, now(), :scope, CAST(:j AS jsonb))"),
                     dict(s=started, scope=",".join(s.pilot_state_list) or "national", j=json.dumps(summary)))
    with eng.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
        conn.execute(text("ANALYZE"))
    grant_read_only()
    return summary
