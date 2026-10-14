"""Explainable weighted opportunity score and its sensitivity analysis.

score = sum_k w_k * c_k / sum_k w_k      with every component c_k in [0, 1]

Components (all computed for the population that would become *newly within the distance
threshold* if a hypothetical site were placed at the candidate location):

  coverage        newly covered residents, relative to the best candidate in scope
  distance_relief average straight-line miles saved per newly covered resident, capped at 100 mi
  equity          mean national percentile (0-1) of poverty, uninsured and no-vehicle rates,
                  population-weighted over the newly covered residents' counties
  rurality        share of newly covered residents living in non-metro counties (RUCC 4-9)
  health_context  population-weighted national percentile of age-adjusted adult cancer prevalence
                  (CDC PLACES). Context only - prevalence is not trial demand. Missing where
                  PLACES has no estimate; the weight is then redistributed for that candidate.

Nothing in the score describes site feasibility (investigators, staff, capacity, sponsor
interest). It ranks *geographic need*, not where a trial should be opened.
"""
from __future__ import annotations

import numpy as np

COMPONENTS = ["coverage", "distance_relief", "equity", "rurality", "health_context"]
DEFAULT_WEIGHTS = {"coverage": 0.40, "distance_relief": 0.20, "equity": 0.20, "rurality": 0.10, "health_context": 0.10}
COMPONENT_LABELS = {
    "coverage": "Population newly within threshold",
    "distance_relief": "Miles saved per newly covered resident",
    "equity": "Socioeconomic barrier index of newly covered residents",
    "rurality": "Non-metro share of newly covered residents",
    "health_context": "Cancer prevalence context (CDC PLACES)",
}
DISTANCE_RELIEF_CAP_MI = 100.0


def normalize_weights(weights: dict[str, float] | None) -> np.ndarray:
    w = np.array([max(0.0, float((weights or DEFAULT_WEIGHTS).get(k, 0.0))) for k in COMPONENTS])
    if w.sum() <= 0:
        raise ValueError("at least one weight must be positive")
    return w / w.sum()


def weighted_score(components: np.ndarray, weights: np.ndarray) -> np.ndarray:
    """components: (n, k) in [0,1] with NaN = not available. NaN components are skipped and the
    remaining weights re-normalised per row, so missing data neither rewards nor penalises."""
    avail = ~np.isnan(components)
    w = np.where(avail, weights, 0.0)
    denom = w.sum(axis=1)
    num = (np.nan_to_num(components) * w).sum(axis=1)
    return np.divide(num, denom, out=np.zeros(len(components)), where=denom > 0)


def ranks(scores: np.ndarray) -> np.ndarray:
    """1 = best. Ties broken by original order (stable)."""
    order = np.argsort(-scores, kind="stable")
    r = np.empty(len(scores), dtype=int)
    r[order] = np.arange(1, len(scores) + 1)
    return r


def weight_monte_carlo(components: np.ndarray, weights: np.ndarray, n_draws: int = 500, concentration: float = 20.0,
                       seed: int = 20260101) -> np.ndarray:
    """Rank of every candidate under `n_draws` random weight vectors ~ Dirichlet(concentration * w).

    Returns an (n_draws, n_candidates) integer array. Seeded => reproducible.
    """
    rng = np.random.default_rng(seed)
    alpha = np.maximum(weights * concentration, 1e-3)
    draws = rng.dirichlet(alpha, size=n_draws)
    return np.vstack([ranks(weighted_score(components, d)) for d in draws])


def one_at_a_time(components: np.ndarray, weights: np.ndarray, factors=(0.5, 1.5)) -> list[dict]:
    """Scale one weight at a time by each factor (others re-normalised) and report the ranks."""
    out = []
    for k, name in enumerate(COMPONENTS):
        for f in factors:
            w = weights.copy()
            w[k] *= f
            if w.sum() <= 0:
                continue
            w = w / w.sum()
            out.append({"component": name, "factor": f, "weights": w, "ranks": ranks(weighted_score(components, w))})
    return out
