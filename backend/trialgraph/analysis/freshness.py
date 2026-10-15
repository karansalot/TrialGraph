"""Data freshness: how old is each source snapshot, and is it past its expected refresh window?"""
from __future__ import annotations

import time
from datetime import datetime, timezone

from ..config import get_settings
from ..db import fetch_all, fetch_one

# Expected refresh cadence per source family (days before a snapshot is flagged stale).
CADENCE = {"ctgov_studies": None, "cdc_places_county": 400, "acs5_": 400, "census_": 1200, "usda_": 1200}


_live_cache: dict[str, tuple[float, dict]] = {}


def _stale_after(key: str) -> int:
    if key == "ctgov_studies":
        return get_settings().ctgov_stale_after_days
    return next(v for k, v in CADENCE.items() if v and key.startswith(k))


def freshness_report(live: bool = False) -> dict:
    now = datetime.now(timezone.utc)
    rows = fetch_all("SELECT * FROM source_dataset ORDER BY source_key")
    out = []
    for r in rows:
        age = (now - r["retrieved_at"]).total_seconds() / 86400
        limit = _stale_after(r["source_key"])
        out.append({
            "source_key": r["source_key"], "source_name": r["source_name"], "publisher": r["publisher"],
            "url": r["url"], "vintage": r["vintage"], "geographic_grain": r["geographic_grain"],
            "license": r["license"], "retrieved_at": r["retrieved_at"], "source_updated_at": r["source_updated_at"],
            "age_days": round(age, 1), "stale_after_days": limit, "status": "stale" if age > limit else "fresh",
            "row_count": r["row_count"], "upstream_sha256": r["upstream_sha256"], "notes": r["notes"],
        })
    run = fetch_one("SELECT run_id, started_at, finished_at, scope FROM pipeline_run ORDER BY run_id DESC LIMIT 1")
    rep = {"generated_at": now, "pipeline_run": run, "sources": out,
           "overall_status": "stale" if any(s["status"] == "stale" for s in out) else "fresh"}
    if live:  # optional upstream probe: has ClinicalTrials.gov published newer data than our snapshot?
        from ..sources.ctgov import BASE
        from ..sources.fetch import client
        hit = _live_cache.get("probe")
        if hit and time.monotonic() - hit[0] < 600:   # at most one outbound request per 10 minutes, however many visitors ask
            rep["ctgov_live"] = hit[1]
            return rep
        try:
            with client() as c:
                v = c.get(f"{BASE}/version", timeout=10).json()
            ours = next(s for s in out if s["source_key"] == "ctgov_studies")["source_updated_at"]
            rep["ctgov_live"] = {"upstream_data_timestamp": v.get("dataTimestamp"), "snapshot_data_timestamp": ours,
                                 "newer_data_available": bool(ours) and v.get("dataTimestamp", "") > ours.strftime("%Y-%m-%dT%H:%M:%S")}
        except Exception as e:  # network failure must not break the report
            rep["ctgov_live"] = {"error": "upstream check unavailable"}
            _ = e
        _live_cache["probe"] = (time.monotonic(), rep["ctgov_live"])
    return rep
