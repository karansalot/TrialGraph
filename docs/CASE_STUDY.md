# Executive case study: where could a new oncology trial site matter most?

*Snapshot: ClinicalTrials.gov data release 2026-10-09, retrieved 2026-10-12. All distances are
straight-line miles. All candidate sites are hypothetical.*

## The question

A health system or research network deciding where to add trial capacity needs three things before it
can even start a feasibility conversation: where trials are recruiting today, who lives far from them,
and which locations would close the most distance for the people facing the most barriers. Registry data
answers the first only after careful filtering, and nothing off the shelf answers the other two.

## What the data shows

**1. Most registered studies are not open.** Of 39,853 oncology studies with U.S. sites, 6,928 (17%) are
listed as recruiting. Counting "trials near me" from the registry without filtering overstates current
opportunity roughly six-fold. Even within recruiting studies, about one site link in six is not itself
recruiting.

**2. Straight-line access is broad but uneven.** 97.7% of residents live within 50 miles of a site that
is recruiting for an interventional oncology study; the median resident is 4 miles away. But 7.5 million
people are beyond 50 miles, and 1.0 million are beyond 100.

**3. The gap is rural.** 87.6% of non-metro residents are within 50 miles, against 99.4% of metro
residents. Mean distance is 29 miles versus 6. In the most rural counties (RUCC 9), about 30% of residents
are beyond 50 miles.

**4. Distance overlaps with other barriers.** In the 459 counties where fewer than half of residents are
within 50 miles (7.3 million people), poverty is 16.6% versus 12.4% elsewhere, 11.1% are uninsured versus
8.3%, and 11.8% of households have no internet access versus 6.4%. Median household income is $62,383
versus $84,883. These are county-level associations.

**5. Specific cancers thin out quickly.** For all oncology, 7.5 million residents are beyond 50 miles of
a recruiting site. For breast cancer studies it is 14.7 million, for lung 15.8 million, for sarcoma 37.2
million and for liver and biliary cancers 65.4 million (80.3% coverage). Use the category filter rather
than the all-oncology view for any real planning question.

**6. Early-phase trials are the real desert.** Phase 1 studies are where new drugs first reach patients.
40.4 million residents live more than 50 miles from a site recruiting for one - 32.9 million more than for
any oncology trial. The median resident is 8.5 miles from an early-phase site against 4.0 from any site.

**7. Registry status flatters some regions.** 624 of 6,928 studies listed as Recruiting (9.0%) were last
status-verified more than 12 months before this registry release, 142 of them more than two years before.
Counting only recently verified studies moves about 946,000 residents outside 50 miles.

**8. Upper age limits exclude the people most likely to have cancer.** 511 of 5,679 recruiting
interventional studies (9.0%) set a maximum age below 75.

**9. New sites alone cannot close the gap.** Choosing sites greedily for coverage, ten well-placed
hypothetical sites would cover only about a quarter of the out-of-range population; even the single
best site covers about 3%. The remaining gap is spread across many small, remote communities, which
points toward decentralised and remote-participation models for the last stretch.

## What the simulator suggests

Scoring every county as a hypothetical site location (default weights, 50-mile threshold), the largest
modelled opportunities are:

| Rank | Candidate | Residents newly within 50 mi | Stays in top 10 across 500 weightings |
|---|---|---|---|
| 1 | Yuma County, AZ | 214,279 | 71% |
| 2 | Colbert County, AL | 228,975 | 77% |
| 3 | Lauderdale County, MS | 190,899 | 81% |
| 4 | St. Lawrence County, NY | 161,764 | 67% |
| 5 | Lauderdale County, AL | 225,016 | 69% |

Two patterns matter more than the order. First, candidates cluster: Colbert and Lauderdale, AL are
neighbours serving the same uncovered population, and several Arkansas candidates overlap. They are
alternatives, not a list to fund in sequence. The plan builder handles this by re-scoring after each
chosen site: a three-site plan (Yuma AZ, Colbert AL, Lauderdale MS) brings 634,153 more residents within
50 miles, lifting coverage from 97.73% to 97.92%. Second,
the ranking is **sensitive to the distance threshold**: only 2 of the 10 remain in the top 10 at 25 miles
and 1 at 100 miles. The threshold is a planning assumption that should be chosen deliberately.

## How a planner would use it

1. Pick the cancer category and region that match the portfolio.
2. Read the gap map against poverty, insurance and vehicle access to see which gaps compound.
3. Shortlist candidates from the ranking, then build two or three multi-site scenarios and compare
   coverage, non-metro and high-poverty gains side by side.
4. Check the sensitivity tab. Carry forward only candidates that survive changes in weights and threshold.
5. Export the brief and take the shortlist into a real feasibility assessment.

## What this does not tell you

It does not say a site is feasible, that investigators or sponsors are available, that any patient would
be eligible, or how long the drive is. Site coordinates are ZIP-area centroids. Registry statuses are
sponsor-maintained. A surprising result (for example, a mid-sized metro with no recruiting site) may
reflect a registry record that has not been updated, and should be checked against the Trial Explorer
before anyone acts on it.

## Why the result can be trusted as far as it goes

Every number above is reproducible from public files with one command; each source is hashed and
time-stamped; distances are cross-checked against PostGIS; 67 automated tests enforce the integrity rules
(including that no non-recruiting study ever contributes coverage); and the limitations travel with every
export.
