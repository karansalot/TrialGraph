import pytest

pytestmark = pytest.mark.db
SITE = {"lat": 32.69, "lon": -114.63, "label": "test"}  # Yuma, AZ area


def test_meta_and_dictionary(client):
    m = client.get("/api/meta").json()
    assert m["categories"][0]["id"] == "all" and len(m["statuses"]) == 6
    assert "not driving" in m["distance_label"]
    d = client.get("/api/meta/indicators").json()
    assert len(d) >= 20 and all(i["definition"] and i["source_url"] for i in d)
    assert client.get("/api/meta/freshness").json()["sources"]


def test_overview_distinguishes_statuses(client):
    o = client.get("/api/overview").json()
    by = {s["status_group"]: s["studies"] for s in o["status_counts"]}
    assert by["recruiting"] > 0 and by["completed"] > by["recruiting"]
    assert o["recruiting_sites"]["recruiting_studies_with_recruiting_site"] <= by["recruiting"]
    c = o["coverage"]
    assert c["population_within"] + c["population_beyond"] == c["population"]
    assert sum(b["population"] for b in o["distance_bands"]) == c["population"]


def test_threshold_monotonic(client):
    p = [client.get("/api/overview", params={"threshold_mi": t}).json()["coverage"]["pct_within"] for t in (25, 50, 100)]
    assert p[0] <= p[1] <= p[2] <= 100


def test_category_is_never_better_covered_than_all(client):
    a = client.get("/api/overview").json()["coverage"]["pct_within"]
    b = client.get("/api/overview", params={"category": "sarcoma"}).json()["coverage"]["pct_within"]
    assert b <= a


def test_state_filter_and_validation(client):
    r = client.get("/api/access/counties", params={"state": "MT"}).json()
    assert r["n_counties"] == 56 and {c["usps"] for c in r["counties"]} == {"MT"}
    assert client.get("/api/access/counties", params={"state": "ZZ"}).status_code == 422
    assert client.get("/api/overview", params={"category": "nope"}).status_code == 422
    assert client.get("/api/overview", params={"threshold_mi": 1}).status_code == 422


def test_trials_search_and_detail(client):
    r = client.get("/api/trials", params={"status": "recruiting", "category": "breast", "page_size": 5}).json()
    assert r["total"] > 0 and len(r["trials"]) == 5
    for t in r["trials"]:
        assert t["status_group"] == "recruiting" and "breast" in t["cancer_categories"]
        assert t["source_url"] == f"https://clinicaltrials.gov/study/{t['nct_id']}"
    done = client.get("/api/trials", params={"status": "completed", "page_size": 20}).json()["trials"]
    assert all(t["n_recruiting_sites"] == 0 for t in done), "completed studies must never show recruiting sites"
    nct = r["trials"][0]["nct_id"]
    d = client.get(f"/api/trials/{nct}").json()
    assert d["study"]["nct_id"] == nct and d["site_summary"]["us_sites"] == len(d["sites"])
    assert client.get(f"/api/trials?q={nct}").json()["total"] >= 1
    assert client.get("/api/trials/NCT00000000").status_code == 404


def test_county_detail(client):
    first = client.get("/api/access/counties").json()["counties"][0]
    d = client.get(f"/api/access/county/{first['fips']}").json()
    assert d["county"]["name"] == first["name"]
    miles = [s["miles"] for s in d["nearest_recruiting_sites"]]
    assert miles == sorted(miles)
    assert d["travel_time"]["configured"] is False
    assert any(i["moe"] is not None for i in d["indicators"])
    assert client.get("/api/access/county/99999").status_code == 404


def test_simulation_can_only_improve_access(client):
    body = {"category": "all", "threshold_mi": 50, "sites": [SITE]}
    r = client.post("/api/simulator/simulate", json=body).json()
    assert r["after"]["population_within"] >= r["before"]["population_within"]
    assert r["after"]["pop_weighted_mean_mi"] <= r["before"]["pop_weighted_mean_mi"]
    assert r["delta"]["population_newly_within"] == r["after"]["population_within"] - r["before"]["population_within"]
    assert "ypothetical" in r["disclaimer"]
    two = client.post("/api/simulator/simulate", json={**body, "sites": [SITE, {"lat": 44.6, "lon": -75.2}]}).json()
    assert two["delta"]["population_newly_within"] >= r["delta"]["population_newly_within"]
    assert client.post("/api/simulator/simulate", json={**body, "sites": []}).status_code == 422


def test_candidate_ranking_matches_simulation(client):
    """The ranked coverage gain for a candidate equals what the simulator reports for a site at that point."""
    body = {"category": "all", "threshold_mi": 50, "limit": 5}
    r = client.post("/api/simulator/candidates", json=body).json()
    c = r["candidates"]
    assert [x["rank"] for x in c] == [1, 2, 3, 4, 5]
    assert [x["score"] for x in c] == sorted((x["score"] for x in c), reverse=True)
    assert abs(sum(r["weights"].values()) - 1) < 1e-6
    top = c[0]
    sim = client.post("/api/simulator/simulate", json={"category": "all", "threshold_mi": 50, "sites": [{"lat": top["lat"], "lon": top["lon"]}]}).json()
    assert sim["delta"]["population_newly_within"] == top["pop_newly_within"]


def test_weights_change_ranking_and_sensitivity(client):
    base = {"category": "all", "threshold_mi": 50, "limit": 50}
    a = client.post("/api/simulator/candidates", json=base).json()["candidates"]
    b = client.post("/api/simulator/candidates", json={**base, "weights": {"rurality": 1}}).json()["candidates"]
    assert [x["fips"] for x in a] != [x["fips"] for x in b]
    assert all(x["rural_share"] == 1 for x in b[:5])
    assert client.post("/api/simulator/candidates", json={**base, "weights": {"coverage": 0}}).status_code == 422
    s = client.post("/api/simulator/sensitivity", json={"category": "all", "threshold_mi": 50}).json()
    assert len(s["weight_monte_carlo"]) == 10 and all(0 <= r["share_top_n"] <= 1 for r in s["weight_monte_carlo"])
    assert next(t for t in s["threshold"] if t["threshold_mi"] == 50)["top_n_overlap"] == 10


def test_brief_and_exports(client):
    b = client.get("/api/brief", params={"state": "MT"}).json()
    assert len(b["key_findings"]) >= 3 and all(f["trace"] for f in b["key_findings"])
    assert len(b["limitations"]) >= 8 and b["sources"]
    md = client.get("/api/brief.md").text
    assert md.startswith("# ") and "## Limitations" in md and "straight-line" in md
    csv = client.post("/api/simulator/candidates.csv", json={"category": "all", "threshold_mi": 50}).text
    assert csv.startswith("# TrialGraph hypothetical") and "pop_newly_within" in csv


def test_greedy_plan_is_consistent_with_simulation(client):
    """A plan's cumulative gain must equal simulating all of its sites together, and step 1 is the top candidate."""
    p = client.post("/api/simulator/plan", json={"category": "all", "threshold_mi": 50, "k": 4}).json()
    steps = p["steps"]
    assert [s["step"] for s in steps] == list(range(1, len(steps) + 1)) and len({s["fips"] for s in steps}) == len(steps)
    top = client.post("/api/simulator/candidates", json={"category": "all", "threshold_mi": 50, "limit": 1}).json()["candidates"][0]
    assert steps[0]["fips"] == top["fips"] and steps[0]["marginal_pop_newly_within"] == top["pop_newly_within"]
    running = 0
    for s in steps:
        running += s["marginal_pop_newly_within"]
        assert s["cumulative_pop_newly_within"] == running
    sim = client.post("/api/simulator/simulate", json={"category": "all", "threshold_mi": 50,
                                                       "sites": [{"lat": s["lat"], "lon": s["lon"]} for s in steps]}).json()
    assert sim["delta"]["population_newly_within"] == steps[-1]["cumulative_pop_newly_within"]
    assert client.post("/api/simulator/plan", json={"k": 99}).status_code == 422


def test_greedy_plan_beats_naive_top_k(client):
    """Greedy never covers fewer residents than taking the top-k independent candidates (pure coverage weights)."""
    w = {"coverage": 1}
    k = 5
    plan = client.post("/api/simulator/plan", json={"weights": w, "k": k}).json()["steps"]
    naive = client.post("/api/simulator/candidates", json={"weights": w, "limit": k}).json()["candidates"]
    sim = client.post("/api/simulator/simulate", json={"sites": [{"lat": c["lat"], "lon": c["lon"]} for c in naive]}).json()
    assert plan[-1]["cumulative_pop_newly_within"] >= sim["delta"]["population_newly_within"]


def test_category_coverage_and_exports(client):
    r = client.get("/api/access/by-category").json()["categories"]
    assert r[0]["category"] == "all" and len(r) == 20 and {c["group"] for c in r} == {"cancer", "lens"}
    assert all(c["pct_within"] is None or c["pct_within"] <= r[0]["pct_within"] for c in r[1:])
    ov = client.get("/api/overview").json()
    assert r[0]["pct_within"] == ov["coverage"]["pct_within"]
    assert sum(s["studies"] for s in ov["by_sponsor_class"]) == ov["recruiting_sites"]["recruiting_studies_with_recruiting_site"]
    csv = client.get("/api/access/counties.csv", params={"state": "MT"}).text
    lines = [ln for ln in csv.splitlines() if not ln.startswith("#")]
    assert "straight-line" in csv and lines[0].startswith("fips,name,usps") and len(lines) == 57


def test_facility_profile(client):
    fid = client.get("/api/facilities").json()["facilities"][0]["id"]
    d = client.get(f"/api/facilities/{fid}").json()
    assert d["facility"]["facility_id"] == fid and any(s["is_recruiting_site"] for s in d["studies"])
    assert client.get("/api/facilities/999999999").status_code == 404


def test_lenses_exposed_everywhere(client):
    meta = client.get("/api/meta").json()
    lenses = [c["id"] for c in meta["categories"] if c["group"] == "lens"]
    assert {"lens_phase1", "lens_age75", "lens_verified"} <= set(lenses)
    all_cov = client.get("/api/overview").json()["coverage"]["pct_within"]
    p1 = client.get("/api/overview", params={"category": "lens_phase1"}).json()["coverage"]["pct_within"]
    assert p1 <= all_cov
    t = client.get("/api/trials", params={"category": "lens_phase1", "status": "recruiting", "page_size": 10}).json()["trials"]
    assert t and all(set(x["phases"]) & {"PHASE1", "EARLY_PHASE1"} for x in t)
    assert client.post("/api/simulator/candidates", json={"category": "lens_phase1", "limit": 3}).status_code == 200


def test_insights_are_computed_and_traceable(client):
    d = client.get("/api/insights").json()
    ids = [i["id"] for i in d["insights"]]
    assert ids[0] == "early_phase" and len(ids) == 8 and len(set(ids)) == 8
    for i in d["insights"]:
        assert i["title"] and i["headline"] and i["text"] and i["link"].startswith("/") and i["evidence"]
    by = {i["id"]: i for i in d["insights"]}
    ov = client.get("/api/overview", params={"category": "lens_phase1"}).json()["coverage"]
    assert by["early_phase"]["evidence"]["pct_within_phase1"] == ov["pct_within"]
    curve = by["diminishing_returns"]["chart"]
    assert curve[0]["value"] == 0 and all(a["value"] <= b["value"] for a, b in zip(curve, curve[1:]))
    gains = [s["marginal_pop_newly_within"] for s in by["diminishing_returns"]["evidence"]["steps"]]
    assert gains == sorted(gains, reverse=True), "greedy coverage gains are non-increasing"
    assert client.get("/api/insights", params={"threshold_mi": 100}).json()["threshold_mi"] == 100
