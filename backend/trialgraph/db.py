from __future__ import annotations

from functools import lru_cache

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine

from .config import get_settings


@lru_cache
def get_engine() -> Engine:
    return create_engine(get_settings().database_url, pool_pre_ping=True, future=True)


def fetch_all(sql: str, **params) -> list[dict]:
    with get_engine().connect() as c:
        return [dict(r._mapping) for r in c.execute(text(sql), params)]


def fetch_one(sql: str, **params) -> dict | None:
    rows = fetch_all(sql, **params)
    return rows[0] if rows else None
