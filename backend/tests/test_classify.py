import pytest

from trialgraph.pipeline import classify as C
from trialgraph.pipeline.transform import parse_study, site_is_recruiting


@pytest.mark.parametrize("conditions,mesh,expected", [
    (["Breast Cancer"], ["Breast Neoplasms", "Neoplasms"], "mesh"),
    (["Relapsed Multiple Myeloma"], [], "condition_text"),
    (["Hypertension"], ["Hypertension", "Vascular Diseases"], "not_oncology"),
    ([], [], "not_oncology"),
])
def test_oncology_basis(conditions, mesh, expected):
    assert C.oncology_basis(conditions, mesh) == expected


@pytest.mark.parametrize("conditions,mesh,must,must_not", [
    (["Non-Small Cell Lung Cancer"], ["Carcinoma, Non-Small-Cell Lung"], {"lung"}, {"breast"}),
    (["Triple Negative Breast Cancer"], [], {"breast"}, {"lung"}),
    (["Acute Myeloid Leukemia"], ["Leukemia, Myeloid, Acute"], {"hematologic"}, {"sarcoma"}),
    (["Cervical Cancer"], [], {"gynecologic"}, {"head_neck"}),
    (["Cervical Spine Pain in Cancer Survivors"], [], set(), {"gynecologic"}),
    (["Glioblastoma"], ["Glioblastoma"], {"brain_cns"}, set()),
    (["Hepatocellular Carcinoma"], [], {"liver_biliary"}, {"genitourinary"}),
    (["Renal Cell Carcinoma", "Urothelial Carcinoma"], [], {"genitourinary"}, set()),
    (["Colon Cancer", "Rectal Cancer"], [], {"colorectal"}, set()),
    (["Ewing Sarcoma"], [], {"sarcoma"}, set()),
])
def test_cancer_categories(conditions, mesh, must, must_not):
    got = set(C.cancer_categories(conditions, mesh))
    assert must <= got
    assert not (must_not & got)


@pytest.mark.parametrize("name,expected", [
    ("Research Site", True), ("GSK Investigational Site", True), ("Novartis Investigative Site", True),
    ("Local Institution - 0012", True), ("Site Reference ID/Investigator# 1234", True), (None, True), ("", True),
    ("Memorial Sloan Kettering Cancer Center", False), ("Center for Cancer Therapy at LaPorte Hospital", False),
    ("Duke University Medical Center", False), ("Clinical Research Center of Nevada", False),
])
def test_placeholder_names(name, expected):
    assert C.is_placeholder_name(name) is expected


def test_normalize_name_is_conservative():
    assert C.normalize_name("The University of Texas M.D. Anderson Cancer Center") == "university of texas m d anderson cancer center"
    assert C.normalize_name("Dana-Farber  Cancer Institute") == C.normalize_name("dana farber cancer institute")
    assert C.normalize_name(float("nan")) == ""


@pytest.mark.parametrize("s,expected", [("18 Years", 18), ("6 Months", 0.5), (None, None), ("N/A", None)])
def test_age_years(s, expected):
    assert C.age_years(s) == expected


def test_site_is_recruiting_requires_both_levels():
    assert site_is_recruiting("RECRUITING", "RECRUITING")
    assert not site_is_recruiting("RECRUITING", "COMPLETED")
    assert not site_is_recruiting("RECRUITING", None)
    assert not site_is_recruiting("COMPLETED", "RECRUITING")
    assert not site_is_recruiting("ACTIVE_NOT_RECRUITING", "RECRUITING")
    assert not site_is_recruiting("UNKNOWN", "RECRUITING")


def test_parse_real_records(ctgov_sample):
    """Parser contract against verbatim ClinicalTrials.gov API v2 payloads."""
    assert len(ctgov_sample) >= 5
    statuses = set()
    for raw in ctgov_sample:
        study, sites = parse_study(raw)
        assert study["nct_id"].startswith("NCT") and len(study["nct_id"]) == 11
        assert study["status_group"] in C.STATUS_LABEL
        assert study["oncology_basis"] in {"mesh", "condition_text", "not_oncology"}
        assert isinstance(study["cancer_categories"], list)
        statuses.add(study["status_group"])
        for s in sites:
            assert s["nct_id"] == study["nct_id"]
            assert s["zip5"] is None or (len(s["zip5"]) == 5 and s["zip5"].isdigit())
    assert len(statuses) >= 4, "fixture should span several recruitment statuses"


def test_known_record_fields(ctgov_sample):
    raw = next(r for r in ctgov_sample if r["protocolSection"]["identificationModule"]["nctId"] == "NCT03394365")
    study, sites = parse_study(raw)
    assert study["overall_status"] == raw["protocolSection"]["statusModule"]["overallStatus"]
    assert study["lead_sponsor"] == "Pierre Fabre Medicament"
    assert "hematologic" in study["cancer_categories"] or study["oncology_basis"] != "not_oncology"
    assert all(s["usps"] for s in sites)


@pytest.mark.parametrize("phases,mn,mx,ages,verified,expect,absent", [
    (["PHASE1", "PHASE2"], 18, None, ["ADULT", "OLDER_ADULT"], "2026-09", {"lens_phase1", "lens_age75", "lens_verified"}, {"lens_phase3", "lens_pediatric"}),
    (["EARLY_PHASE1"], 18, 70, ["ADULT"], "2024-01", {"lens_phase1"}, {"lens_age75", "lens_verified"}),
    (["PHASE3"], 1, 21, ["CHILD", "ADULT"], "2025-10", {"lens_phase3", "lens_pediatric", "lens_verified"}, {"lens_age75"}),
    ([], None, 75, [], None, {"lens_age75"}, {"lens_verified", "lens_phase1"}),
])
def test_study_lenses(phases, mn, mx, ages, verified, expect, absent):
    got = set(C.study_lenses(phases, mn, mx, ages, verified, "2025-10"))
    assert expect <= got and not (absent & got)
