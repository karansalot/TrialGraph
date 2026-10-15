"""Security regression tests: user input must be inert (bound parameters, whitelists, validation)."""
from urllib.parse import quote

import pytest

pytestmark = pytest.mark.db

PAYLOADS = ["'; DROP TABLE study; --", "x' OR '1'='1", "1; SELECT pg_sleep(5)", "\\", "\x00", "%27%20OR%201=1", "../../etc/passwd",
            "<script>alert(1)</script>", "NCT00000000' UNION SELECT 1--"]


def _alive(client):
    return client.get("/api/health").json()["studies"] > 1000


@pytest.mark.parametrize("p", PAYLOADS)
def test_sql_injection_payloads_are_inert(client, p):
    for path, params in [("/api/trials", {"q": p}), ("/api/trials", {"q": "a", "phase": p}), ("/api/trials", {"q": "a", "sort": p}),
                         ("/api/trials", {"status": p}), ("/api/trials", {"state": p}), ("/api/trials", {"category": p}),
                         ("/api/overview", {"state": p}), ("/api/overview", {"category": p}), ("/api/access/counties", {"state": p}),
                         ("/api/access/county/" + quote(p, safe=""), {}), ("/api/trials/" + quote(p, safe=""), {}),
                         ("/api/facilities/" + quote(p, safe=""), {})]:
        r = client.get(path, params=params)
        assert r.status_code in (200, 404, 405, 422), (path, params, r.status_code)
        assert not any(t in r.text for t in ("Traceback", "psycopg", "sqlalchemy", "syntax error", 'relation "')), "internal error details must not leak"
    assert _alive(client)


def test_post_inputs_validated(client):
    base = {"category": "all", "threshold_mi": 50}
    for bad in [{**base, "category": "x'; DROP TABLE study;--"}, {**base, "state": "ZZ"}, {**base, "threshold_mi": -1},
                {**base, "threshold_mi": 1e9}, {**base, "sites": [{"lat": 999, "lon": 0}]}, {**base, "sites": [{"lat": "a", "lon": 0}]},
                {**base, "sites": [{"lat": 40, "lon": -100}] * 500}, {**base, "k": 10_000}]:
        r = client.post("/api/simulator/simulate" if "sites" in bad else "/api/simulator/plan", json=bad)
        assert r.status_code == 422, bad
    assert _alive(client)


def test_security_headers_and_cors(client):
    r = client.get("/api/health", headers={"Origin": "https://evil.example"})
    assert r.headers["x-content-type-options"] == "nosniff" and r.headers["referrer-policy"] == "no-referrer"
    assert "access-control-allow-origin" not in r.headers, "unlisted origins must not be granted CORS"
    ok = client.get("/api/health", headers={"Origin": "http://localhost:3010"})
    assert ok.headers.get("access-control-allow-origin") == "http://localhost:3010"
    pre = client.options("/api/health", headers={"Origin": "http://localhost:3010", "Access-Control-Request-Method": "DELETE"})
    assert "DELETE" not in pre.headers.get("access-control-allow-methods", "")


def test_heavy_endpoint_concurrency_cap(client, monkeypatch):
    from trialgraph.api import main
    slots = [main._heavy_slots.acquire(blocking=False) for _ in range(10)]
    try:
        r = client.post("/api/simulator/candidates", json={"category": "all", "threshold_mi": 50})
        assert r.status_code == 429 and r.headers["retry-after"]
        assert client.get("/api/health").status_code == 200, "cheap endpoints stay available under load"
    finally:
        for s in slots:
            if s:
                main._heavy_slots.release()
