# Methodology

Figures quoted here are from the snapshot retrieved 2026-10-12 (ClinicalTrials.gov data release
2026-10-09) and will change when the pipeline is re-run.

## 1. Which studies are included

**Retrieval.** ClinicalTrials.gov API v2, `query.cond` = a broad cancer-term expression, restricted to
studies with a U.S. location and to six overall statuses: Recruiting, Not yet recruiting, Enrolling by
invitation, Active not recruiting, Completed, Unknown. Suspended, terminated, withdrawn and
expanded-access statuses are out of scope. 41,748 studies were retrieved.

**Oncology determination.** The retrieval query also matches titles and keywords, so each study is then
classified:

| `oncology_basis` | Rule | Studies |
|---|---|---|
| `mesh` | an NLM-assigned MeSH condition term or ancestor is in the Neoplasms tree | 35,580 |
| `condition_text` | no such term, but a sponsor-entered condition names a cancer (regular expression) | 4,273 |
| `not_oncology` | neither; kept in the table, excluded from every analysis | 1,895 |

**Cancer categories.** Fourteen categories are assigned by regular expressions over sponsor-entered
conditions and MeSH condition terms (not titles, keywords or ancestors). The rules are in
`pipeline/classify.py`, are returned by `/api/meta`, and are shown on the Data & Methods page. A study can
belong to several categories. This is deliberately simple and auditable; it will mis-assign some studies
(for example a colorectal study that lists "liver metastases" also lands in liver & biliary).

**Trial-type lenses.** Five lenses cut across cancer types and are handled exactly like categories
(every map, table, simulator run and insight can use them):

| Lens | Rule |
|---|---|
| Early-phase | phases include EARLY_PHASE1 or PHASE1 |
| Phase 3 | phases include PHASE3 |
| Open to adults 75+ | no maximum age, or maximum age at least 75 years (registry age limits only) |
| Open to children | registry standard age groups include CHILD |
| Recruitment verified in last 12 months | the sponsor verified the record's status within 12 months of the registry data release |

Internally each study carries `filter_keys = ['all'] + cancer_categories + lenses`, and every analysis
filters on that one array.

## 2. What counts as a recruiting site

A site contributes to access only if all four hold:

1. the study is oncology-related;
2. the study is interventional;
3. the study's overall status is `RECRUITING` **and** the site's own status is `RECRUITING`;
4. the site has a coordinate.

Within recruiting studies, 75,713 site links are themselves recruiting; 15,137 are not (suspended, active
not recruiting, not yet recruiting, withdrawn, completed, terminated) and are excluded. 66 recruiting
interventional studies have no U.S. site marked recruiting and add no coverage. Observational studies are
searchable in the Trial Explorer but do not count toward access.

## 3. Where sites are

ClinicalTrials.gov publishes one coordinate per **city**: every site in a city shares it. To do better,
each site's ZIP code is matched to the Census ZIP Code Tabulation Area gazetteer.

| Method | Rule | Confidence | Facilities |
|---|---|---|---|
| `zcta_centroid` | ZIP matches a ZCTA whose internal point is within 30 miles of the registry city point | high | 72,690 |
| `city_point` | no usable ZIP; registry city point | medium | 8,887 |
| `zcta_centroid_no_city` | ZIP matches, registry gave no point | medium | 370 |
| `city_point_zip_conflict` | ZIP centroid more than 30 miles from the city point; ZIP distrusted | low | 1,254 |
| downgraded | coordinate falls in a different state than the registry reports | low | 130 |
| `none` | no coordinate; excluded from distance work | none | 197 |

Median disagreement between the two coordinates is 2.5 miles (99th percentile 16 miles). Site positions
are therefore ZIP-area or city centroids, not addresses.

**De-duplication.** Site names are free text. Records merge into one facility only when the normalised
name, city, state and ZIP all match: 597,557 site records become 83,528 facilities. This is conservative,
so one institution can appear under several spellings and facility counts are upper bounds. Sponsor-
anonymised names ("Research Site") are flagged. Distance results do not depend on de-duplication.

## 4. Where people are

The population surface is the Census Bureau's 2020 Centers of Population for all 84,414 census tracts in
the 50 states and DC, with 2020 Census populations (total 331,449,281). Tracts are assigned to 2023
counties by point-in-polygon in PostGIS rather than by GEOID prefix, because Connecticut replaced its
counties with planning regions in 2022. 343 tracts whose centre falls just outside the generalised
boundary are assigned to the nearest county in their state.

## 5. Distance

Great-circle distance on a sphere of radius 6371.0088 km, from each tract centre to the nearest analysis
site, found exactly with a KD-tree on unit-sphere coordinates. It is **straight-line distance**: not road
distance and not travel time. Checks run in the test suite:

- against PostGIS geodesic `ST_Distance` on a tract sample: maximum relative difference 0.44%;
- against an independent PostGIS nearest-neighbour search: our nearest site is never more than 0.5 miles
  farther than PostGIS's;
- a category's nearest site is never closer than the all-oncology nearest site.

Road travel time is implemented as an optional OSRM-compatible lookup for county profiles and is disabled
unless `TG_OSRM_URL` is set. It has not been verified against a live routing server.

## 6. Coverage and access gaps

- **Coverage** = share of residents whose tract centre is within the threshold (25 to 150 miles; default 50).
- **County figures** are population-weighted aggregates of the county's tracts.
- **Access gap** = a county where fewer than a chosen share of residents (default 50%) are within the
  threshold. Both parameters are user-adjustable.
- **Supply** = distinct recruiting studies with an analysis site within 50 miles of the county population
  centre, computed with PostGIS `ST_DWithin`.

## 7. Socioeconomic and health indicators

ACS 2020-2024 5-year county estimates: total population, median age, share aged 65+, median household
income, poverty rate, uninsured rate, households without a vehicle, households without internet, and
share of people of color. Derived shares carry 90% margins of error computed with the Census ACS handbook
formulas. Census sentinel values become NULL with a reason.

CDC PLACES (2025 county release, BRFSS 2022/2023): cancer prevalence, smoking, mammography, colorectal
screening, uninsured adults, routine checkups, transportation barriers and fair/poor health, each as crude
and age-adjusted prevalence with CDC's 95% interval. These are model-based estimates. Coverage is partial
(2,956 of 3,144 counties for most measures; 2,299 for transportation barriers) and missing counties are
shown as "not published".

Rurality: USDA ERS Rural-Urban Continuum Codes 2023 (1-3 metro, 4-9 non-metro).

Comparisons between gap and other counties are population-weighted county means, with a Spearman rank
correlation against county mean distance. They are ecological associations and are labelled as such.

## 8. Site opportunity score

A candidate is a hypothetical site at a county's population centre, assumed to recruit for the selected
category. For the residents who would become newly within the threshold:

| Component | Definition | Default weight |
|---|---|---|
| coverage | newly covered residents ÷ the largest such value among candidates in scope | 40% |
| distance relief | average miles saved per newly covered resident, capped at 100, ÷ 100 | 20% |
| equity | population-weighted mean national percentile of poverty, uninsured and no-vehicle rates | 20% |
| rurality | share of newly covered residents in non-metro counties | 10% |
| health context | population-weighted national percentile of age-adjusted cancer prevalence (PLACES) | 10% |

`score = 100 × Σ wₖcₖ / Σ wₖ`. A component that is unavailable for a candidate is skipped and the remaining
weights renormalised, so missing data neither rewards nor penalises. Candidates gaining fewer than a
minimum number of residents (default 5,000) are not ranked. Candidates are scored one at a time against
today's baseline; scores are not additive. Cancer prevalence is context, not demand. Nothing in the score
describes feasibility.

### Multi-site plans

Because candidates are scored independently, neighbouring candidates often serve the same uncovered
residents. The plan builder uses greedy sequential selection: step 1 takes the top-scoring candidate;
each later step re-scores every county against today's baseline plus the sites already chosen and takes
the new top candidate. Tests confirm that a plan's cumulative gain equals simulating all its sites
together, and that it never covers fewer residents than the top-k independent candidates. Greedy
selection is a heuristic and is not guaranteed to find the best possible set of k sites.

## 9. Sensitivity analysis

- **Weights, jointly:** 500 weight vectors from a seeded Dirichlet distribution centred on the chosen
  weights; reported as median rank, 5th-95th percentile rank and share of draws in the top 10.
- **Weights, one at a time:** each weight ×0.5 and ×1.5, others renormalised.
- **Threshold:** ranking recomputed at 25, 50, 75 and 100 miles.

In the current snapshot the top 10 is moderately stable to weights (members stay in the top 10 in 40-81%
of draws) and **highly sensitive to the distance threshold**: only 2 of the 50-mile top 10 remain at 25
miles, 3 at 75 and 1 at 100. Any use of the ranking should state the threshold.

## 10. Insights

`GET /api/insights` assembles eight findings from the live data at request time (early-phase access,
registry verification age, upper age limits, double-burden counties, rural gaps by state, concentration
of trial activity, worst-served cancer type, and diminishing returns from new sites). Each returns its
evidence values and a deep link; tests check that the evidence matches the corresponding API figures
and that greedy coverage gains are non-increasing. "Double burden" means an access-gap county that is in
the national top quartile of counties for poverty or for uninsurance. The diminishing-returns curve uses
coverage-only weights and a 1,000-resident minimum.

## 11. Limitations

See the Executive Brief page or `LIMITATIONS` in `backend/trialgraph/api/brief.py`; the same list is
included in every exported brief.
