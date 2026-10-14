"""TrialGraph pipeline CLI.

    trialgraph extract [--refresh]   download public source files into data/raw (+ manifest)
    trialgraph transform             raw -> tidy staging tables (data/staging)
    trialgraph load                  staging -> PostGIS (full idempotent rebuild)
    trialgraph analyze               compute tract/county access tables
    trialgraph all [--refresh]       everything above, in order
    trialgraph freshness             print the data-freshness report
    trialgraph docs                  regenerate docs/DATA_DICTIONARY.md from the database
    trialgraph export-static         write the data snapshot for the serverless static edition
"""
from __future__ import annotations

import argparse
import json
import time


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="trialgraph", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("step", choices=["extract", "transform", "load", "analyze", "all", "freshness", "docs", "export-static"])
    ap.add_argument("--refresh", action="store_true", help="re-download sources even if cached")
    ap.add_argument("--only", default="", help="extract only: comma list of ctgov,acs,places,geo")
    a = ap.parse_args(argv)
    t0 = time.time()

    def extract():
        from ..sources import acs, ctgov, geo, places
        mods = {"geo": geo, "places": places, "acs": acs, "ctgov": ctgov}
        for name in (a.only.split(",") if a.only else mods):
            print(f"[extract] {name}", flush=True)
            mods[name].extract(refresh=a.refresh)

    def transform():
        from . import transform as T
        print("[transform]", flush=True)
        print(json.dumps(T.run_all(), indent=2, default=str))

    def load():
        from . import load as L
        print("[load]", flush=True)
        print(json.dumps(L.load_all(), indent=2, default=str))

    def analyze():
        from ..analysis import access
        print("[analyze]", flush=True)
        print(json.dumps(access.compute_access(), indent=2))

    def freshness():
        from ..analysis.freshness import freshness_report
        print(json.dumps(freshness_report(), indent=2, default=str))

    def docs():
        from . import docs as D
        print("wrote", D.write())

    def export_static():
        from .export_static import export
        print(json.dumps(export(), indent=2))

    steps = {"export-static": [export_static], "docs": [docs], "extract": [extract], "transform": [transform], "load": [load], "analyze": [analyze],
             "all": [extract, transform, load, analyze], "freshness": [freshness]}
    for fn in steps[a.step]:
        fn()
    print(f"done in {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
