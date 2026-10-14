import numpy as np
import pandas as pd
import pytest

from trialgraph.analysis import scoring as S
from trialgraph.analysis.distance import EARTH_RADIUS_MI, count_within, haversine_miles, nearest
from trialgraph.pipeline.transform import (
    ACS_INDICATORS,
    build_facilities,
    compute_acs_indicator,
    geocode_sites,
    moe_proportion,
    moe_sum,
)

NYC, LA, CHI = (40.7128, -74.0060), (34.0522, -118.2437), (41.8781, -87.6298)


def test_haversine_known_distances():
    # Published great-circle distances (spherical earth): NYC-LA ~2,446 mi, NYC-Chicago ~712 mi.
    assert haversine_miles(*NYC, *LA) == pytest.approx(2446, abs=6)
    assert haversine_miles(*NYC, *CHI) == pytest.approx(712, abs=4)
    assert haversine_miles(*NYC, *NYC) == 0
    # one degree of latitude on the sphere
    assert haversine_miles(0, 0, 1, 0) == pytest.approx(2 * np.pi * EARTH_RADIUS_MI / 360, rel=1e-9)


def test_nearest_matches_brute_force():
    rng = np.random.default_rng(1)
    o = np.column_stack([rng.uniform(25, 49, 400), rng.uniform(-124, -67, 400)])
    d = np.column_stack([rng.uniform(25, 49, 60), rng.uniform(-124, -67, 60)])
    miles, idx = nearest(o[:, 0], o[:, 1], d[:, 0], d[:, 1])
    brute = haversine_miles(o[:, None, 0], o[:, None, 1], d[None, :, 0], d[None, :, 1])
    assert np.allclose(miles, brute.min(axis=1), rtol=1e-9, atol=1e-6)
    assert (idx == brute.argmin(axis=1)).all()
    cw = count_within(o[:, 0], o[:, 1], d[:, 0], d[:, 1], 150)
    assert (cw == (brute <= 150).sum(axis=1)).all()


def test_nearest_handles_antimeridian_and_no_destinations():
    miles, _ = nearest([51.9], [179.9], [51.9], [-179.9])   # Aleutians: 0.2 degrees of longitude apart, not 359.8
    assert miles[0] < 15
    miles, idx = nearest([40.0], [-100.0], [], [])
    assert np.isinf(miles[0]) and idx[0] == -1


def test_geocode_tiers():
    sites = pd.DataFrame({
        "nct_id": ["A", "B", "C", "D", "E"], "facility_raw": ["x"] * 5, "city": ["c"] * 5, "usps": ["NC"] * 5,
        "zip5": ["27710", None, "99999", "27710", None],
        "ctgov_lat": [35.99, 35.99, 35.99, None, None], "ctgov_lon": [-78.90, -78.90, -78.90, None, None],
        "site_status": ["RECRUITING"] * 5,
    })
    zcta = pd.DataFrame({"zip5": ["27710", "99999"], "lat": [36.007, 61.2], "lon": [-78.938, -149.9]})
    g = geocode_sites(sites, zcta).set_index("nct_id")
    assert g.loc["A", "geocode_method"] == "zcta_centroid" and g.loc["A", "geocode_confidence"] == "high"
    assert g.loc["A", "lat"] == pytest.approx(36.007)
    assert g.loc["B", "geocode_method"] == "city_point" and g.loc["B", "lat"] == pytest.approx(35.99)
    assert g.loc["C", "geocode_method"] == "city_point_zip_conflict" and g.loc["C", "geocode_confidence"] == "low"
    assert g.loc["C", "lat"] == pytest.approx(35.99), "a far-away ZIP must not move the site"
    assert g.loc["D", "geocode_method"] == "zcta_centroid_no_city"
    assert g.loc["E", "geocode_method"] == "none" and np.isnan(g.loc["E", "lat"]), "never invent a coordinate"


def test_facility_dedup_and_status_priority():
    sites = pd.DataFrame({
        "nct_id": ["N1", "N1", "N2", "N3"],
        "facility_raw": ["Duke University Medical Center", "DUKE UNIVERSITY MEDICAL CENTER", "Duke University Medical Center", "Research Site"],
        "city": ["Durham"] * 4, "usps": ["NC"] * 4, "zip5": ["27710"] * 4, "site_status": ["COMPLETED", "RECRUITING", "RECRUITING", None],
        "lat": [36.0] * 4, "lon": [-78.9] * 4, "geocode_method": ["zcta_centroid"] * 4, "geocode_confidence": ["high"] * 4,
        "zip_city_gap_mi": [1.0] * 4,
    })
    fac, links = build_facilities(sites)
    assert len(fac) == 2
    duke = fac[~fac.is_placeholder_name].iloc[0]
    assert duke.n_source_records == 3 and duke.n_name_variants == 2
    n1 = links[links.nct_id == "N1"]
    assert len(n1) == 1 and n1.site_status.iat[0] == "RECRUITING"


def test_acs_moe_formulas():
    assert moe_sum(np.array([[3.0], [4.0]]))[0] == pytest.approx(5.0)
    # Census worked-example shape: p = 0.25, MOE_num = 50, MOE_den = 100, den = 1000
    assert moe_proportion(np.array([250.0]), np.array([1000.0]), np.array([50.0]), np.array([100.0]))[0] == pytest.approx(
        np.sqrt(50**2 - 0.25**2 * 100**2) / 1000)
    # negative radicand falls back to the ratio formula rather than producing NaN
    assert np.isfinite(moe_proportion(np.array([900.0]), np.array([1000.0]), np.array([10.0]), np.array([400.0]))[0])


def test_acs_indicator_missing_values_are_not_imputed():
    t = pd.DataFrame({"B19013_E001": [55000, -666666666], "B19013_M001": [2500, -222222222]}, index=["01001", "48301"])
    r = compute_acs_indicator(ACS_INDICATORS["acs_median_hh_income"], t)
    assert r.loc["01001", "value"] == 55000 and r.loc["01001", "missing_reason"] is None
    assert np.isnan(r.loc["48301", "value"]) and r.loc["48301", "missing_reason"] == "too_few_sample_cases"
    t = pd.DataFrame({"B17001_E001": [1000, 0], "B17001_E002": [150, 0], "B17001_M001": [80, 0], "B17001_M002": [40, 0]}, index=["a", "b"])
    r = compute_acs_indicator(ACS_INDICATORS["acs_pct_poverty"], t)
    assert r.loc["a", "value"] == pytest.approx(15.0)
    assert np.isnan(r.loc["b", "value"]) and r.loc["b", "missing_reason"] == "zero_denominator"


def test_scoring_weights_and_missing_components():
    w = S.normalize_weights({"coverage": 2, "distance_relief": 2})
    assert w.sum() == pytest.approx(1) and w[0] == pytest.approx(0.5) and w[2] == 0
    with pytest.raises(ValueError):
        S.normalize_weights({k: 0 for k in S.COMPONENTS})
    comp = np.array([[1, 1, 1, 1, 1.0], [1, 1, 1, 1, np.nan], [0, 0, 0, 0, 0.0]])
    sc = S.weighted_score(comp, S.normalize_weights(None))
    assert sc[0] == pytest.approx(1) and sc[1] == pytest.approx(1), "a missing component must not penalise"
    assert sc[2] == 0 and list(S.ranks(sc)) == [1, 2, 3]


def test_sensitivity_is_reproducible_and_bounded():
    rng = np.random.default_rng(0)
    comp = rng.uniform(size=(40, 5))
    w = S.normalize_weights(None)
    a, b = S.weight_monte_carlo(comp, w, n_draws=50), S.weight_monte_carlo(comp, w, n_draws=50)
    assert (a == b).all() and a.shape == (50, 40) and a.min() == 1 and a.max() == 40
    dominant = np.vstack([np.ones(5), comp * 0.5])     # a candidate that dominates on every component stays #1
    assert (S.weight_monte_carlo(dominant, w, n_draws=50)[:, 0] == 1).all()
    assert len(S.one_at_a_time(comp, w)) == 10
