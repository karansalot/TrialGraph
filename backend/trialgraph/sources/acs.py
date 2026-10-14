"""U.S. Census Bureau American Community Survey 5-year estimates (county grain).

Source: ACS 5-year *table-based Summary File* (pipe-delimited, one file per detailed table,
all geographies) published at www2.census.gov. This is the same data served by
api.census.gov, but does not require an API key, which keeps the pipeline reproducible
for anyone who clones the repository.

We keep only county rows (GEO_ID prefix 0500000US). Estimate columns are <TABLE>_E###,
margins of error (90% confidence) are <TABLE>_M###.
"""
from __future__ import annotations

from pathlib import Path

from ..config import get_settings
from .fetch import download

COUNTY_PREFIX = b"0500000US"

# table id -> human description (what we use it for)
TABLES = {
    "B01003": "Total population",
    "B01001": "Sex by age (used for population aged 65 and over)",
    "B01002": "Median age",
    "B03002": "Hispanic or Latino origin by race",
    "B17001": "Poverty status in the past 12 months by sex by age",
    "B19013": "Median household income in the past 12 months",
    "B27010": "Types of health insurance coverage by age",
    "B08201": "Household size by vehicles available",
    "B28002": "Presence and types of internet subscriptions in household",
}


def url_for(table: str, year: int) -> str:
    return (
        f"https://www2.census.gov/programs-surveys/acs/summary_file/{year}/table-based-SF/"
        f"data/5YRData/acsdt5y{year}-{table.lower()}.dat"
    )


def extract(refresh: bool = False) -> dict[str, Path]:
    s = get_settings()
    out = {}
    for t, desc in TABLES.items():
        dest = s.raw_dir / "acs" / f"acs5_{s.acs_year}_{t.lower()}_county.dat"
        print(f"  acs {t} ({desc})", flush=True)
        out[t] = download(
            f"acs5_{t.lower()}",
            url_for(t, s.acs_year),
            dest,
            refresh=refresh,
            line_filter=lambda ln: ln.startswith(COUNTY_PREFIX),
            extra={"vintage": f"{s.acs_year - 4}-{s.acs_year} 5-year", "table": t, "table_title": desc},
        )
    return out
