"""Census geography reference files and USDA rurality codes.

- Cartographic boundary files (counties 1:5,000,000 for spatial joins, 1:20,000,000 for display;
  states 1:20,000,000) - vintage set by TG_BOUNDARY_YEAR.
- 2020 Census Centers of Population by tract: the population-weighted "balance point" of every
  census tract, with its 2020 Census population. This is the population surface used for all
  distance calculations.
- 2023 Gazetteer ZCTA file: internal points of ZIP Code Tabulation Areas, used as a second,
  independent coordinate for trial sites (geocoding QA).
- USDA ERS Rural-Urban Continuum Codes 2023.
"""
from __future__ import annotations

from pathlib import Path

from ..config import get_settings
from .fetch import download

RUCC_URL = "https://www.ers.usda.gov/media/5768/2023-rural-urban-continuum-codes.csv"
TRACT_CENPOP_URL = "https://www2.census.gov/geo/docs/reference/cenpop2020/tract/CenPop2020_Mean_TR.txt"
ZCTA_GAZ_URL = (
    "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2023_Gazetteer/2023_Gaz_zcta_national.zip"
)


def boundary_url(layer: str, res: str, year: int) -> str:
    return f"https://www2.census.gov/geo/tiger/GENZ{year}/shp/cb_{year}_us_{layer}_{res}.zip"


def extract(refresh: bool = False) -> dict[str, Path]:
    s = get_settings()
    y = s.boundary_year
    g = s.raw_dir / "geo"
    out = {}
    for key, layer, res in [("county_5m", "county", "5m"), ("county_20m", "county", "20m"),
                            ("state_20m", "state", "20m")]:
        print(f"  boundaries {layer} {res}", flush=True)
        out[key] = download(f"census_cb_{key}", boundary_url(layer, res, y), g / f"cb_{y}_us_{layer}_{res}.zip",
                            refresh=refresh, extra={"vintage": str(y)})
    print("  tract centers of population", flush=True)
    out["tract_cenpop"] = download("census_cenpop2020_tract", TRACT_CENPOP_URL, g / "CenPop2020_Mean_TR.txt",
                                   refresh=refresh, extra={"vintage": "2020 Census"})
    print("  zcta gazetteer", flush=True)
    out["zcta_gaz"] = download("census_gazetteer_zcta", ZCTA_GAZ_URL, g / "2023_Gaz_zcta_national.zip",
                               refresh=refresh, extra={"vintage": "2023"})
    print("  rucc", flush=True)
    out["rucc"] = download("usda_rucc_2023", RUCC_URL, g / "rucc_2023.csv", refresh=refresh,
                           extra={"vintage": "2023"})
    return out
