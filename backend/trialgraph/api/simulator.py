"""Site Strategy Simulator endpoints. Every site here is HYPOTHETICAL."""
from __future__ import annotations

import io
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..analysis import scoring as S
from ..analysis.access import CATEGORIES
from ..analysis.engine import get_model
from ..pipeline.reference import USPS_TO_FIPS
from .common import DISTANCE_LABEL, records, scope_of

router = APIRouter(prefix="/api/simulator", tags=["simulator"])
HYPOTHETICAL = ("Hypothetical scenario. Candidate sites are not real or planned facilities, and a high score is a measure of "
                "geographic need under the stated assumptions - not a recommendation that any institution open a site.")


class Params(BaseModel):
    category: str = "all"
    threshold_mi: float = Field(50, ge=5, le=250)
    state: Optional[str] = None

    def check(self):
        if self.category not in CATEGORIES:
            raise HTTPException(422, f"unknown category '{self.category}'")
        st = (self.state or "").upper() or None
        if st in ("US",):
            st = None
        if st and st not in USPS_TO_FIPS:
            raise HTTPException(422, f"unknown state '{self.state}'")
        return scope_of(st)


class Site(BaseModel):
    lat: float = Field(ge=17, le=72)
    lon: float = Field(ge=-180, le=-64)
    label: Optional[str] = None


class SimulateRequest(Params):
    sites: list[Site] = Field(min_length=1, max_length=10)


class RankRequest(Params):
    weights: Optional[dict[str, float]] = None
    min_gain_pop: int = Field(5000, ge=0)
    limit: int = Field(25, ge=1, le=500)


class PlanRequest(Params):
    weights: Optional[dict[str, float]] = None
    min_gain_pop: int = Field(5000, ge=0)
    k: int = Field(3, ge=1, le=8)


class SensitivityRequest(RankRequest):
    top_n: int = Field(10, ge=3, le=25)


@router.post("/simulate")
def simulate(req: SimulateRequest):
    scope = req.check()
    m = get_model()
    r = m.simulate(req.category, req.threshold_mi, [(s.lat, s.lon) for s in req.sites], scope)
    b, a = r["before"], r["after"]
    delta = {
        "population_newly_within": a["population_within"] - b["population_within"],
        "pct_within_change": round(a["pct_within"] - b["pct_within"], 3) if a["pct_within"] is not None else None,
        "pop_weighted_mean_mi_change": (round(a["pop_weighted_mean_mi"] - b["pop_weighted_mean_mi"], 2)
                                        if a["pop_weighted_mean_mi"] is not None and b["pop_weighted_mean_mi"] is not None else None),
    }
    groups = [{"group": gb["group"], "population": gb["population"], "pct_within_before": gb["pct_within"],
               "pct_within_after": ga["pct_within"], "population_newly_within": ga["population_within"] - gb["population_within"],
               "mean_mi_before": gb["pop_weighted_mean_mi"], "mean_mi_after": ga["pop_weighted_mean_mi"]}
              for gb, ga in zip(r["groups_before"], r["groups_after"])]
    return {"params": req.model_dump(), "before": b, "after": a, "delta": delta, "equity_groups": groups,
            "n_affected_counties": r["n_affected_counties"], "affected_counties": records(r["affected_counties"].head(60)),
            "assumptions": [
                "The hypothetical site is assumed to recruit for the selected cancer category.",
                "A resident is 'covered' when their census tract's centre of population is within the threshold, in straight-line miles.",
                "No capacity, eligibility, referral-pattern or travel-time effects are modelled.",
                "Equity groups are defined by county-level characteristics (ecological), not individuals.",
            ],
            "disclaimer": HYPOTHETICAL, "distance_label": DISTANCE_LABEL}


def _rank(req: RankRequest):
    scope = req.check()
    try:
        df, comp, w = get_model().rank_candidates(req.category, req.threshold_mi, req.weights, scope, req.min_gain_pop)
    except ValueError as e:
        raise HTTPException(422, str(e))
    return df, w


@router.post("/candidates")
def candidates(req: RankRequest):
    df, w = _rank(req)
    return {"params": req.model_dump(), "weights": {k: round(float(v), 4) for k, v in zip(S.COMPONENTS, w)},
            "component_labels": S.COMPONENT_LABELS, "n_candidates": len(df), "candidates": records(df.head(req.limit)),
            "method": {
                "candidate_definition": "One hypothetical site at the population-weighted centre of each county in scope.",
                "score": "100 x weighted average of the components below; weights are normalised to sum to 1.",
                "components": {
                    "coverage": "pop_newly_within / max(pop_newly_within) across candidates in scope",
                    "distance_relief": f"min(miles_saved_per_person / {S.DISTANCE_RELIEF_CAP_MI:g}, 1)",
                    "equity": "population-weighted mean national percentile of poverty, uninsured and no-vehicle rates (ACS) for newly covered residents' counties",
                    "rurality": "share of newly covered residents in non-metro counties (USDA RUCC 4-9)",
                    "health_context": "population-weighted national percentile of age-adjusted cancer prevalence (CDC PLACES); skipped where not published",
                },
                "min_gain_pop": "Candidates that would bring fewer than this many residents within the threshold are not ranked.",
                "independence": "Candidates are scored one at a time against today's baseline; scores are not additive across candidates.",
            },
            "disclaimer": HYPOTHETICAL, "distance_label": DISTANCE_LABEL}


@router.post("/candidates.csv")
def candidates_csv(req: RankRequest):
    df, w = _rank(req)
    buf = io.StringIO()
    buf.write(f"# TrialGraph hypothetical site-opportunity ranking. category={req.category}; threshold_mi={req.threshold_mi}; "
              f"scope={req.state or 'US'}; weights={dict(zip(S.COMPONENTS, [round(float(x), 4) for x in w]))}\n")
    buf.write("# Straight-line distance. Hypothetical candidates only - not institutional recommendations.\n")
    df.head(req.limit).to_csv(buf, index=False)
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": "attachment; filename=trialgraph_candidates.csv"})


@router.post("/plan")
def plan(req: PlanRequest):
    """Greedy k-site plan: each step re-scores candidates after the previously chosen hypothetical sites."""
    scope = req.check()
    try:
        out = get_model().greedy_plan(req.category, req.threshold_mi, req.weights, scope, req.k, req.min_gain_pop)
    except ValueError as e:
        raise HTTPException(422, str(e))
    return {"params": req.model_dump(), **out,
            "method": "Greedy sequential selection: at each step every county is re-scored against today's baseline plus the "
                      "hypothetical sites already chosen, and the top-scoring one is added. This avoids choosing overlapping "
                      "candidates, but it is a heuristic and is not guaranteed to be the best possible set.",
            "disclaimer": HYPOTHETICAL, "distance_label": DISTANCE_LABEL}


@router.post("/sensitivity")
def sensitivity(req: SensitivityRequest):
    scope = req.check()
    try:
        out = get_model().sensitivity(req.category, req.threshold_mi, req.weights, scope, req.min_gain_pop, req.top_n)
    except ValueError as e:
        raise HTTPException(422, str(e))
    return {"params": req.model_dump(), **out,
            "how_to_read": {
                "weight_monte_carlo": "Each candidate's rank across random weight sets drawn around the chosen weights "
                                      "(Dirichlet, seeded). share_top_n = fraction of draws in which it stays in the top N.",
                "one_at_a_time": "One weight halved or increased by 50% (others re-normalised); top_n_overlap = how many of the baseline top N remain.",
                "threshold": "Ranking recomputed at other distance thresholds; overlap with the baseline top N.",
            },
            "disclaimer": HYPOTHETICAL}
