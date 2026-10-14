"""Transform raw source files into tidy staging tables (parquet under data/staging).

Pure functions wherever possible so they can be unit-tested against recorded real records.
No value is ever imputed: missing inputs stay missing and carry a `missing_reason`.
"""
from __future__ import annotations

import json
import zipfile

import numpy as np
import pandas as pd

from ..analysis.distance import haversine_miles
from ..config import get_settings
from ..sources import acs as acs_src
from ..sources import ctgov
from ..sources import places as places_src
from ..sources.fetch import read_manifest
from . import classify as C
from .reference import FIPS_TO_USPS, NAME_TO_USPS

ZIP_CITY_CONFLICT_MI = 30.0  # ZIP centroid further than this from the city point => distrust the ZIP

# ---------------------------------------------------------------- ClinicalTrials.gov


def parse_study(raw: dict) -> tuple[dict, list[dict]]:
    """Flatten one API v2 study record into (study row, list of US site rows)."""
    ps = raw.get("protocolSection", {})
    ident, status = ps.get("identificationModule", {}), ps.get("statusModule", {})
    design, elig = ps.get("designModule", {}), ps.get("eligibilityModule", {})
    cb = raw.get("derivedSection", {}).get("conditionBrowseModule", {})
    conditions = ps.get("conditionsModule", {}).get("conditions", []) or []
    mesh = [m["term"] for m in cb.get("meshes", [])]
    ancestors = [m["term"] for m in cb.get("ancestors", [])]
    basis = C.oncology_basis(conditions, mesh + ancestors)
    interventions = [
        {"type": i.get("type"), "name": i.get("name")}
        for i in ps.get("armsInterventionsModule", {}).get("interventions", []) or []
    ]
    overall = status.get("overallStatus")
    nct = ident.get("nctId")
    study = {
        "nct_id": nct,
        "brief_title": ident.get("briefTitle"),
        "overall_status": overall,
        "status_group": C.STATUS_GROUP.get(overall),
        "status_verified_date": status.get("statusVerifiedDate"),
        "last_update_posted": (status.get("lastUpdatePostDateStruct") or {}).get("date"),
        "start_date": (status.get("startDateStruct") or {}).get("date"),
        "primary_completion_date": (status.get("primaryCompletionDateStruct") or {}).get("date"),
        "study_type": design.get("studyType"),
        "phases": design.get("phases") or [],
        "enrollment_count": (design.get("enrollmentInfo") or {}).get("count"),
        "enrollment_type": (design.get("enrollmentInfo") or {}).get("type"),
        "lead_sponsor": (ps.get("sponsorCollaboratorsModule", {}).get("leadSponsor") or {}).get("name"),
        "sponsor_class": (ps.get("sponsorCollaboratorsModule", {}).get("leadSponsor") or {}).get("class"),
        "conditions": conditions,
        "mesh_terms": mesh,
        "interventions": json.dumps(interventions),
        "intervention_types": sorted({i["type"] for i in interventions if i["type"]}),
        "sex": elig.get("sex"),
        "min_age_years": C.age_years(elig.get("minimumAge")),
        "max_age_years": C.age_years(elig.get("maximumAge")),
        "std_ages": elig.get("stdAges") or [],
        "healthy_volunteers": elig.get("healthyVolunteers"),
        "oncology_basis": basis,
        "cancer_categories": C.cancer_categories(conditions, mesh) if basis != "not_oncology" else [],
    }
    sites = []
    for loc in ps.get("contactsLocationsModule", {}).get("locations", []) or []:
        if loc.get("country") != "United States":
            continue
        gp = loc.get("geoPoint") or {}
        sites.append({
            "nct_id": nct,
            "facility_raw": loc.get("facility"),
            "city": (loc.get("city") or "").strip() or None,
            "state_raw": loc.get("state"),
            "usps": NAME_TO_USPS.get((loc.get("state") or "").strip().lower()),
            "zip5": _zip5(loc.get("zip")),
            "site_status": loc.get("status"),
            "ctgov_lat": gp.get("lat"),
            "ctgov_lon": gp.get("lon"),
        })
    return study, sites


def _zip5(z: str | None) -> str | None:
    z = (z if isinstance(z, str) else "").strip()[:5]
    return z if len(z) == 5 and z.isdigit() else None


def site_is_recruiting(study_status: str | None, site_status: str | None) -> bool:
    """A site counts as *currently recruiting* only when BOTH the study and the site say so."""
    return study_status == "RECRUITING" and site_status == "RECRUITING"


def geocode_sites(sites: pd.DataFrame, zcta: pd.DataFrame) -> pd.DataFrame:
    """Assign each site a coordinate and an explicit confidence tier.

    ClinicalTrials.gov publishes one geoPoint per *city* (every site in a city shares it), so we
    prefer the Census ZCTA internal point for the site's ZIP when it is consistent with the city.

      zcta_centroid       ZIP matches a Census ZCTA within 30 mi of the city point   -> 'high'  (ZIP-area precision)
      city_point          no usable ZIP; ClinicalTrials.gov city-level point          -> 'medium'
      city_point_zip_conflict  ZIP centroid > 30 mi from the city point; ZIP distrusted -> 'low'
      zcta_centroid_no_city    ZIP matches but ClinicalTrials.gov gave no point        -> 'medium'
      none                no coordinate available; site excluded from distance analysis
    """
    df = sites.merge(zcta.rename(columns={"lat": "zcta_lat", "lon": "zcta_lon"}), on="zip5", how="left")
    has_z, has_c = df.zcta_lat.notna(), df.ctgov_lat.notna()
    gap = pd.Series(np.nan, index=df.index)
    both = has_z & has_c
    gap[both] = haversine_miles(df.ctgov_lat[both], df.ctgov_lon[both], df.zcta_lat[both], df.zcta_lon[both])
    agree = both & (gap <= ZIP_CITY_CONFLICT_MI)
    method = np.select(
        [agree, both & ~agree, has_c & ~has_z, has_z & ~has_c],
        ["zcta_centroid", "city_point_zip_conflict", "city_point", "zcta_centroid_no_city"],
        default="none",
    )
    use_z = np.isin(method, ["zcta_centroid", "zcta_centroid_no_city"])
    df["geocode_method"] = method
    df["geocode_confidence"] = pd.Series(method).map({
        "zcta_centroid": "high", "city_point": "medium", "zcta_centroid_no_city": "medium",
        "city_point_zip_conflict": "low", "none": "none"}).values
    df["lat"] = np.where(use_z, df.zcta_lat, df.ctgov_lat)
    df["lon"] = np.where(use_z, df.zcta_lon, df.ctgov_lon)
    df.loc[method == "none", ["lat", "lon"]] = np.nan
    df["zip_city_gap_mi"] = gap.round(2)
    return df.drop(columns=["zcta_lat", "zcta_lon"])


def build_facilities(sites: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    """De-duplicate free-text site records into facilities.

    Key = (normalised name, lower-cased city, state, ZIP5). Sponsor-anonymised names
    ('Research Site') are keyed the same way and flagged; they are real locations whose
    institutional identity is not disclosed in the registry.
    """
    s = sites.copy()
    s["name_norm"] = s.facility_raw.map(C.normalize_name)
    s["is_placeholder_name"] = s.facility_raw.map(C.is_placeholder_name)
    s["city_norm"] = s.city.fillna("").str.lower().str.strip()
    key_cols = ["name_norm", "city_norm", "usps", "zip5"]
    s["facility_key"] = s[key_cols].fillna("").agg("|".join, axis=1)
    grp = s.groupby("facility_key", sort=True)
    fac = grp.agg(
        name=("facility_raw", lambda x: x.dropna().mode().iat[0] if x.notna().any() else None),
        name_norm=("name_norm", "first"), is_placeholder_name=("is_placeholder_name", "first"),
        city=("city", "first"), usps=("usps", "first"), zip5=("zip5", "first"),
        lat=("lat", "first"), lon=("lon", "first"),
        geocode_method=("geocode_method", "first"), geocode_confidence=("geocode_confidence", "first"),
        zip_city_gap_mi=("zip_city_gap_mi", "first"),
        n_source_records=("nct_id", "size"), n_name_variants=("facility_raw", "nunique"),
    ).reset_index()
    fac.insert(0, "facility_id", np.arange(1, len(fac) + 1))
    s = s.merge(fac[["facility_key", "facility_id"]], on="facility_key")
    # one row per (study, facility); if a study lists the same facility twice keep the most "open" status
    rank = {"RECRUITING": 0, "NOT_YET_RECRUITING": 1, "ENROLLING_BY_INVITATION": 2, "ACTIVE_NOT_RECRUITING": 3,
            "SUSPENDED": 4, "COMPLETED": 5, "TERMINATED": 6, "WITHDRAWN": 7}
    s["_r"] = s.site_status.map(rank).fillna(9)
    ss = (s.sort_values(["nct_id", "facility_id", "_r"])
           .drop_duplicates(["nct_id", "facility_id"])[["nct_id", "facility_id", "site_status", "facility_raw"]])
    return fac.drop(columns=["facility_key"]), ss


def transform_ctgov() -> dict:
    s = get_settings()
    studies, sites = [], []
    for raw in ctgov.iter_raw_studies():
        st, si = parse_study(raw)
        studies.append(st)
        sites.extend(si)
    sdf = pd.DataFrame(studies).drop_duplicates("nct_id")
    release = (read_manifest().get("ctgov_studies", {}).get("source_data_timestamp") or "")[:7]
    cutoff = f"{int(release[:4]) - 1}{release[4:7]}" if release else "0000-00"
    nn = lambda col: [None if pd.isna(v) else float(v) for v in sdf[col]]  # noqa: E731
    sdf["lenses"] = [C.study_lenses(list(p), mn, mx, list(a), v, cutoff) for p, mn, mx, a, v in
                     zip(sdf.phases, nn("min_age_years"), nn("max_age_years"), sdf.std_ages, sdf.status_verified_date)]
    site_df = pd.DataFrame(sites)
    n_sites_raw = len(site_df)
    out_of_scope = site_df.usps.isna()
    site_df = site_df[~out_of_scope]
    if s.pilot_state_list:
        site_df = site_df[site_df.usps.isin(s.pilot_state_list)]
        sdf = sdf[sdf.nct_id.isin(site_df.nct_id)]
    site_df = geocode_sites(site_df, load_zcta())
    fac, study_site = build_facilities(site_df)
    study_site = study_site.merge(sdf[["nct_id", "overall_status"]], on="nct_id")
    study_site["is_recruiting_site"] = [
        site_is_recruiting(a, b) for a, b in zip(study_site.overall_status, study_site.site_status)]
    study_site = study_site.drop(columns=["overall_status"])
    st = s.staging_dir
    st.mkdir(parents=True, exist_ok=True)
    sdf.to_parquet(st / "study.parquet", index=False)
    fac.to_parquet(st / "facility.parquet", index=False)
    study_site.to_parquet(st / "study_site.parquet", index=False)
    return {
        "studies": len(sdf), "us_site_records_raw": n_sites_raw,
        "site_records_outside_50_states_dc": int(out_of_scope.sum()),
        "facilities": len(fac), "study_site_links": len(study_site),
        "geocode_method_counts": fac.geocode_method.value_counts().to_dict(),
        "oncology_basis_counts": sdf.oncology_basis.value_counts().to_dict(),
    }


# ---------------------------------------------------------------- Census reference


def load_zcta() -> pd.DataFrame:
    z = zipfile.ZipFile(get_settings().raw_dir / "geo" / "2023_Gaz_zcta_national.zip")
    df = pd.read_csv(z.open(z.namelist()[0]), sep="\t", dtype={"GEOID": str})
    df.columns = [c.strip() for c in df.columns]
    return df.rename(columns={"GEOID": "zip5", "INTPTLAT": "lat", "INTPTLONG": "lon"})[["zip5", "lat", "lon"]]


def transform_tracts() -> dict:
    s = get_settings()
    df = pd.read_csv(s.raw_dir / "geo" / "CenPop2020_Mean_TR.txt", dtype=str, encoding="utf-8-sig")
    df = df[df.STATEFP.isin(FIPS_TO_USPS)]
    if s.pilot_state_list:
        df = df[df.STATEFP.map(FIPS_TO_USPS).isin(s.pilot_state_list)]
    out = pd.DataFrame({
        "geoid": df.STATEFP + df.COUNTYFP + df.TRACTCE,
        "state_fips": df.STATEFP,
        "pop_2020": df.POPULATION.astype(int),
        "lat": df.LATITUDE.astype(float),
        "lon": df.LONGITUDE.astype(float),
    })
    out.to_parquet(s.staging_dir / "tract_center.parquet", index=False)
    return {"tracts": len(out), "tract_pop_2020": int(out.pop_2020.sum())}


def transform_rucc() -> dict:
    s = get_settings()
    df = pd.read_csv(s.raw_dir / "geo" / "rucc_2023.csv", dtype=str, encoding="latin-1")
    wide = df.pivot(index="FIPS", columns="Attribute", values="Value").reset_index()
    out = pd.DataFrame({
        "fips": wide.FIPS.str.zfill(5),
        "rucc_2023": pd.to_numeric(wide.RUCC_2023, errors="coerce").astype("Int64"),
        "rucc_description": wide.Description,
    })
    out.to_parquet(s.staging_dir / "rucc.parquet", index=False)
    return {"rucc_rows": len(out)}


# ---------------------------------------------------------------- ACS

# Census "jam values": negative sentinels that mean an estimate could not be published.
ACS_JAM = {-666666666: "too_few_sample_cases", -999999999: "not_applicable", -888888888: "not_available",
           -222222222: "moe_not_computable", -333333333: "moe_open_ended_median", -555555555: "controlled_estimate"}


def moe_sum(moes: np.ndarray) -> np.ndarray:
    """MOE of a sum of estimates (Census ACS handbook, ch. 8): sqrt(sum of squared MOEs)."""
    return np.sqrt(np.nansum(np.square(moes), axis=0))


def moe_proportion(num, den, moe_num, moe_den):
    """MOE of a proportion p=num/den where num is a subset of den (ACS handbook, ch. 8).
    Falls back to the ratio formula when the radicand is negative."""
    with np.errstate(divide="ignore", invalid="ignore"):
        p = num / den
        rad = moe_num**2 - (p**2) * moe_den**2
        rad = np.where(rad < 0, moe_num**2 + (p**2) * moe_den**2, rad)
        return np.sqrt(rad) / den


def _cells(table: str, idx: list[int], kind: str) -> list[str]:
    return [f"{table}_{kind}{i:03d}" for i in idx]


# indicator_id -> spec. kind 'direct' = single published cell; 'share' = 100 * sum(num)/den.
ACS_INDICATORS: dict[str, dict] = {
    "acs_total_pop": dict(kind="direct", table="B01003", cell=1, unit="people", label="Total population",
                          universe="Total population", direction="context"),
    "acs_median_age": dict(kind="direct", table="B01002", cell=1, unit="years", label="Median age",
                           universe="Total population", direction="context"),
    "acs_median_hh_income": dict(kind="direct", table="B19013", cell=1, unit="USD", label="Median household income",
                                 universe="Households", direction="lower_is_more_barrier",
                                 limitations="Inflation-adjusted to the final year of the 5-year period. Top-coded at $250,000+."),
    "acs_pct_65_plus": dict(kind="share", table="B01001", num=[*range(20, 26), *range(44, 50)], den=1, unit="%",
                            label="Population aged 65+", universe="Total population", direction="context"),
    "acs_pct_poverty": dict(kind="share", table="B17001", num=[2], den=1, unit="%", label="People below poverty level",
                            universe="Population for whom poverty status is determined", direction="higher_is_more_barrier"),
    "acs_pct_uninsured": dict(kind="share", table="B27010", num=[17, 33, 50, 66], den=1, unit="%",
                              label="People without health insurance",
                              universe="Civilian noninstitutionalized population", direction="higher_is_more_barrier"),
    "acs_pct_no_vehicle_hh": dict(kind="share", table="B08201", num=[2], den=1, unit="%",
                                  label="Households with no vehicle available", universe="Households",
                                  direction="higher_is_more_barrier"),
    "acs_pct_no_internet_hh": dict(kind="share", table="B28002", num=[13], den=1, unit="%",
                                   label="Households with no internet access", universe="Households",
                                   direction="higher_is_more_barrier"),
    "acs_pct_people_of_color": dict(kind="share_complement", table="B03002", num=[3], den=1, unit="%",
                                    label="People of color (not non-Hispanic White alone)",
                                    universe="Total population", direction="context"),
}


def read_acs_table(table: str) -> pd.DataFrame:
    s = get_settings()
    df = pd.read_csv(s.raw_dir / "acs" / f"acs5_{s.acs_year}_{table.lower()}_county.dat", sep="|", dtype={"GEO_ID": str})
    df.index = pd.Index(df.GEO_ID.str[-5:], name="fips")
    return df[df.index.str[:2].isin(list(FIPS_TO_USPS))].drop(columns=["GEO_ID"])


def compute_acs_indicator(spec: dict, t: pd.DataFrame) -> pd.DataFrame:
    """Return value/moe/missing_reason per county for one indicator spec."""
    tb = spec["table"]

    def est(i):  # estimates with jam values -> NaN
        v = t[f"{tb}_E{i:03d}"].astype(float)
        return v.where(v > -100000000)

    def moe(i):
        v = t[f"{tb}_M{i:03d}"].astype(float)
        return v.mask(v == -555555555, 0.0).where(lambda x: x > -100000000)

    reason = pd.Series([None] * len(t), index=t.index, dtype=object)
    if spec["kind"] == "direct":
        raw = t[f"{tb}_E{spec['cell']:03d}"]
        value, m = est(spec["cell"]), moe(spec["cell"])
        reason[value.isna()] = raw[value.isna()].map(lambda x: ACS_JAM.get(int(x), "missing_in_source"))
    else:
        num = sum(est(i) for i in spec["num"])
        den = est(spec["den"])
        mnum = pd.Series(moe_sum(np.vstack([moe(i).values for i in spec["num"]])), index=t.index)
        with np.errstate(divide="ignore", invalid="ignore"):
            p = (num / den).where(den > 0)
        m = pd.Series(moe_proportion(num.values, den.values, mnum.values, moe(spec["den"]).values), index=t.index) * 100
        value = (1 - p) * 100 if spec["kind"] == "share_complement" else p * 100
        m = m.where(value.notna())
        reason[(den == 0)] = "zero_denominator"
        reason[value.isna() & reason.isna()] = "component_estimate_not_published"
    return pd.DataFrame({"value": value, "moe": m, "missing_reason": reason})


def acs_formula(spec: dict) -> str:
    tb = spec["table"]
    if spec["kind"] == "direct":
        return f"{tb}_E{spec['cell']:03d}"
    num = " + ".join(_cells(tb, spec["num"], "E"))
    den = f"{tb}_E{spec['den']:03d}"
    return f"100 * (1 - ({num}) / {den})" if spec["kind"] == "share_complement" else f"100 * ({num}) / {den}"


def transform_acs() -> dict:
    s = get_settings()
    vint = f"{s.acs_year - 4}-{s.acs_year}"
    tables: dict[str, pd.DataFrame] = {}
    values, defs = [], []
    for ind, spec in ACS_INDICATORS.items():
        t = tables.setdefault(spec["table"], read_acs_table(spec["table"]))
        r = compute_acs_indicator(spec, t).reset_index()
        r["indicator_id"] = ind
        values.append(r)
        defs.append({
            "indicator_id": ind, "source_key": f"acs5_{spec['table'].lower()}", "label": spec["label"],
            "definition": f"{spec['label']} - ACS {vint} 5-year estimate, table {spec['table']} "
                          f"({acs_src.TABLES[spec['table']]}).",
            "universe": spec["universe"], "unit": spec["unit"], "grain": "county", "vintage": f"{vint} (5-year)",
            "value_type": "survey estimate" if spec["kind"] == "direct" else "derived share of survey estimates",
            "formula": acs_formula(spec), "direction": spec["direction"],
            "uncertainty": "90% margin of error" + ("" if spec["kind"] == "direct"
                                                    else " (derived with Census ACS handbook formulas)"),
            "limitations": spec.get("limitations", "") or
                           "5-year period estimate, not a point-in-time value; small counties have wide margins of error.",
        })
    out = pd.concat(values, ignore_index=True)
    out["ci_low"] = np.nan
    out["ci_high"] = np.nan
    out.to_parquet(s.staging_dir / "indicator_acs.parquet", index=False)
    pd.DataFrame(defs).to_parquet(s.staging_dir / "indicator_def_acs.parquet", index=False)
    return {"acs_values": len(out), "acs_missing": int(out.value.isna().sum())}


# ---------------------------------------------------------------- CDC PLACES

PLACES_DIRECTION = {"CANCER": "context", "CSMOKING": "context", "MAMMOUSE": "context", "COLON_SCREEN": "context",
                    "ACCESS2": "higher_is_more_barrier", "CHECKUP": "context", "LACKTRPT": "higher_is_more_barrier",
                    "GHLTH": "context"}
_TYPE = {"CrdPrv": "crude", "AgeAdjPrv": "aa"}


def transform_places() -> dict:
    s = get_settings()
    rows = json.loads((s.raw_dir / "places" / f"places_county_{places_src.DATASET_ID}.json").read_text())
    df = pd.DataFrame(rows)
    df = df[df.locationid.str.len() == 5]
    df = df[df.locationid.str[:2].isin(FIPS_TO_USPS) & df.datavaluetypeid.isin(_TYPE)]
    df["indicator_id"] = "places_" + df.measureid.str.lower() + "_" + df.datavaluetypeid.map(_TYPE)
    num = lambda c: pd.to_numeric(df.get(c), errors="coerce")  # noqa: E731
    out = pd.DataFrame({
        "fips": df.locationid, "indicator_id": df.indicator_id, "value": num("data_value"), "moe": np.nan,
        "ci_low": num("low_confidence_limit"), "ci_high": num("high_confidence_limit"),
    })
    foot = df.get("data_value_footnote")
    out["missing_reason"] = np.where(out.value.isna(), foot.fillna("suppressed_or_missing_in_source") if foot is not None
                                     else "suppressed_or_missing_in_source", None)
    out.to_parquet(s.staging_dir / "indicator_places.parquet", index=False)
    defs = []
    for (ind, mid, tid), g in df.groupby(["indicator_id", "measureid", "datavaluetypeid"]):
        kind = "Crude prevalence" if tid == "CrdPrv" else "Age-adjusted prevalence"
        yrs = "/".join(sorted(g.year.unique()))
        defs.append({
            "indicator_id": ind, "source_key": "cdc_places_county",
            "label": f"{g.short_question_text.iat[0]} ({'crude' if tid == 'CrdPrv' else 'age-adjusted'})",
            "definition": f"{g.measure.iat[0]}. {kind}. Relevance: {places_src.MEASURES[mid]}.",
            "universe": "Adults (see measure definition for age range)", "unit": "%", "grain": "county",
            "vintage": f"BRFSS {yrs} (PLACES 2025 release)", "value_type": "model-based small-area estimate",
            "formula": f"PLACES measureid={mid}, datavaluetypeid={tid}", "direction": PLACES_DIRECTION[mid],
            "uncertainty": "95% confidence interval from CDC",
            "limitations": "Model-based estimate from BRFSS survey responses using multilevel regression and "
                           "poststratification; not a count of diagnosed patients, not cancer incidence, and not a "
                           "measure of clinical-trial demand. Counties in states without usable BRFSS data for the "
                           "year are absent.",
        })
    pd.DataFrame(defs).to_parquet(s.staging_dir / "indicator_def_places.parquet", index=False)
    return {"places_values": len(out), "places_missing": int(out.value.isna().sum())}


def run_all() -> dict:
    summary = {}
    for fn in (transform_ctgov, transform_tracts, transform_rucc, transform_acs, transform_places):
        print(f"  {fn.__name__}", flush=True)
        summary.update(fn())
    (get_settings().staging_dir / "transform_summary.json").write_text(json.dumps(summary, indent=2, default=str))
    return summary
