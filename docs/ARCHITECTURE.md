# Architecture

## Starting point

The session began in an unrelated repository (FieldMind, a Next.js app directory). TrialGraph was created
as a separate project so the two do not interfere. The machine had Node 20 and pnpm but no Docker, no
PostgreSQL and only Python 3.9, so a project-local toolchain (`.tools/`, via micromamba from conda-forge)
provides Python 3.12 and PostgreSQL 18 + PostGIS 3.6 for development. Docker Compose (PostGIS 16-3.4) is
the documented deployment path.

## Components

| Layer | Technology | Location |
|---|---|---|
| Extract | httpx, streamed downloads, manifest with URL / time / SHA-256 | `backend/trialgraph/sources/` |
| Transform | pandas (pure functions, parquet staging) | `backend/trialgraph/pipeline/transform.py`, `classify.py` |
| Load | SQLAlchemy + psycopg `COPY`, GeoPandas for shapefiles, PostGIS SQL for spatial joins | `pipeline/load.py`, `schema.sql` |
| Analysis | NumPy / SciPy KD-tree on the unit sphere; PostGIS for county supply counts | `analysis/` |
| API | FastAPI, gzip, CORS | `api/` |
| Web | Next.js 16 (App Router), TypeScript, Tailwind 4, shadcn/ui, MapLibre GL JS, Recharts | `frontend/` |
| Tests | pytest (unit, data validation, API), Playwright (browser) | `backend/tests/`, `frontend/e2e/` |
| Ops | Docker Compose, GitHub Actions (CI + weekly refresh), Makefile | repo root, `.github/workflows/` |

## Data flow

1. **Extract** writes verbatim source files under `data/raw/` and records each in `manifest.json`. The
   nine nationwide ACS summary files (about 800 MB together) are streamed; only county rows are kept on
   disk, while the hash and size recorded are those of the complete upstream file.
2. **Transform** produces tidy parquet tables: studies, de-duplicated facilities, study-site links, tract
   centres, RUCC codes, and indicator values plus their definitions.
3. **Load** drops and recreates the schema, then does the geographic normalisation in SQL: tracts and
   facilities are assigned to current counties by point-in-polygon, county population centres are derived
   from tracts, and a wide `county_profile` view is generated from the indicator table.
4. **Analyze** computes, for every tract and cancer category, the distance to the nearest analysis site
   (`tract_access`) and county supply counts in PostGIS (`county_supply`).
5. **Serve.** The API keeps an in-memory model (84k tracts, per-category baseline distances). Because a
   new site can only shorten a tract's distance, a scenario is `min(baseline, distance to new site)` -
   exact, and fast enough to recompute on every click (about 70 ms nationally).

## Static edition

`trialgraph export-static` writes the snapshot the browser needs into `frontend/public/data`: tract
centres and per-filter baseline distances as Float32 binaries, county profiles, registry aggregates per
filter and state, analysis-site lists, insights, a compact trial index, and sharded trial, facility and
county detail. `frontend/lib/static/engine.ts` ports the access model (summaries, county tables,
simulation, candidate scoring with a 1-degree grid index, greedy plans, sensitivity analysis), and
`frontend/lib/static/router.ts` answers the same API paths with the same response shapes. Pages do not
know which edition they run in. `next build` with `output: "export"` produces plain files for Netlify or
GitHub Pages.

## Why these choices

- **Tract-level population surface, county-level display.** Coverage is computed from 84,414 tract centres
  of population, which is far more accurate than county centroids, then aggregated to counties for maps.
- **Distance in Python, verified in PostGIS.** The KD-tree computes 1.3 million tract-category distances in
  seconds; tests compare a sample with PostGIS geodesic `ST_Distance` (maximum difference 0.44%) and with
  an independent PostGIS nearest-neighbour search.
- **Long-format indicators.** One table defines every indicator (source cells, universe, vintage,
  limitations) and another holds values, so the UI data dictionary and `docs/DATA_DICTIONARY.md` are
  generated rather than hand-maintained.
- **Full rebuild on load.** There is never a mixture of two retrieval dates in the database.
- **No basemap tiles.** Maps draw Census boundaries directly, so the app has no third-party tile dependency.

## API surface

`/api/meta`, `/api/meta/freshness`, `/api/meta/indicators`, `/api/meta/quality`, `/api/overview`,
`/api/facilities`, `/api/geo/{counties|states}`, `/api/access/counties`, `/api/access/counties.csv`, `/api/access/by-category`, `/api/access/compare`,
`/api/access/county/{fips}`, `/api/trials`, `/api/trials/{nct_id}`, `/api/facilities/{id}`,
`/api/simulator/{simulate|candidates|candidates.csv|plan|sensitivity}`, `/api/insights`, `/api/brief`, `/api/brief.md`.
Interactive documentation is served at `/docs`.
