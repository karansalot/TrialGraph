from __future__ import annotations

import json
from typing import Optional

import pandas as pd
from fastapi import HTTPException, Query

from ..analysis.access import CATEGORIES
from ..analysis.engine import Scope
from ..pipeline.reference import USPS_TO_FIPS

# What "recruiting site" means everywhere in the API. Returned by /api/meta so the UI can show it.
ANALYSIS_SITE_DEFINITION = (
    "A site counts toward access only if (1) the study is oncology-related, (2) the study is interventional, "
    "(3) ClinicalTrials.gov lists the study's overall status as RECRUITING and that site's own status as RECRUITING, "
    "and (4) the site could be geocoded."
)
ANALYSIS_SITE_WHERE = ("ss.is_recruiting_site AND s.study_type = 'INTERVENTIONAL' "
                       "AND s.oncology_basis <> 'not_oncology' AND f.geom IS NOT NULL")
DISTANCE_LABEL = "Straight-line (great-circle) distance in miles - not driving distance or travel time"


def records(df: pd.DataFrame) -> list[dict]:
    """DataFrame -> JSON-safe records (NaN -> null, numpy scalars -> python)."""
    return json.loads(df.to_json(orient="records"))


def category_q(category: str = Query("all", description="Cancer category id, see /api/meta")) -> str:
    if category not in CATEGORIES:
        raise HTTPException(422, f"unknown category '{category}'")
    return category


def state_q(state: Optional[str] = Query(None, description="USPS state code filter, e.g. NC")) -> Optional[str]:
    if state in (None, "", "US"):
        return None
    state = state.upper()
    if state not in USPS_TO_FIPS:
        raise HTTPException(422, f"unknown state '{state}'")
    return state


def threshold_q(threshold_mi: float = Query(50, ge=5, le=250, description="Distance threshold in straight-line miles")) -> float:
    return float(threshold_mi)


def scope_of(state: Optional[str]) -> Scope:
    return Scope(state)
