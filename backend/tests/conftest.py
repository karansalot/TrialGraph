import json
from pathlib import Path

import pytest

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(scope="session")
def ctgov_sample():
    return json.loads((FIXTURES / "ctgov_sample.json").read_text())["studies"]


def _db_ready() -> bool:
    try:
        from trialgraph.db import fetch_one
        return fetch_one("SELECT count(*) AS n FROM tract_access")["n"] > 0
    except Exception:
        return False


@pytest.fixture(scope="session")
def db():
    """Skips DB-backed tests unless a loaded TrialGraph database is reachable."""
    if not _db_ready():
        pytest.skip("TrialGraph database not loaded (run `trialgraph all`)")
    from trialgraph import db as d
    return d


@pytest.fixture(scope="session")
def client(db):
    from fastapi.testclient import TestClient

    from trialgraph.api.main import app
    return TestClient(app)
