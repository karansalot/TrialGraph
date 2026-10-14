"""ClinicalTrials.gov API v2 extraction.

Contract (verified against API v2.0.5):
  GET https://clinicaltrials.gov/api/v2/studies
    query.cond   Essie expression over condition fields (broad retrieval; refined in transform)
    query.locn   AREA[LocationCountry]United States
    filter.overallStatus  pipe-separated status list
    fields       explicit field list (keeps payloads small and the contract explicit)
    pageSize     <= 1000, pageToken for pagination
  GET https://clinicaltrials.gov/api/v2/version -> {"apiVersion", "dataTimestamp"}

Raw pages are stored verbatim (gzipped) so the transform is reproducible offline.
"""
from __future__ import annotations

import gzip
import json
from pathlib import Path

from ..config import get_settings
from .fetch import client, get_with_retry, record, sha256_of, utcnow

BASE = "https://clinicaltrials.gov/api/v2"

# Broad retrieval net. Precision is restored in transform (see classify.py: oncology_basis).
CONDITION_QUERY = (
    "cancer OR neoplasm OR tumor OR carcinoma OR leukemia OR lymphoma OR sarcoma OR melanoma "
    "OR myeloma OR glioma OR glioblastoma OR malignancy OR metastatic"
)

# Statuses ingested. SUSPENDED / TERMINATED / WITHDRAWN and expanded-access statuses are
# intentionally out of scope and documented as such.
STATUSES = [
    "RECRUITING",
    "NOT_YET_RECRUITING",
    "ENROLLING_BY_INVITATION",
    "ACTIVE_NOT_RECRUITING",
    "COMPLETED",
    "UNKNOWN",
]

FIELDS = [
    "NCTId", "BriefTitle", "OverallStatus", "StatusVerifiedDate", "LastUpdatePostDate",
    "StartDate", "PrimaryCompletionDate", "StudyType", "Phase", "EnrollmentCount", "EnrollmentType",
    "LeadSponsorName", "LeadSponsorClass", "Condition", "Keyword",
    "ConditionMeshTerm", "ConditionAncestorTerm",
    "InterventionType", "InterventionName",
    "Sex", "MinimumAge", "MaximumAge", "StdAge", "HealthyVolunteers",
    "LocationFacility", "LocationCity", "LocationState", "LocationZip", "LocationCountry",
    "LocationStatus", "LocationGeoPoint",
]


def extract(refresh: bool = False, page_size: int = 1000, max_pages: int | None = None) -> Path:
    """Download all matching studies into data/raw/ctgov/pages/*.json.gz."""
    s = get_settings()
    out = s.raw_dir / "ctgov" / "pages"
    done_marker = out.parent / "COMPLETE"
    if done_marker.exists() and not refresh:
        return out
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("*.json.gz"):
        old.unlink()
    done_marker.unlink(missing_ok=True)

    with client() as c:
        version = get_with_retry(c, f"{BASE}/version").json()
        params = {
            "query.cond": CONDITION_QUERY,
            "query.locn": "AREA[LocationCountry]United States",
            "filter.overallStatus": "|".join(STATUSES),
            "fields": ",".join(FIELDS),
            "pageSize": page_size,
            "countTotal": "true",
        }
        started = utcnow()
        token, page, n, total = None, 0, 0, None
        while True:
            p = dict(params)
            if token:
                p["pageToken"] = token
                p.pop("countTotal")
            data = get_with_retry(c, f"{BASE}/studies", p).json()
            total = data.get("totalCount", total)
            page += 1
            n += len(data.get("studies", []))
            with gzip.open(out / f"page_{page:04d}.json.gz", "wt", encoding="utf-8") as f:
                json.dump(data["studies"], f)
            print(f"  ctgov page {page}: {n}/{total}", flush=True)
            token = data.get("nextPageToken")
            if not token or (max_pages and page >= max_pages):
                break

    record(
        "ctgov_studies",
        url=f"{BASE}/studies",
        path="raw/ctgov/pages",
        retrieved_at=started,
        finished_at=utcnow(),
        api_version=version.get("apiVersion"),
        source_data_timestamp=version.get("dataTimestamp"),
        params={k: v for k, v in params.items() if k != "countTotal"},
        upstream_total_count=total,
        row_count=n,
        truncated=bool(max_pages and token),
        upstream_sha256=sha256_of(out.glob("*.json.gz")),
    )
    done_marker.write_text(started)
    return out


def iter_raw_studies(pages_dir: Path | None = None):
    pages_dir = pages_dir or get_settings().raw_dir / "ctgov" / "pages"
    for p in sorted(pages_dir.glob("*.json.gz")):
        with gzip.open(p, "rt", encoding="utf-8") as f:
            yield from json.load(f)
