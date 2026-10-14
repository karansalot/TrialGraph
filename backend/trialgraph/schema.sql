-- TrialGraph PostgreSQL / PostGIS schema.
-- Conventions: SRID 4326 everywhere; `geography` for points used in distance math,
-- `geometry` for polygons used in containment joins and map display.
CREATE EXTENSION IF NOT EXISTS postgis;

DROP MATERIALIZED VIEW IF EXISTS county_profile;
DROP TABLE IF EXISTS county_supply, tract_access, study_site, facility, study, county_indicator, indicator,
                     tract_center, county, state, source_dataset, pipeline_run CASCADE;

-- ---------------------------------------------------------------- lineage
CREATE TABLE source_dataset (
    source_key          text PRIMARY KEY,
    source_name         text NOT NULL,
    publisher           text NOT NULL,
    url                 text NOT NULL,
    license             text,
    vintage             text,                 -- period the data describes
    geographic_grain    text,
    retrieved_at        timestamptz NOT NULL, -- when TrialGraph pulled it
    source_updated_at   timestamptz,          -- publisher's own "last updated" stamp, when exposed
    upstream_sha256     text,
    upstream_bytes      bigint,
    row_count           integer,
    params              jsonb,
    notes               text
);

CREATE TABLE pipeline_run (
    run_id       serial PRIMARY KEY,
    started_at   timestamptz NOT NULL,
    finished_at  timestamptz,
    scope        text NOT NULL,               -- 'national' or pilot state list
    summary      jsonb
);

-- ---------------------------------------------------------------- geography
CREATE TABLE state (
    state_fips   char(2) PRIMARY KEY,
    usps         char(2) UNIQUE NOT NULL,
    name         text NOT NULL,
    geom_display geometry(MultiPolygon, 4326)
);

CREATE TABLE county (
    fips            char(5) PRIMARY KEY,
    state_fips      char(2) NOT NULL REFERENCES state,
    usps            char(2) NOT NULL,
    name            text NOT NULL,              -- e.g. 'Wake County'
    land_sqmi       double precision,
    geom            geometry(MultiPolygon, 4326) NOT NULL,   -- 1:5M, used for point-in-polygon
    geom_display    geometry(MultiPolygon, 4326),            -- 1:20M, used for choropleths
    pop_2020        integer,                    -- sum of 2020 Census tract populations assigned to the county
    n_tracts        integer,
    pop_centroid    geography(Point, 4326),     -- population-weighted centre computed from tract centres
    rucc_2023       smallint,                   -- USDA ERS Rural-Urban Continuum Code (1-9)
    rucc_description text,
    is_metro        boolean                     -- rucc_2023 <= 3
);
CREATE INDEX county_geom_gix ON county USING gist (geom);
CREATE INDEX county_state_ix ON county (usps);

CREATE TABLE tract_center (
    geoid                 char(11) PRIMARY KEY,   -- 2020 Census tract GEOID
    county_fips           char(5) REFERENCES county,
    county_assign_method  text,                   -- 'contains' | 'nearest_in_state'
    pop_2020              integer NOT NULL,
    geom                  geography(Point, 4326) NOT NULL
);
CREATE INDEX tract_center_gix ON tract_center USING gist (geom);
CREATE INDEX tract_center_county_ix ON tract_center (county_fips);

-- ---------------------------------------------------------------- indicators (long format = self-describing)
CREATE TABLE indicator (
    indicator_id  text PRIMARY KEY,
    source_key    text NOT NULL REFERENCES source_dataset,
    label         text NOT NULL,
    definition    text NOT NULL,
    universe      text,
    unit          text,
    grain         text NOT NULL,
    vintage       text,
    value_type    text,          -- survey estimate | derived share | model-based estimate
    formula       text,          -- exact source cells / measure ids
    direction     text,          -- higher_is_more_barrier | lower_is_more_barrier | context
    uncertainty   text,
    limitations   text,
    n_counties_with_value integer
);

CREATE TABLE county_indicator (
    fips            char(5) NOT NULL REFERENCES county,
    indicator_id    text NOT NULL REFERENCES indicator,
    value           double precision,     -- NULL when the source did not publish a value (never imputed)
    moe             double precision,     -- ACS 90% margin of error
    ci_low          double precision,     -- PLACES 95% CI
    ci_high         double precision,
    missing_reason  text,
    PRIMARY KEY (fips, indicator_id),
    CHECK (value IS NOT NULL OR missing_reason IS NOT NULL)
);

-- ---------------------------------------------------------------- trials
CREATE TABLE study (
    nct_id                  text PRIMARY KEY CHECK (nct_id ~ '^NCT[0-9]{8}$'),
    brief_title             text,
    overall_status          text NOT NULL,       -- verbatim ClinicalTrials.gov enum
    status_group            text NOT NULL,       -- recruiting | not_yet_recruiting | enrolling_by_invitation | active_not_recruiting | completed | unknown
    status_verified_date    text,
    last_update_posted      date,
    start_date              text,                -- registry dates may be YYYY-MM; kept verbatim
    primary_completion_date text,
    study_type              text,
    phases                  text[],
    enrollment_count        integer,
    enrollment_type         text,                -- ESTIMATED (planned) or ACTUAL; never a capacity measure
    lead_sponsor            text,
    sponsor_class           text,
    conditions              text[],
    mesh_terms              text[],
    interventions           jsonb,
    intervention_types      text[],
    sex                     text,
    min_age_years           double precision,
    max_age_years           double precision,
    std_ages                text[],
    healthy_volunteers      boolean,
    oncology_basis          text NOT NULL,       -- mesh | condition_text | not_oncology
    cancer_categories       text[] NOT NULL DEFAULT '{}',
    lenses                  text[] NOT NULL DEFAULT '{}',   -- trial-type lenses (lens_phase1, lens_age75, ...)
    filter_keys             text[] NOT NULL DEFAULT '{all}', -- 'all' + categories + lenses: the keys every analysis filters on
    search_text             text NOT NULL DEFAULT '',   -- title + conditions + sponsor + NCT id, for full-text search
    source_url              text GENERATED ALWAYS AS ('https://clinicaltrials.gov/study/' || nct_id) STORED
);
CREATE INDEX study_status_ix ON study (status_group);
CREATE INDEX study_cat_gin ON study USING gin (cancer_categories);
CREATE INDEX study_filter_gin ON study USING gin (filter_keys);
CREATE INDEX study_fts ON study USING gin (to_tsvector('english', search_text));

CREATE TABLE facility (
    facility_id          integer PRIMARY KEY,
    name                 text,                 -- most common verbatim spelling
    name_norm            text,
    is_placeholder_name  boolean NOT NULL,     -- sponsor-anonymised ('Research Site')
    city                 text,
    usps                 char(2) NOT NULL,
    zip5                 char(5),
    geom                 geography(Point, 4326),   -- NULL when not geocodable
    geocode_method       text NOT NULL,
    geocode_confidence   text NOT NULL,        -- high | medium | low | none
    zip_city_gap_mi      double precision,     -- QA: ZIP centroid vs registry city point
    county_fips          char(5) REFERENCES county,
    state_mismatch       boolean,              -- coordinate falls in a different state than the registry says
    n_source_records     integer NOT NULL,
    n_name_variants      integer NOT NULL
);
CREATE INDEX facility_gix ON facility USING gist (geom);
CREATE INDEX facility_county_ix ON facility (county_fips);
CREATE INDEX facility_state_ix ON facility (usps);

CREATE TABLE study_site (
    nct_id              text NOT NULL REFERENCES study,
    facility_id         integer NOT NULL REFERENCES facility,
    site_status         text,                  -- verbatim per-site status (often absent on closed studies)
    is_recruiting_site  boolean NOT NULL,      -- study RECRUITING AND site RECRUITING
    facility_raw        text,                  -- verbatim site name on this study
    PRIMARY KEY (nct_id, facility_id)
);
CREATE INDEX study_site_fac_ix ON study_site (facility_id);
CREATE INDEX study_site_recruiting_ix ON study_site (facility_id) WHERE is_recruiting_site;

-- ---------------------------------------------------------------- computed access layer
-- One row per (tract, cancer category): great-circle miles from the tract's 2020 centre of
-- population to the nearest site that is currently recruiting for an interventional oncology
-- study in that category. nearest_mi is NULL only if no such site exists nationally.
CREATE TABLE tract_access (
    geoid               char(11) NOT NULL REFERENCES tract_center,
    category            text NOT NULL,
    nearest_mi          real,
    nearest_facility_id integer REFERENCES facility,
    sites_within_50mi   integer NOT NULL,
    PRIMARY KEY (category, geoid)
);

-- County-level supply counts computed in PostGIS around the county population centroid.
CREATE TABLE county_supply (
    fips                    char(5) NOT NULL REFERENCES county,
    category                text NOT NULL,
    recruiting_sites_in_county   integer NOT NULL,
    recruiting_studies_in_county integer NOT NULL,
    recruiting_studies_50mi      integer NOT NULL,   -- distinct studies with a recruiting site within 50 mi of pop centroid
    PRIMARY KEY (category, fips)
);
