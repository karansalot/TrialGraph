"""Export a static data snapshot for the serverless 'static edition' of the web app.

The static edition runs the access engine in the browser (frontend/lib/static/), so the site can be
hosted on any static host (Netlify, GitHub Pages) with no API or database. This exporter writes:

  meta/*.json            /api/meta, freshness, indicators, quality, brief text blocks
  geo/*.json             county and state display geometry
  engine/tracts.bin      Float32 [lat | lon | pop | countyIndex] for 84,414 tract centres
  engine/base_<cat>.bin  Float32 nearest-site miles per tract (Infinity = no site), one per filter
  engine/counties.json   county profile rows (order = countyIndex) + supply counts per filter
  overview/<cat>_<ST>.json   registry aggregates (status mix, sites, states, phases, sponsors)
  bycat/<ST>.json        recruiting studies / facilities per filter
  sites/<cat>.json       current analysis sites (map points, nearest-site lists)
  insights/<T>.json      insights at 25/50/75/100 miles
  trials/index.json      compact row per study (Trial Explorer)
  trials/d<NN>.json      study detail + site list, sharded by the NCT number's last two digits
  facility/f<NN>.json    facility record + its study links, sharded by facility_id % 100
  county/<ST>.json       every indicator value / MOE / CI per county

All numbers are produced by the same code paths as the live API.
"""
from __future__ import annotations

import json
import shutil
from collections import defaultdict
from pathlib import Path

import numpy as np
from fastapi.testclient import TestClient

from ..analysis.access import CATEGORIES
from ..analysis.engine import COMPARE_INDICATORS, get_model
from ..api import brief as B
from ..api.access import PROFILE_COLS
from ..api.main import app
from ..config import REPO_ROOT
from ..db import fetch_all

OUT = REPO_ROOT / "frontend" / "public" / "data"


def _w(path: Path, obj) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    s = json.dumps(obj, separators=(",", ":"), default=str)
    path.write_text(s)
    return len(s)


def export(out: Path = OUT) -> dict:
    if out.exists():
        shutil.rmtree(out)
    c = TestClient(app)
    m = get_model()
    sizes: dict[str, int] = defaultdict(int)

    def get(path, **params):
        r = c.get(path, params=params)
        r.raise_for_status()
        return r.json()

    # ---- meta
    meta = get("/api/meta")
    meta["routing_configured"] = False
    meta["static_edition"] = True
    sizes["meta"] += _w(out / "meta/meta.json", meta)
    sizes["meta"] += _w(out / "meta/freshness.json", get("/api/meta/freshness"))
    sizes["meta"] += _w(out / "meta/indicators.json", get("/api/meta/indicators"))
    sizes["meta"] += _w(out / "meta/quality.json", get("/api/meta/quality"))
    sizes["meta"] += _w(out / "meta/brief_text.json", {
        "limitations": B.LIMITATIONS, "methodology": [{"topic": a, "text": b} for a, b in B.METHODOLOGY],
        "disclaimer": __import__("trialgraph.api.simulator", fromlist=["HYPOTHETICAL"]).HYPOTHETICAL})
    for layer in ("counties", "states"):
        sizes["geo"] += _w(out / f"geo/{layer}.json", c.get(f"/api/geo/{layer}").json())

    # ---- engine arrays
    tr = m.tracts
    (out / "engine").mkdir(parents=True, exist_ok=True)
    arr = np.concatenate([tr.lat.to_numpy(np.float32), tr.lon.to_numpy(np.float32),
                          m.pop.astype(np.float32), m.tract_county.astype(np.float32)])
    (out / "engine/tracts.bin").write_bytes(arr.tobytes())
    sizes["engine"] += arr.nbytes
    for cat in CATEGORIES:
        b = m.baseline(cat).astype(np.float32)
        (out / f"engine/base_{cat}.bin").write_bytes(b.tobytes())
        sizes["engine"] += b.nbytes
    cols = ["fips", "name", "usps", "pop_2020", "rucc_2023", "is_metro", "centroid_lat", "centroid_lon",
            *dict.fromkeys(PROFILE_COLS + COMPARE_INDICATORS)]
    cp = m.counties[cols].astype(object).where(m.counties[cols].notna(), None)
    supply = defaultdict(lambda: np.zeros((m.n_c, 3), dtype=int))
    idx = {f: i for i, f in enumerate(m.counties.fips)}
    for r in fetch_all("SELECT * FROM county_supply"):
        supply[r["category"]][idx[r["fips"]]] = [r["recruiting_sites_in_county"], r["recruiting_studies_in_county"],
                                                 r["recruiting_studies_50mi"]]
    rucc = {r["rucc_2023"]: r["rucc_description"] for r in fetch_all(
        "SELECT DISTINCT rucc_2023, rucc_description FROM county WHERE rucc_2023 IS NOT NULL")}
    ind_defs = {r["indicator_id"]: {k: r[k] for k in ("label", "unit", "vintage", "direction")}
                for r in fetch_all("SELECT * FROM indicator")}
    sizes["engine"] += _w(out / "engine/counties.json", {
        "columns": cols, "rows": cp.values.tolist(), "rucc_description": rucc, "indicator_defs": ind_defs,
        "compare_indicators": COMPARE_INDICATORS, "profile_cols": PROFILE_COLS, "n_tracts": int(len(tr)),
        "supply": {cat: supply[cat].T.tolist() for cat in CATEGORIES}, "run_id": m.run_id})

    # ---- registry aggregates (threshold-independent parts of /api/overview)
    keep = ["status_counts", "recruiting_sites", "recruiting_interventional_studies_without_recruiting_us_site_in_snapshot",
            "by_state", "by_category", "recruiting_by_phase", "by_sponsor_class", "records_excluded_as_not_oncology"]
    states = [s["usps"] for s in meta["states"]]
    for cat in CATEGORIES:
        for st in [None, *states]:
            o = get("/api/overview", category=cat, **({"state": st} if st else {}))
            sizes["overview"] += _w(out / f"overview/{cat}_{st or 'US'}.json", {k: o[k] for k in keep})
    for st in [None, *states]:
        d = get("/api/access/by-category", **({"state": st} if st else {}))
        sizes["bycat"] += _w(out / f"bycat/{st or 'US'}.json",
                             {r["category"]: [r["recruiting_studies"], r["recruiting_facilities"]] for r in d["categories"]} | {"_note": d["note"]})
    site_cols = ["id", "name", "anon", "city", "usps", "conf", "lat", "lon", "n"]
    for cat in CATEGORIES:
        f = get("/api/facilities", category=cat)
        sizes["sites"] += _w(out / f"sites/{cat}.json", {"columns": site_cols, "rows": [[r[k] for k in site_cols] for r in f["facilities"]],
                                                         "note": f["note"]})
    for t in (25, 50, 75, 100):
        sizes["insights"] += _w(out / f"insights/{t}.json", get("/api/insights", threshold_mi=t))

    # ---- trials
    studies = fetch_all("""
        SELECT s.nct_id, s.brief_title, s.overall_status, s.status_group, s.study_type, s.phases, s.lead_sponsor, s.sponsor_class,
               s.conditions, s.cancer_categories, s.lenses, s.filter_keys, s.last_update_posted, s.enrollment_count, s.enrollment_type,
               s.oncology_basis, s.status_verified_date, s.start_date, s.primary_completion_date, s.mesh_terms, s.interventions, s.sex,
               s.min_age_years, s.max_age_years, s.std_ages, s.healthy_volunteers, s.source_url
        FROM study s ORDER BY s.last_update_posted DESC NULLS LAST, s.nct_id""")
    sites = fetch_all("""
        SELECT ss.nct_id, f.facility_id, ss.facility_raw AS name_on_record, f.name AS facility_name, f.is_placeholder_name, f.city, f.usps,
               f.zip5, ss.site_status, ss.is_recruiting_site, f.geocode_method, f.geocode_confidence,
               round(ST_Y(f.geom::geometry)::numeric, 4)::float AS lat, round(ST_X(f.geom::geometry)::numeric, 4)::float AS lon,
               c.name AS county_name, f.county_fips
        FROM study_site ss JOIN facility f USING (facility_id) LEFT JOIN county c ON c.fips = f.county_fips
        ORDER BY ss.nct_id, ss.is_recruiting_site DESC, f.usps, f.city, f.name""")
    by_study = defaultdict(list)
    for s in sites:
        by_study[s["nct_id"]].append(s)
    index_cols = ["nct_id", "brief_title", "status_group", "study_type", "phases", "lead_sponsor",
                  "conditions", "filter_keys", "last_update_posted", "oncology_basis", "n_us_sites", "n_recruiting_sites", "site_states"]
    # codes keep the shards small; the client decodes them with the lookup lists written alongside
    site_cols = ["facility_id", "name_on_record", "city", "usps", "site_status", "is_recruiting_site", "geocode_method",
                 "geocode_confidence", "lat", "lon", "county_index", "is_placeholder_name"]
    codes = {"site_status": sorted({x["site_status"] or "" for x in sites}),
             "geocode_method": sorted({x["geocode_method"] for x in sites}),
             "geocode_confidence": ["high", "medium", "low", "none"]}
    enc = {k: {v: i for i, v in enumerate(vals)} for k, vals in codes.items()}

    def site_row(x):
        rec = x["is_recruiting_site"]
        return [x["facility_id"], x["name_on_record"], x["city"], x["usps"], enc["site_status"][x["site_status"] or ""], int(rec),
                enc["geocode_method"][x["geocode_method"]], enc["geocode_confidence"][x["geocode_confidence"]],
                x["lat"] if rec else None, x["lon"] if rec else None, idx.get(x["county_fips"]), int(x["is_placeholder_name"])]
    rows, shards = [], defaultdict(dict)
    for s in studies:
        ss = by_study.get(s["nct_id"], [])
        rec = [x for x in ss if x["is_recruiting_site"]]
        # per-state site counts so the state filter can show state-scoped counts like the API does
        per_state: dict[str, list[int]] = {}
        for x in ss:
            v = per_state.setdefault(x["usps"], [0, 0])
            v[0] += 1
            v[1] += int(x["is_recruiting_site"])
        row = {**s, "conditions": (s["conditions"] or [])[:3], "phases": [p.replace("PHASE", "P").replace("EARLY_P1", "EP1") for p in s["phases"]],
               "filter_keys": [k for k in s["filter_keys"] if k != "all"], "n_us_sites": len(ss), "n_recruiting_sites": len(rec),
               "site_states": ",".join(f"{k}:{v[0]}:{v[1]}" for k, v in sorted(per_state.items()))}
        rows.append([row[k] for k in index_cols])
        shards[s["nct_id"][-3:]][s["nct_id"]] = {"study": {k: v for k, v in s.items() if k not in ("filter_keys", "source_url")},
                                                 "sites": [site_row(x) for x in ss]}
    sizes["trials"] += _w(out / "trials/index.json", {"columns": index_cols, "rows": rows})
    for k, v in shards.items():
        sizes["trials_detail"] += _w(out / f"trials/d{k}.json", v)
    _w(out / "trials/codes.json", {"site_columns": site_cols, **codes})

    # ---- facilities
    facs = fetch_all("""SELECT f.facility_id, f.name, f.is_placeholder_name, f.city, f.usps, f.zip5, f.geocode_method,
                               f.geocode_confidence, f.zip_city_gap_mi, f.county_fips, c.name AS county_name,
                               f.n_source_records, f.n_name_variants,
                               round(ST_Y(f.geom::geometry)::numeric, 4)::float AS lat, round(ST_X(f.geom::geometry)::numeric, 4)::float AS lon
                        FROM facility f LEFT JOIN county c ON c.fips = f.county_fips""")
    fac_cols = list(facs[0].keys())
    _w(out / "facility/columns.json", fac_cols)
    links = defaultdict(list)
    for s in sites:
        links[s["facility_id"]].append([s["nct_id"], enc["site_status"][s["site_status"] or ""], int(s["is_recruiting_site"])])
    fshards = defaultdict(dict)
    for f in facs:
        fshards[f["facility_id"] % 1000][f["facility_id"]] = [[f[k] for k in fac_cols], links.get(f["facility_id"], [])]
    for k, v in fshards.items():
        sizes["facility"] += _w(out / f"facility/f{k:03d}.json", v)

    # ---- county indicator detail
    ind = fetch_all("""SELECT ci.fips, c.usps, ci.indicator_id, ci.value, ci.moe, ci.ci_low, ci.ci_high, ci.missing_reason
                       FROM county_indicator ci JOIN county c USING (fips)""")
    by_state = defaultdict(lambda: defaultdict(dict))
    for r in ind:
        by_state[r["usps"]][r["fips"]][r["indicator_id"]] = [r["value"], r["moe"], r["ci_low"], r["ci_high"], r["missing_reason"]]
    for st, v in by_state.items():
        sizes["county"] += _w(out / f"county/{st}.json", v)

    total = sum(sizes.values())
    summary = {k: f"{v / 1e6:.1f} MB" for k, v in sizes.items()} | {"total": f"{total / 1e6:.1f} MB",
                                                                     "files": sum(1 for _ in out.rglob("*") if _.is_file())}
    _w(out / "manifest.json", {"run_id": m.run_id, "sizes_bytes": dict(sizes)})
    return summary
