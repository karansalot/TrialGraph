# Three-minute product demo

Recorded walkthrough: [`docs/demo/trialgraph-demo.webm`](demo/trialgraph-demo.webm) (about 3 min 15 s, captions burned in), with one still per scene in `docs/demo/scene-NN.png`. Regenerate with `make demo` while the API and web app are running. The recording is produced by `frontend/e2e/demo.mjs`, so it always shows the real application on real data; the numbers in the captions are from the 2026-10-09 registry release.

| # | Screen | Caption |
|---|---|---|
| 1 | National Overview | TrialGraph: where are oncology trials actually recruiting, and who lives far from them? Built entirely on public data. |
| 2 | National Overview | Of ~40,000 registered U.S. oncology studies in the snapshot, only about one in six is recruiting now. Only those count. |
| 3 | National Overview | Each dot is a site whose own status is RECRUITING. Every tile names its source; distances are straight-line, never 'driving'. |
| 4 | National Overview | Coverage is computed from 84,414 census-tract centres of population: metro vs non-metro, and by county poverty or insurance. |
| 5 | Insights | Insights are computed fresh from the data, with evidence and a link to check each one. |
| 6 | Insights | Early-phase trials: 40 million people live over 50 miles from a recruiting Phase 1 site - 33 million more than for any trial. |
| 7 | Insights | 263 counties are both access gaps and in the top quartile for poverty or uninsurance - 4.6 million people. |
| 8 | Insights | Even ten well-placed hypothetical sites close only about a quarter of the gap: a case for decentralised trial models. |
| 9 | Overview: lens filter | Filters include cancer types and trial-type lenses - here, early-phase trials only. Everything recomputes; the URL is shareable. |
| 10 | Access Gap Explorer | Access Gap Explorer: county choropleth of population-weighted distance to the nearest recruiting lung-cancer site. |
| 11 | Access Gap Explorer | Switch the map to Census ACS indicators - poverty, insurance, vehicles - to see where barriers overlap. |
| 12 | Access Gap Explorer | A county profile: nearest recruiting sites, geocoding confidence, and every indicator with its margin of error. |
| 13 | Access Gap Explorer | Gap counties vs the rest, and by USDA rural-urban code. County-level associations - explicitly not causal claims. |
| 14 | Trial Explorer | Trial Explorer: real ClinicalTrials.gov records with NCT IDs, recruiting-site counts and a link to the source page. |
| 15 | Trial detail | Drill-down: registry fields reproduced verbatim, why it was classified as oncology, and each site's own status. |
| 16 | Site Strategy Simulator | Site Strategy Simulator. Everything here is hypothetical - candidate sites are not real or planned facilities. |
| 17 | Site Strategy Simulator | Every county is scored as a candidate with five transparent components. The weights are yours to change. |
| 18 | Site Strategy Simulator | Add the top candidate: coverage is recalculated instantly - residents newly within 50 miles, before and after. |
| 19 | Site Strategy Simulator | Equity view: how coverage changes for non-metro and high-poverty county groups - and scenarios side by side. |
| 20 | Site Strategy Simulator | Raise the rurality weight and the ranking reorders. The score is a weighted average you can audit. |
| 21 | Site Strategy Simulator | Plan builder: re-scores after each pick so overlapping candidates aren't chosen twice. Four sites, cumulative gain shown. |
| 22 | Site Strategy Simulator | Sensitivity analysis: 500 seeded alternative weightings, one-at-a-time changes, and other distance thresholds. |
| 23 | Executive Brief | Executive Strategy Brief: findings assembled from computed values, each with its trace, exportable as Markdown or PDF. |
| 24 | Brief: limitations | Methodology and limitations are part of the product: proximity is not access, and scores are not recommendations. |
| 25 | Data & Methods | Data & Methods: every source with retrieval time, hash and freshness; the data dictionary; data-quality counters. |
