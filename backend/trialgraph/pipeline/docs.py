"""Generate docs/DATA_DICTIONARY.md from the live database so the dictionary cannot drift from the schema."""
from __future__ import annotations

from ..config import REPO_ROOT
from ..db import fetch_all

TABLE_NOTES = {
    "source_dataset": "One row per retrieved source artifact (lineage). Copied from data/raw/manifest.json at load time.",
    "pipeline_run": "One row per load, with scope (national or pilot states) and row-count summary.",
    "state": "50 states + DC. Display geometry only.",
    "county": "2023 counties and county-equivalents (Connecticut = planning regions), with population centre and rurality.",
    "tract_center": "2020 census tracts as population-weighted points - the population surface for all distance work.",
    "indicator": "Definition of every county indicator (the indicator half of this dictionary).",
    "county_indicator": "Indicator values in long format. NULL value always carries a missing_reason; nothing is imputed.",
    "study": "One row per ClinicalTrials.gov study retrieved (all six ingested statuses).",
    "facility": "De-duplicated U.S. trial sites with coordinates and geocoding confidence.",
    "study_site": "Study-to-facility relationship with the site's own recruitment status.",
    "tract_access": "Computed: nearest currently-recruiting analysis site per tract and cancer category.",
    "county_supply": "Computed in PostGIS: recruiting sites/studies in the county and studies within 50 miles of its population centre.",
}


GENERIC = {
    "fips": "5-digit county GEOID (state FIPS + county FIPS)", "state_fips": "2-digit state FIPS code", "usps": "USPS state abbreviation",
    "name": "Name as published by the source", "geoid": "11-digit 2020 census tract GEOID", "nct_id": "ClinicalTrials.gov identifier",
    "facility_id": "TrialGraph surrogate key for a de-duplicated facility", "category": "Cancer category id ('all' or a rule-based category)",
    "indicator_id": "Indicator key (see County indicators)", "source_key": "Key into source_dataset", "land_sqmi": "Land area in square miles (Census ALAND)",
    "n_tracts": "Number of 2020 tracts assigned to the county", "rucc_description": "USDA description of the RUCC code",
    "brief_title": "Registry brief title", "study_type": "INTERVENTIONAL or OBSERVATIONAL", "phases": "Registry phase list",
    "lead_sponsor": "Lead sponsor name", "sponsor_class": "Registry sponsor class (INDUSTRY, NIH, OTHER, ...)", "conditions": "Sponsor-entered conditions",
    "mesh_terms": "NLM-assigned MeSH condition terms", "interventions": "List of {type, name}", "intervention_types": "Distinct intervention types",
    "sex": "Eligible sex (registry metadata)", "min_age_years": "Minimum eligible age in years (parsed)", "max_age_years": "Maximum eligible age in years (parsed)",
    "std_ages": "Registry standard age groups", "healthy_volunteers": "Accepts healthy volunteers (registry metadata)", "enrollment_count": "Study-wide enrollment (never a site capacity)",
    "status_verified_date": "Month the sponsor last verified the record", "last_update_posted": "Date the registry last posted an update",
    "city": "Site city as written in the registry", "zip5": "First five digits of the site ZIP, if valid", "name_norm": "Normalised name used for de-duplication",
    "n_source_records": "Study-site records merged into this facility", "n_name_variants": "Distinct verbatim spellings merged",
    "retrieved_at": "UTC time TrialGraph retrieved the artifact", "url": "Exact URL retrieved", "publisher": "Publishing agency", "license": "Reuse terms",
    "upstream_sha256": "SHA-256 of the complete upstream file / raw pages", "upstream_bytes": "Size of the upstream file", "row_count": "Rows retrieved",
    "params": "Query parameters used", "notes": "Free-text lineage notes", "label": "Display label", "definition": "Plain-language definition",
    "universe": "Population the indicator describes", "unit": "Unit of the value", "grain": "Geographic grain", "limitations": "Known limitations",
    "uncertainty": "How uncertainty is expressed", "missing_reason": "Why the value is NULL", "geocode_method": "How the coordinate was obtained (see methodology)",
    "nearest_mi": "Great-circle miles to the nearest analysis site", "nearest_facility_id": "That site", "sites_within_50mi": "Analysis sites within 50 great-circle miles",
    "recruiting_sites_in_county": "Analysis sites located in the county", "recruiting_studies_in_county": "Distinct studies with an analysis site in the county",
    "source_name": "Dataset name", "run_id": "Surrogate key", "started_at": "Load start (UTC)", "finished_at": "Load end (UTC)", "summary": "Row counts and QA counters",
    "source_url": "Link to the original registry record", "pop_2020": "2020 Census population", "start_date": "Registry start date (verbatim)",
    "primary_completion_date": "Registry primary completion date (verbatim)",
}


def generate() -> str:
    cols = fetch_all("""
        SELECT c.table_name, c.column_name, c.data_type, c.udt_name, c.is_nullable,
               (SELECT count(*) FROM information_schema.key_column_usage k JOIN information_schema.table_constraints t USING (constraint_name, table_name)
                WHERE t.constraint_type = 'PRIMARY KEY' AND k.table_name = c.table_name AND k.column_name = c.column_name) AS pk
        FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = ANY(:t)
        ORDER BY c.table_name, c.ordinal_position""", t=list(TABLE_NOTES))
    counts = {t: fetch_all(f"SELECT count(*) AS n FROM {t}")[0]["n"] for t in TABLE_NOTES}
    ind = fetch_all("SELECT i.*, s.source_name FROM indicator i JOIN source_dataset s USING (source_key) ORDER BY i.source_key, i.indicator_id")
    comments = _column_comments()
    L = ["# TrialGraph data dictionary", "",
         "_Generated by `trialgraph docs` from the live PostGIS database - do not edit by hand._", "",
         "Conventions: SRID 4326; `geography` points for distance, `geometry` polygons for containment and display; "
         "county key is the 5-digit FIPS/GEOID; tract key is the 11-digit 2020 GEOID; study key is the NCT identifier.", "",
         "## Tables", ""]
    for t, note in TABLE_NOTES.items():
        L += [f"### `{t}` - {counts[t]:,} rows", "", note, "", "| Column | Type | Null | Description |", "|---|---|---|---|"]
        for c in (x for x in cols if x["table_name"] == t):
            typ = c["udt_name"] if c["data_type"] in ("USER-DEFINED", "ARRAY") else c["data_type"]
            L.append(f"| `{c['column_name']}`{' **PK**' if c['pk'] else ''} | {typ} | {'yes' if c['is_nullable'] == 'YES' else 'no'} | "
                     f"{comments.get((t, c['column_name'])) or GENERIC.get(c['column_name'], '')} |")
        L.append("")
    L += ["## County indicators", "",
          "| indicator_id | Label | Source | Vintage | Unit | Formula / source cells | Value type | Uncertainty | Counties with value |",
          "|---|---|---|---|---|---|---|---|---|"]
    for i in ind:
        L.append(f"| `{i['indicator_id']}` | {i['label']} | {i['source_name']} | {i['vintage']} | {i['unit']} | `{i['formula']}` | "
                 f"{i['value_type']} | {i['uncertainty']} | {i['n_counties_with_value']:,} |")
    L += ["", "### Indicator definitions and limitations", ""]
    for i in ind:
        L += [f"- **`{i['indicator_id']}`** - {i['definition']} _Universe:_ {i['universe']}. _Limitations:_ {i['limitations']}"]
    return "\n".join(L) + "\n"


def _column_comments() -> dict[tuple[str, str], str]:
    """Column descriptions are the trailing `-- comments` in schema.sql (single source of truth)."""
    import re
    out, table = {}, None
    for line in (REPO_ROOT / "backend" / "trialgraph" / "schema.sql").read_text().splitlines():
        m = re.match(r"CREATE TABLE (\w+)", line)
        if m:
            table = m.group(1)
        elif line.startswith(");"):
            table = None
        elif table and "--" in line:
            col = re.match(r"\s+(\w+)\s", line)
            if col:
                out[(table, col.group(1))] = line.split("--", 1)[1].strip().replace("|", "/")
    return out


def write() -> str:
    p = REPO_ROOT / "docs" / "DATA_DICTIONARY.md"
    p.write_text(generate())
    return str(p)
