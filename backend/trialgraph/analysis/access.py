"""Baseline access computation: every census tract -> nearest currently-recruiting site.

Definition of an *analysis site* (used everywhere a distance or coverage figure appears):
  - the study is oncology-related (oncology_basis in mesh / condition_text),
  - the study is INTERVENTIONAL,
  - the study's overall status is RECRUITING and the site's own status is RECRUITING,
  - the site has a coordinate (geocode_confidence <> 'none').
"""
from __future__ import annotations

import io

import numpy as np
import pandas as pd
from sqlalchemy import text

from ..db import get_engine
from ..pipeline.classify import CATEGORY_RULES, LENS_RULES
from .distance import count_within, nearest

CATEGORIES = ["all", *CATEGORY_RULES, *LENS_RULES]

ANALYSIS_SITE_SQL = """
    SELECT DISTINCT f.facility_id, ST_Y(f.geom::geometry) AS lat, ST_X(f.geom::geometry) AS lon
    FROM study_site ss
    JOIN study s USING (nct_id)
    JOIN facility f USING (facility_id)
    WHERE ss.is_recruiting_site
      AND s.study_type = 'INTERVENTIONAL'
      AND s.oncology_basis <> 'not_oncology'
      AND f.geom IS NOT NULL
      AND :category = ANY (s.filter_keys)
    ORDER BY f.facility_id
"""


def load_tracts(conn) -> pd.DataFrame:
    return pd.read_sql(text("""
        SELECT t.geoid, t.county_fips, t.pop_2020 AS pop, ST_Y(t.geom::geometry) AS lat, ST_X(t.geom::geometry) AS lon
        FROM tract_center t ORDER BY t.geoid"""), conn)


def load_sites(conn, category: str) -> pd.DataFrame:
    return pd.read_sql(text(ANALYSIS_SITE_SQL), conn, params={"category": category})


def compute_access() -> dict:
    eng = get_engine()
    out = {}
    with eng.begin() as conn:
        tracts = load_tracts(conn)
        conn.execute(text("TRUNCATE tract_access, county_supply"))
        for cat in CATEGORIES:
            sites = load_sites(conn, cat)
            miles, idx = nearest(tracts.lat, tracts.lon, sites.lat, sites.lon)
            within = count_within(tracts.lat, tracts.lon, sites.lat, sites.lon, 50.0)
            df = pd.DataFrame({
                "geoid": tracts.geoid, "category": cat,
                "nearest_mi": np.where(np.isfinite(miles), np.round(miles, 3), np.nan),
                "nearest_facility_id": pd.array(np.where(idx >= 0, sites.facility_id.to_numpy()[idx] if len(sites) else -1, -1),
                                                dtype="Int64").map(lambda v: pd.NA if v == -1 else v),
                "sites_within_50mi": within,
            })
            buf = io.StringIO()
            df.to_csv(buf, index=False, header=False, na_rep="\\N")
            buf.seek(0)
            raw = conn.connection.dbapi_connection
            with raw.cursor() as cur, cur.copy(
                "COPY tract_access (geoid, category, nearest_mi, nearest_facility_id, sites_within_50mi) "
                "FROM STDIN WITH (FORMAT csv, NULL '\\N')") as cp:
                cp.write(buf.read())
            out[cat] = {"sites": int(len(sites))}
            print(f"  access[{cat}]: {len(sites)} recruiting sites", flush=True)

        # County supply counts, computed entirely in PostGIS (geography => metres on the WGS-84 spheroid).
        conn.execute(text("""
            CREATE TEMP TABLE _site ON COMMIT DROP AS
                SELECT DISTINCT ss.nct_id, f.facility_id, f.county_fips, cat.category
                FROM study_site ss JOIN study s USING (nct_id) JOIN facility f USING (facility_id)
                CROSS JOIN LATERAL unnest(s.filter_keys) AS cat(category)
                WHERE ss.is_recruiting_site AND s.study_type = 'INTERVENTIONAL'
                  AND s.oncology_basis <> 'not_oncology' AND f.geom IS NOT NULL;
            CREATE INDEX ON _site (facility_id);
            -- spatial step once per (county, facility), using the GiST index on facility.geom
            CREATE TEMP TABLE _county_fac ON COMMIT DROP AS
                SELECT c.fips, f.facility_id
                FROM county c JOIN facility f ON ST_DWithin(c.pop_centroid, f.geom, 50 * 1609.344)
                WHERE f.facility_id IN (SELECT facility_id FROM _site);
            ANALYZE _site; ANALYZE _county_fac;
            WITH cats AS (SELECT DISTINCT category FROM _site),
            in_county AS (
                SELECT county_fips AS fips, category, count(DISTINCT facility_id) AS sites, count(DISTINCT nct_id) AS studies
                FROM _site WHERE county_fips IS NOT NULL GROUP BY 1, 2),
            near AS (
                SELECT cf.fips, s.category, count(DISTINCT s.nct_id) AS studies
                FROM _county_fac cf JOIN _site s USING (facility_id) GROUP BY 1, 2)
            INSERT INTO county_supply
            SELECT c.fips, cats.category, coalesce(i.sites, 0), coalesce(i.studies, 0), coalesce(n.studies, 0)
            FROM county c CROSS JOIN cats
            LEFT JOIN in_county i ON i.fips = c.fips AND i.category = cats.category
            LEFT JOIN near n ON n.fips = c.fips AND n.category = cats.category"""))
    with eng.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
        conn.execute(text("ANALYZE tract_access; ANALYZE county_supply"))
    return out
