"""Data validation against the loaded PostGIS database. These encode the project's integrity rules."""
import pytest

pytestmark = pytest.mark.db


def one(db, sql, **p):
    return list(db.fetch_one(sql, **p).values())[0]


def national(db) -> bool:
    return db.fetch_one("SELECT scope FROM pipeline_run ORDER BY run_id DESC LIMIT 1")["scope"] == "national"


def test_every_source_has_lineage(db):
    rows = db.fetch_all("SELECT * FROM source_dataset")
    keys = {r["source_key"] for r in rows}
    assert {"ctgov_studies", "cdc_places_county", "census_cenpop2020_tract", "usda_rucc_2023"} <= keys
    assert sum(k.startswith("acs5_") for k in keys) == 9
    for r in rows:
        assert r["url"].startswith("https://") and r["retrieved_at"] is not None and r["publisher"]
        assert r["upstream_sha256"] is None or len(r["upstream_sha256"]) == 64


def test_every_indicator_is_documented_and_traceable(db):
    assert one(db, "SELECT count(*) FROM indicator WHERE definition IS NULL OR formula IS NULL OR vintage IS NULL OR limitations IS NULL") == 0
    assert one(db, "SELECT count(*) FROM indicator i LEFT JOIN source_dataset s USING (source_key) WHERE s.source_key IS NULL") == 0


def test_geography_is_complete(db):
    scope = db.fetch_one("SELECT scope FROM pipeline_run ORDER BY run_id DESC LIMIT 1")["scope"]
    if scope == "national":
        assert one(db, "SELECT count(*) FROM county") == 3144
        assert one(db, "SELECT count(*) FROM state") == 51
        # every resident counted in the 2020 Census (50 states + DC) is on the population surface
        assert one(db, "SELECT sum(pop_2020) FROM tract_center") == 331_449_281
    assert one(db, "SELECT count(*) FROM tract_center WHERE county_fips IS NULL") == 0
    assert one(db, "SELECT count(*) FROM county WHERE pop_centroid IS NULL OR rucc_2023 IS NULL OR NOT ST_IsValid(geom)") == 0
    assert one(db, "SELECT sum(pop_2020) FROM county") == one(db, "SELECT sum(pop_2020) FROM tract_center")


def test_population_centroid_lies_near_its_county(db):
    far = one(db, "SELECT count(*) FROM county WHERE pop_2020 > 0 AND NOT ST_DWithin(geom::geography, pop_centroid, 5000)")
    assert far == 0


def test_connecticut_tracts_map_to_planning_regions(db):
    if one(db, "SELECT count(*) FROM county WHERE usps = 'CT'") == 0:
        pytest.skip("CT not in pilot scope")
    assert one(db, "SELECT count(DISTINCT county_fips) FROM tract_center WHERE geoid LIKE '09%'") == 9
    assert one(db, "SELECT count(*) FROM tract_center WHERE geoid LIKE '09%' AND county_fips NOT LIKE '091%'") == 0


def test_study_identifiers_and_statuses(db):
    assert one(db, "SELECT count(*) FROM study WHERE nct_id !~ '^NCT[0-9]{8}$'") == 0
    assert one(db, "SELECT count(*) FROM study") == one(db, "SELECT count(DISTINCT nct_id) FROM study")
    groups = {r["status_group"] for r in db.fetch_all("SELECT DISTINCT status_group FROM study")}
    assert groups <= {"recruiting", "not_yet_recruiting", "enrolling_by_invitation", "active_not_recruiting", "completed", "unknown"}
    assert "recruiting" in groups and "completed" in groups


def test_recruiting_flag_never_leaks_from_non_recruiting_studies(db):
    assert one(db, """SELECT count(*) FROM study_site ss JOIN study s USING (nct_id)
                      WHERE ss.is_recruiting_site AND (s.overall_status <> 'RECRUITING' OR ss.site_status IS DISTINCT FROM 'RECRUITING')""") == 0
    # and the converse: not every study is recruiting
    assert one(db, "SELECT count(*) FROM study WHERE status_group <> 'recruiting'") > one(db, "SELECT count(*) FROM study WHERE status_group = 'recruiting'")


def test_referential_integrity(db):
    assert one(db, "SELECT count(*) FROM study_site ss LEFT JOIN study s USING (nct_id) WHERE s.nct_id IS NULL") == 0
    assert one(db, "SELECT count(*) FROM facility f LEFT JOIN study_site ss USING (facility_id) WHERE ss.facility_id IS NULL") == 0
    assert one(db, "SELECT count(*) FROM (SELECT name_norm, lower(city), usps, zip5 FROM facility GROUP BY 1,2,3,4 HAVING count(*) > 1) d") == 0


def test_geocoding_confidence_rules(db):
    assert one(db, "SELECT count(*) FROM facility WHERE (geom IS NULL) <> (geocode_confidence = 'none')") == 0
    assert one(db, "SELECT count(*) FROM facility WHERE state_mismatch AND geocode_confidence NOT IN ('low')") == 0
    # in a pilot run a handful of mis-located sites can fall outside the loaded counties; nationally none may
    orphans = one(db, "SELECT count(*) FROM facility WHERE geom IS NOT NULL AND county_fips IS NULL")
    assert orphans == 0 if national(db) else orphans <= 0.02 * one(db, "SELECT count(*) FROM facility")
    share_high = one(db, "SELECT avg((geocode_confidence = 'high')::int) FROM facility")
    assert share_high > 0.75


def test_missing_values_are_explicit_never_imputed(db):
    assert one(db, "SELECT count(*) FROM county_indicator WHERE value IS NULL AND missing_reason IS NULL") == 0
    assert one(db, "SELECT count(*) FROM county_indicator WHERE indicator_id LIKE '%pct%' AND (value < 0 OR value > 100)") == 0
    assert one(db, "SELECT count(*) FROM county_indicator WHERE indicator_id LIKE 'places_%' AND value IS NOT NULL AND NOT (ci_low <= value AND value <= ci_high)") == 0


def test_tract_access_is_complete_and_sane(db):
    n_tracts = one(db, "SELECT count(*) FROM tract_center")
    for r in db.fetch_all("SELECT category, count(*) AS n, min(nearest_mi) AS lo, max(nearest_mi) AS hi FROM tract_access GROUP BY 1"):
        assert r["n"] == n_tracts, r["category"]
        if r["lo"] is not None:      # a small pilot geography can have no recruiting site for a rare category
            assert r["lo"] >= 0 and r["hi"] < 3000
    # a category is a subset of 'all', so its nearest site can never be closer
    assert one(db, """SELECT count(*) FROM tract_access a JOIN tract_access b USING (geoid)
                      WHERE a.category = 'all' AND b.category <> 'all' AND b.nearest_mi < a.nearest_mi - 0.01""") == 0


def test_python_distance_agrees_with_postgis_geodesic(db):
    """Reproducibility cross-check: spherical KD-tree result vs PostGIS spheroidal ST_Distance (<= 0.6%)."""
    r = db.fetch_one("""
        WITH s AS (SELECT a.nearest_mi, ST_Distance(t.geom, f.geom) / 1609.344 AS pg_mi
                   FROM tract_access a JOIN tract_center t USING (geoid) JOIN facility f ON f.facility_id = a.nearest_facility_id
                   WHERE a.category = 'all' AND a.geoid LIKE '%3')
        SELECT count(*) AS n, max(abs(nearest_mi - pg_mi) / greatest(pg_mi, 1)) AS max_rel FROM s""")
    assert r["n"] > (1000 if national(db) else 20) and r["max_rel"] < 0.006


def test_nearest_is_truly_nearest_per_postgis_knn(db):
    """For a sample of tracts, PostGIS's own nearest analysis site is not meaningfully closer than ours."""
    r = db.fetch_one("""
        WITH site AS (SELECT DISTINCT f.facility_id, f.geom FROM study_site ss JOIN study s USING (nct_id) JOIN facility f USING (facility_id)
                      WHERE ss.is_recruiting_site AND s.study_type = 'INTERVENTIONAL' AND s.oncology_basis <> 'not_oncology' AND f.geom IS NOT NULL),
        samp AS (SELECT t.geoid, t.geom, a.nearest_mi FROM tract_center t JOIN tract_access a USING (geoid)
                 WHERE a.category = 'all' AND t.geoid LIKE '%001') 
        SELECT max(a.nearest_mi - k.mi) AS worst FROM samp a CROSS JOIN LATERAL (
            SELECT ST_Distance(a.geom, s.geom) / 1609.344 AS mi FROM site s ORDER BY ST_Distance(a.geom, s.geom) LIMIT 1) k""")
    assert r["worst"] < 0.5


def test_freshness_report(db):
    from trialgraph.analysis.freshness import freshness_report
    rep = freshness_report()
    assert rep["overall_status"] in {"fresh", "stale"}
    assert all(s["age_days"] >= 0 and s["stale_after_days"] > 0 for s in rep["sources"])


def test_filter_keys_and_lenses(db):
    assert one(db, "SELECT count(*) FROM study WHERE NOT ('all' = ANY(filter_keys))") == 0
    assert one(db, "SELECT count(*) FROM study WHERE NOT (cancer_categories <@ filter_keys AND lenses <@ filter_keys)") == 0
    # a lens is a subset of all oncology: never better covered
    assert one(db, """SELECT count(*) FROM tract_access a JOIN tract_access b USING (geoid)
                      WHERE a.category = 'all' AND b.category LIKE 'lens_%' AND b.nearest_mi < a.nearest_mi - 0.01""") == 0
    assert one(db, "SELECT count(*) FROM study WHERE 'lens_phase1' = ANY(lenses) AND NOT (phases && ARRAY['PHASE1','EARLY_PHASE1'])") == 0
