"""Cached, auditable downloads.

Every file pulled from a public source is written under data/raw/ and recorded in
data/raw/manifest.json with its URL, retrieval timestamp (UTC), byte size and SHA-256.
The manifest is what the loader copies into the `source_dataset` table, so every metric
in the application can be traced back to a specific retrieved artifact.
"""
from __future__ import annotations

import hashlib
import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterable

import httpx

from ..config import get_settings

USER_AGENT = "TrialGraph/0.1 (portfolio research project; public-data ingestion)"


def _manifest_path() -> Path:
    return get_settings().raw_dir / "manifest.json"


def read_manifest() -> dict:
    p = _manifest_path()
    return json.loads(p.read_text()) if p.exists() else {}


def record(key: str, **meta) -> None:
    m = read_manifest()
    m[key] = {**m.get(key, {}), **meta}
    p = _manifest_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(m, indent=2, sort_keys=True))


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def client() -> httpx.Client:
    return httpx.Client(
        timeout=httpx.Timeout(120.0, connect=30.0),
        headers={"User-Agent": USER_AGENT},
        follow_redirects=True,
    )


def get_with_retry(c: httpx.Client, url: str, params: dict | None = None, tries: int = 5) -> httpx.Response:
    last: Exception | None = None
    for i in range(tries):
        try:
            r = c.get(url, params=params)
            if r.status_code in (429, 500, 502, 503, 504):
                raise httpx.HTTPStatusError(f"retryable {r.status_code}", request=r.request, response=r)
            r.raise_for_status()
            return r
        except (httpx.TransportError, httpx.HTTPStatusError) as e:  # pragma: no cover - network
            last = e
            time.sleep(2**i)
    raise RuntimeError(f"failed after {tries} tries: {url}") from last


def download(
    key: str,
    url: str,
    dest: Path,
    *,
    refresh: bool = False,
    line_filter: Callable[[bytes], bool] | None = None,
    extra: dict | None = None,
) -> Path:
    """Download `url` to `dest` (streamed) and record it in the manifest.

    If `line_filter` is given, only matching lines are kept on disk (used for the very large
    nationwide ACS summary files, where we keep the header and county rows). The SHA-256 and
    byte count recorded are always those of the *complete upstream file*.
    """
    if dest.exists() and not refresh and key in read_manifest():
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    sha = hashlib.sha256()
    n = 0
    tmp = dest.with_suffix(dest.suffix + ".part")
    with client() as c, c.stream("GET", url) as r, tmp.open("wb") as f:
        r.raise_for_status()
        if "missing_key" in str(r.url):
            raise RuntimeError(f"{url} redirected to an API-key page")
        if line_filter is None:
            for chunk in r.iter_bytes(1 << 20):
                sha.update(chunk)
                n += len(chunk)
                f.write(chunk)
        else:
            buf = b""
            first = True
            for chunk in r.iter_bytes(1 << 20):
                sha.update(chunk)
                n += len(chunk)
                buf += chunk
                lines = buf.split(b"\n")
                buf = lines.pop()
                for ln in lines:
                    if first or line_filter(ln):
                        f.write(ln + b"\n")
                    first = False
            if buf and (first or line_filter(buf)):
                f.write(buf + b"\n")
    tmp.replace(dest)
    record(
        key,
        url=url,
        path=str(dest.relative_to(get_settings().data_dir)),
        retrieved_at=utcnow(),
        upstream_sha256=sha.hexdigest(),
        upstream_bytes=n,
        filtered=line_filter is not None,
        **(extra or {}),
    )
    return dest


def sha256_of(paths: Iterable[Path]) -> str:
    h = hashlib.sha256()
    for p in sorted(paths):
        h.update(p.read_bytes())
    return h.hexdigest()
