# Sources and lineage

Every source file is recorded in `data/raw/manifest.json` at download time and copied into the
`source_dataset` table at load time (URL, retrieval timestamp, publisher's own update stamp where exposed,
SHA-256, size, row count, query parameters). The Data & Methods page and `GET /api/meta/freshness` show
the live values. The table below describes the contract; the retrieval times are those of the documented
snapshot.

## Sources

| Key | Source | Publisher | Endpoint | Vintage | Grain | Key needed |
|---|---|---|---|---|---|---|
| `ctgov_studies` | ClinicalTrials.gov API v2 | U.S. National Library of Medicine | `https://clinicaltrials.gov/api/v2/studies` | live registry; data release 2026-10-09 | study, site | no |
| `acs5_b*` (9 tables) | ACS 5-year table-based Summary File | U.S. Census Bureau | `https://www2.census.gov/programs-surveys/acs/summary_file/2024/table-based-SF/data/5YRData/` | 2020-2024 | county | no |
| `cdc_places_county` | PLACES: Local Data for Better Health, County Data, 2025 release | CDC | `https://data.cdc.gov/resource/swc5-untb.json` | BRFSS 2022/2023 | county | no |
| `census_cb_county_5m`, `_20m`, `census_cb_state_20m` | Cartographic Boundary Files | U.S. Census Bureau | `https://www2.census.gov/geo/tiger/GENZ2023/shp/` | 2023 | polygons | no |
| `census_cenpop2020_tract` | 2020 Centers of Population by tract | U.S. Census Bureau | `https://www2.census.gov/geo/docs/reference/cenpop2020/tract/CenPop2020_Mean_TR.txt` | 2020 Census | tract | no |
| `census_gazetteer_zcta` | Gazetteer file, ZIP Code Tabulation Areas | U.S. Census Bureau | `https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2023_Gazetteer/` | 2023 | ZCTA | no |
| `usda_rucc_2023` | Rural-Urban Continuum Codes | USDA Economic Research Service | `https://www.ers.usda.gov/media/5768/2023-rural-urban-continuum-codes.csv` | 2023 | county | no |

All are U.S. Government works in the public domain. ClinicalTrials.gov asks users to attribute the source
and not to imply endorsement; TrialGraph does both.

### Source notes found during verification

- **Census API.** `api.census.gov` now redirects keyless requests to a "missing key" page. The pipeline
  uses the ACS table-based Summary Files instead - the same estimates, published as flat files, with no key.
- **ACS tables used.** B01003, B01001, B01002, B03002, B17001, B19013, B27010, B08201, B28002. Exact cells
  per indicator are in the data dictionary.
- **ClinicalTrials.gov coordinates** are one point per city, not per facility (verified: every city-state
  group in the snapshot has exactly one coordinate).
- **Connecticut.** ACS 2024, PLACES 2025, RUCC 2023 and the 2023 boundaries all use the nine planning
  regions; the 2020 tract file uses the eight former counties. Tracts are therefore joined spatially.
- **PLACES coverage.** Most 2023 measures cover 2,956 of 3,144 counties; transportation barriers cover
  2,299; the 2022 screening measures cover 3,143.

## Lineage: source to table

| Target | Built from | Transformation |
|---|---|---|
| `study` | `ctgov_studies` | flatten protocol and derived sections; status group; oncology basis; category rules; age parsing |
| `facility` | `ctgov_studies` + `census_gazetteer_zcta` + `county` | U.S. sites in the 50 states and DC; ZIP-to-ZCTA geocoding with tiers; de-duplication on normalised name + city + state + ZIP; county by point-in-polygon; state-mismatch check |
| `study_site` | `ctgov_studies` | one row per study and facility; most "open" site status kept when a study lists a facility twice; `is_recruiting_site` |
| `state`, `county` | boundary files, tract centres, `usda_rucc_2023` | 5m polygons for joins, 20m for display; population and population centre from tracts; RUCC |
| `tract_center` | `census_cenpop2020_tract` + `county` | point geography; county by `ST_Contains`, nearest-in-state fallback |
| `indicator`, `county_indicator` | `acs5_*`, `cdc_places_county` | cell arithmetic, margins of error, sentinel handling; PLACES crude and age-adjusted values with intervals |
| `tract_access` | `tract_center`, analysis sites | nearest analysis site and count within 50 miles, per category |
| `county_supply` | `county`, analysis sites | PostGIS `ST_DWithin` counts |
| `county_profile` (view) | `county`, `county_indicator` | pivot generated from the indicator table |

## Data-quality handling

| Concern | Handling |
|---|---|
| Source metadata and timestamps | manifest and `source_dataset` |
| Geographic normalisation | everything keyed to 2023 county GEOIDs and 2020 tract GEOIDs; spatial joins in PostGIS |
| Missing values | NULL plus `missing_reason` (database check constraint); never imputed |
| Duplicate facilities | conservative key; variant and source-record counts kept per facility |
| Study-to-facility relationships | `study_site`, with foreign keys and the site's own status |
| Geocoding confidence | method and confidence tier per facility; ZIP-versus-city gap stored; state-mismatch downgrade |
| Freshness | `trialgraph freshness`, `/api/meta/freshness?live=true` (compares the snapshot with the registry's current data release), header indicator in the UI, weekly GitHub Action |
| Reproducibility | raw pages stored verbatim; seeded sensitivity analysis; full rebuild on load; pinned boundary and ACS vintages |

## Refreshing

`make refresh` re-downloads ClinicalTrials.gov and rebuilds. ClinicalTrials.gov is flagged stale after 14
days (`TG_CTGOV_STALE_AFTER_DAYS`); annual sources after 400 days; reference geography after 1,200 days.
