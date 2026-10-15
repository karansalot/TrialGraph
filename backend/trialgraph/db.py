from __future__ import annotations

from functools import lru_cache

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine

from .config import get_settings


@lru_cache
def get_engine() -> Engine:
    return create_engine(get_settings().database_url, pool_pre_ping=True, future=True)


@lru_cache
def get_read_engine() -> Engine:
    """Engine the API serves requests with. Uses TG_API_DATABASE_URL (a read-only role) when set, so a bug in
    request handling can never modify data; the pipeline keeps using the owner connection from get_engine()."""
    url = get_settings().api_database_url
    return create_engine(url, pool_pre_ping=True, future=True) if url else get_engine()


def fetch_all(sql: str, **params) -> list[dict]:
    with get_read_engine().connect() as c:
        return [dict(r._mapping) for r in c.execute(text(sql), params)]


def fetch_one(sql: str, **params) -> dict | None:
    rows = fetch_all(sql, **params)
    return rows[0] if rows else None
