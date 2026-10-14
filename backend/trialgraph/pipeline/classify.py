"""Transparent, rule-based classification of ClinicalTrials.gov records.

Nothing here is a model: every rule is a readable regular expression so that a reviewer can
see exactly why a study was (or was not) counted in a category.
"""
from __future__ import annotations

import re

# --- status ---------------------------------------------------------------------------------
STATUS_GROUP = {
    "RECRUITING": "recruiting",
    "NOT_YET_RECRUITING": "not_yet_recruiting",
    "ENROLLING_BY_INVITATION": "enrolling_by_invitation",
    "ACTIVE_NOT_RECRUITING": "active_not_recruiting",
    "COMPLETED": "completed",
    "UNKNOWN": "unknown",
}
STATUS_LABEL = {
    "recruiting": "Recruiting",
    "not_yet_recruiting": "Not yet recruiting",
    "enrolling_by_invitation": "Enrolling by invitation",
    "active_not_recruiting": "Active, not recruiting",
    "completed": "Completed",
    "unknown": "Unknown status",
}

# --- oncology determination -----------------------------------------------------------------
_CANCER_TEXT = re.compile(
    r"cancer|neoplas|tumou?r|carcinoma|leuk[a]?emia|lymphoma|sarcoma|melanoma|myeloma|glioma|"
    r"glioblastoma|blastoma|malignan|metasta|myelodysplas|myeloproliferat|lymphoproliferat|mesothelioma|oncolog",
    re.I,
)


def oncology_basis(conditions: list[str], mesh_terms: list[str]) -> str:
    """Why we consider a study oncology-related.

    'mesh'            NLM-assigned MeSH condition term or ancestor is in the Neoplasms tree
    'condition_text'  no neoplasm MeSH term, but a sponsor-entered condition names a cancer
    'not_oncology'    matched the broad retrieval query only via title/keywords; excluded from analysis
    """
    if any("neoplasm" in t.lower() for t in mesh_terms):
        return "mesh"
    if any(_CANCER_TEXT.search(c or "") for c in conditions):
        return "condition_text"
    return "not_oncology"


# --- cancer categories ----------------------------------------------------------------------
# Applied to the lower-cased concatenation of sponsor-entered conditions and MeSH condition terms
# (NOT ancestors, titles or keywords). A study can belong to several categories.
_CA = r"(?:cancer|neoplasm|carcinoma|adenocarcinoma|tumou?r|malignan)"
CATEGORY_RULES: dict[str, tuple[str, str]] = {
    "breast": ("Breast", r"\bbreast\b"),
    "lung": ("Lung", rf"\blung {_CA}|{_CA}s? of (?:the )?lung|non[- ]small[- ]cell|small[- ]cell lung|\bn?sclc\b|bronchogenic"),
    "prostate": ("Prostate", r"prostat"),
    "colorectal": ("Colorectal", r"colorectal|\bcolon\b|\bcolonic\b|\brectal\b|\brectum\b"),
    "hematologic": ("Hematologic", r"leuk[a]?emia|lymphoma|myeloma|myelodysplas|myeloproliferat|lymphoproliferat|waldenstr|h[a]?ematolog\w* (?:malignan|neoplasm|cancer)"),
    "melanoma_skin": ("Melanoma & skin", rf"melanoma|\bskin {_CA}|basal cell|merkel cell|cutaneous squamous"),
    "pancreatic": ("Pancreatic", r"pancrea"),
    "brain_cns": ("Brain & CNS", rf"glioma|glioblastoma|astrocytoma|medulloblastoma|meningioma|ependymoma|\bbrain {_CA}|brain metasta|central nervous system"),
    "gynecologic": ("Gynecologic", rf"ovar|fallopian|endometri|uterine|\buterus\b|cervical {_CA}|cervical intraepithelial|\bcervix\b|vulvar|vaginal {_CA}|gyn[a]?ecolog"),
    "head_neck": ("Head & neck", r"head and neck|oropharyn|laryn|nasopharyn|hypopharyn|oral cavity|\bmouth neoplasm|\btongue\b|salivary"),
    "genitourinary": ("Bladder & kidney", rf"bladder|urothelial|renal cell|\b(?:kidney|renal) {_CA}"),
    "liver_biliary": ("Liver & biliary", rf"hepatocellular|\bliver {_CA}|cholangiocarcinoma|biliary tract|bile duct|gallbladder"),
    "gastroesophageal": ("Stomach & esophagus", r"gastric|\bstomach\b|esophag|oesophag|gastroesophageal"),
    "sarcoma": ("Sarcoma", r"sarcoma"),
}
_COMPILED = {k: re.compile(v[1], re.I) for k, v in CATEGORY_RULES.items()}
# --- trial-type lenses -----------------------------------------------------------------------
# Lenses cut across cancer types. They are stored on each study (study.lenses) and handled exactly
# like cancer categories everywhere downstream, so every page, map and simulator can use them.
LENS_RULES: dict[str, tuple[str, str]] = {
    "lens_phase1": ("Early-phase (Phase 1) trials", "phases include EARLY_PHASE1 or PHASE1"),
    "lens_phase3": ("Phase 3 trials", "phases include PHASE3"),
    "lens_age75": ("Trials open to adults 75+", "no maximum age, or maximum age >= 75 years"),
    "lens_pediatric": ("Trials open to children", "registry standard age groups include CHILD (under 18)"),
    "lens_verified": ("Recruitment verified in last 12 months",
                      "sponsor verified the record's status within 12 months of the registry data release"),
}
CATEGORY_LABEL = {"all": "All oncology", **{k: v[0] for k, v in CATEGORY_RULES.items()},
                  **{k: v[0] for k, v in LENS_RULES.items()}}


def study_lenses(phases: list[str], min_age: float | None, max_age: float | None, std_ages: list[str],
                 status_verified: str | None, verified_cutoff: str) -> list[str]:
    """`verified_cutoff` is a 'YYYY-MM' month: the registry release month minus 12 months."""
    ph = set(phases or [])
    out = []
    if ph & {"EARLY_PHASE1", "PHASE1"}:
        out.append("lens_phase1")
    if "PHASE3" in ph:
        out.append("lens_phase3")
    if max_age is None or max_age >= 75:
        out.append("lens_age75")
    if "CHILD" in (std_ages or []):
        out.append("lens_pediatric")
    if isinstance(status_verified, str) and status_verified[:7] >= verified_cutoff:
        out.append("lens_verified")
    return out


def cancer_categories(conditions: list[str], mesh_terms: list[str]) -> list[str]:
    text = " ; ".join([*(conditions or []), *(mesh_terms or [])]).lower()
    return [k for k, rx in _COMPILED.items() if rx.search(text)]


# --- facility normalisation -----------------------------------------------------------------
_PLACEHOLDER = re.compile(
    r"\b(?:investigational|investigative|investigator|research|study|trial|clinical trials?|clinical) sites?\b"
    r"|^local institution|^site reference id|^for additional information|^call\b|^site\b|^sites?\s*[#:\d]"
    r"|^(?:research|clinical|study|medical) (?:facility|institution)\b|^\W*$",
    re.I,
)
_PUNCT = re.compile(r"[^a-z0-9 ]+")
_WS = re.compile(r"\s+")


def normalize_name(name: str | None) -> str:
    """Lower-case, strip punctuation / leading 'the', collapse whitespace. Conservative on purpose:
    we only merge records whose normalised name AND city AND state AND ZIP5 are identical."""
    name = name if isinstance(name, str) else ""
    n = _PUNCT.sub(" ", name.lower().replace("&", " and "))
    n = _WS.sub(" ", n).strip()
    return n[4:] if n.startswith("the ") else n


def is_placeholder_name(name: str | None) -> bool:
    """Sponsor-anonymised site names such as 'Research Site' or 'GSK Investigational Site'."""
    return not isinstance(name, str) or not name.strip() or bool(_PLACEHOLDER.search(name.strip()))


_AGE = re.compile(r"(\d+(?:\.\d+)?)\s*(year|month|week|day|hour|minute)", re.I)
_AGE_DIV = {"year": 1, "month": 12, "week": 52.1429, "day": 365.25, "hour": 8766, "minute": 525960}


def age_years(s: str | None) -> float | None:
    m = _AGE.search(s if isinstance(s, str) else "")
    return round(float(m.group(1)) / _AGE_DIV[m.group(2).lower()], 3) if m else None
