"""CDC PLACES: Local Data for Better Health - county release.

Source: Socrata dataset on data.cdc.gov (county data, GIS-friendly long format).
PLACES values are *model-based small-area estimates* derived from BRFSS survey responses;
they are not counts of diagnosed patients and are not measures of clinical-trial demand.
"""
from __future__ import annotations

import json
from pathlib import Path

from ..config import get_settings
from .fetch import client, get_with_retry, read_manifest, record, utcnow

DATASET_ID = "swc5-untb"  # "PLACES: Local Data for Better Health, County Data, 2025 release"
BASE = "https://data.cdc.gov"

# Measures ingested, with the reason each is relevant to access planning.
MEASURES = {
    "CANCER": "Cancer (non-skin) or melanoma among adults - lifetime diagnosis prevalence (context only)",
    "CSMOKING": "Current cigarette smoking among adults - cancer risk-factor context",
    "MAMMOUSE": "Mammography use among women aged 50-74 - screening engagement",
    "COLON_SCREEN": "Colorectal cancer screening among adults aged 45-75 - screening engagement",
    "ACCESS2": "No health insurance among adults aged 18-64 - access barrier",
    "CHECKUP": "Routine checkup within the past year among adults - connection to care",
    "LACKTRPT": "Lack of reliable transportation in the past 12 months among adults - access barrier",
    "GHLTH": "Fair or poor self-rated health among adults - general health context",
}


def extract(refresh: bool = False) -> Path:
    s = get_settings()
    dest = s.raw_dir / "places" / f"places_county_{DATASET_ID}.json"
    if dest.exists() and not refresh and "cdc_places_county" in read_manifest():
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    rows: list[dict] = []
    with client() as c:
        meta = get_with_retry(c, f"{BASE}/api/views/{DATASET_ID}.json").json()
        where = "measureid in (" + ",".join(f"'{m}'" for m in MEASURES) + ")"
        offset, page = 0, 50000
        started = utcnow()
        while True:
            batch = get_with_retry(
                c,
                f"{BASE}/resource/{DATASET_ID}.json",
                {"$where": where, "$order": ":id", "$limit": page, "$offset": offset,
                 "$select": "year,stateabbr,locationname,locationid,datasource,category,measureid,measure,"
                            "short_question_text,data_value_unit,data_value_type,datavaluetypeid,data_value,"
                            "low_confidence_limit,high_confidence_limit,totalpopulation,totalpop18plus,"
                            "data_value_footnote"},
            ).json()
            rows.extend(batch)
            print(f"  places rows: {len(rows)}", flush=True)
            if len(batch) < page:
                break
            offset += page
    dest.write_text(json.dumps(rows))
    record(
        "cdc_places_county",
        url=f"{BASE}/resource/{DATASET_ID}.json",
        path=str(dest.relative_to(s.data_dir)),
        retrieved_at=started,
        dataset_name=meta.get("name"),
        vintage=meta.get("name", "").split(",")[-1].strip(),
        source_rows_updated_at=meta.get("rowsUpdatedAt"),
        params={"$where": where},
        row_count=len(rows),
    )
    return dest
