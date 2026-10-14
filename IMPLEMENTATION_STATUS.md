# Implementation status

_Last updated 2026-10-13. Snapshot: ClinicalTrials.gov data release 2026-10-09._

## Summary

The full stack runs end to end on this machine against real public data, nationwide (50 states + DC):
pipeline, PostGIS database, API, six web pages, simulator, exports, tests. Three things are written but
have **not been executed** here: the Docker Compose stack, the GitHub Actions workflows, and road travel
time. They are listed under "Not verified".

## Verified on this machine

| Area | Status | Evidence |
|---|---|---|
| Phase 1 - source discovery and contracts | done | all four source families probed; contracts in `docs/SOURCES_AND_LINEAGE.md` |
| Phase 2 - ClinicalTrials.gov ingestion | done | 41,748 studies, 597,557 U.S. site records, six statuses distinguished, site-level status used |
| Phase 3 - Census and CDC integration | done | 9 ACS tables (2020-2024), PLACES 2025 county release, RUCC 2023; 25 documented indicators |
| Phase 4 - geographic access | done | 84,414 tracts × 15 categories; cross-checked against PostGIS (max difference 0.44%) |
| Phase 5 - map dashboard | done | National Overview, Access Gap Explorer, Trial Explorer (+ detail), Data & Methods |
| Phase 6 - simulator and brief | done | click-to-add sites, before/after, equity groups, scenario comparison, weighted ranking, sensitivity analysis, Markdown/CSV/print export |
| Phase 7 - tests and docs | done | 78 pytest tests pass; 10 Playwright tests pass; production `next build`, ESLint, `tsc` and ruff clean |
| Feature round 2 | done | greedy multi-site plan builder, coverage by cancer type, sponsor mix, facility profiles, shareable filter URLs, county CSV export |
| Feature round 3 | done | five trial-type lenses (early-phase, phase 3, open to 75+, pediatric, recently verified) through every analysis; auto-generated Insights page (8 findings with evidence and deep links); overview insight teasers |
| Demo | done | `docs/demo/trialgraph-demo.webm` (about 3 min 15 s, includes rounds 2 and 3); README screenshots in `docs/screenshots/` |
| Pilot geography mode | done | `TG_PILOT_STATES=MT,WY,ID` builds in about 9 s (cached sources); verified in round 1 and re-run after round 3 (see below) |
| Demo | done, predates the second feature round | `docs/demo/trialgraph-demo.webm`; the plan builder, cancer-type table and facility pages are not in the recording |

Timings (national, cached downloads): transform 35 s, load 47 s, analyze 14 s. First-time extraction is
about 2 minutes for ClinicalTrials.gov and a few minutes for the 800 MB of ACS files.

## Not verified

| Item | State | What is needed |
|---|---|---|
| Docker Compose stack and both Dockerfiles | written, never built or run (no Docker on this machine) | `docker compose up` on a machine with Docker; note the compose database is PostGIS 16-3.4 while local development used PostgreSQL 18 / PostGIS 3.6 |
| GitHub Actions (`ci.yml`, `refresh-data.yml`) | written, never run (repository has no remote) | push to GitHub; the integration job depends on live public endpoints |
| Road travel time | implemented as an optional OSRM `table` lookup in county profiles; never exercised | set `TG_OSRM_URL` to an OSRM-compatible server and test; the UI states that no routing source is configured |

## Deliberate scope decisions

- **Nationwide rather than a pilot.** County and tract processing proved cheap, so the default run is
  national. Pilot mode exists for CI and quick iteration; in pilot mode, sites just outside the pilot
  states are not loaded, so coverage near the pilot border is understated.
- **Census data via Summary Files, not the API.** The Census API now requires a key. There is no
  API-key code path.
- **Interventional studies only for access.** Observational studies are ingested and searchable but do
  not count toward coverage.
- **Statuses ingested:** recruiting, not yet recruiting, enrolling by invitation, active not recruiting,
  completed, unknown. Suspended, terminated and withdrawn studies are not ingested.
- **50 states + DC.** Puerto Rico and other territories are excluded.
- **County candidates.** The ranking evaluates one hypothetical site per county, at its population centre.
  The simulator accepts any map location.

## Known limitations and rough edges

- Site coordinates are ZIP-area or city centroids (the registry provides nothing finer). 197 facilities
  have no coordinate and are excluded from distance work.
- Facility de-duplication is exact-match only; large institutions appear under several spellings
  (for example three variants of MD Anderson), so facility counts are upper bounds.
- Cancer categories are keyword rules. They have unit tests for representative cases but no systematic
  accuracy audit against a labelled sample.
- The oncology filter excludes 1,895 retrieved studies; a spot check found one borderline disease
  (post-transplant lymphoproliferative disorder) that was then added to the rules. Other borderline
  conditions may remain on either side.
- Margins of error are computed for ACS-derived shares, but not propagated into gap-versus-other
  comparisons or scores.
- The ranking is highly sensitive to the distance threshold (see methodology section 9).
- UI: light theme only; laid out for desktop widths, not tuned for phones; Alaska and Hawaii are shown at
  true positions rather than as insets; maps have no place-name labels.
- The API has no authentication or rate limiting; it is intended for local or internal use.
- `data/` (about 100 MB of cached sources and staging files) and `.tools/` are git-ignored; a fresh clone
  must run the pipeline.

## Blocked features

None. Every requested feature is implemented; the items under "Not verified" are unexecuted rather than
blocked.
