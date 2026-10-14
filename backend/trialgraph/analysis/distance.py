"""Great-circle (straight-line) distance primitives.

All distances in TrialGraph are great-circle distances on a sphere of radius 6371.0088 km
(IUGG mean Earth radius). They are NOT driving distances or travel times. Relative to the
WGS-84 ellipsoid the spherical approximation errs by at most ~0.5%; tests cross-check a
sample against PostGIS `ST_Distance(geography, geography)`.
"""
from __future__ import annotations

import numpy as np
from scipy.spatial import cKDTree

EARTH_RADIUS_MI = 6371.0088 / 1.609344  # 3958.7613
MI_PER_M = 1 / 1609.344


def to_unit_xyz(lat, lon) -> np.ndarray:
    lat = np.radians(np.asarray(lat, dtype=float))
    lon = np.radians(np.asarray(lon, dtype=float))
    return np.column_stack([np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)])


def chord_to_miles(chord):
    return 2 * EARTH_RADIUS_MI * np.arcsin(np.clip(np.asarray(chord) / 2, 0, 1))


def miles_to_chord(miles):
    return 2 * np.sin(np.asarray(miles, dtype=float) / EARTH_RADIUS_MI / 2)


def haversine_miles(lat1, lon1, lat2, lon2):
    """Vectorised haversine great-circle distance in statute miles."""
    lat1, lon1, lat2, lon2 = (np.radians(np.asarray(v, dtype=float)) for v in (lat1, lon1, lat2, lon2))
    a = np.sin((lat2 - lat1) / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin((lon2 - lon1) / 2) ** 2
    return 2 * EARTH_RADIUS_MI * np.arcsin(np.sqrt(np.clip(a, 0, 1)))


def nearest(origin_lat, origin_lon, dest_lat, dest_lon) -> tuple[np.ndarray, np.ndarray]:
    """For each origin return (miles to nearest destination, index of that destination).

    Exact nearest neighbour on the sphere: nearest by 3-D chord length is nearest by great circle.
    Returns (inf, -1) for every origin when there are no destinations.
    """
    n = len(np.atleast_1d(origin_lat))
    if len(np.atleast_1d(dest_lat)) == 0:
        return np.full(n, np.inf), np.full(n, -1, dtype=int)
    tree = cKDTree(to_unit_xyz(dest_lat, dest_lon))
    chord, idx = tree.query(to_unit_xyz(origin_lat, origin_lon), k=1)
    return chord_to_miles(chord), idx


def count_within(origin_lat, origin_lon, dest_lat, dest_lon, miles: float) -> np.ndarray:
    """Number of destinations within `miles` of each origin."""
    n = len(np.atleast_1d(origin_lat))
    if len(np.atleast_1d(dest_lat)) == 0:
        return np.zeros(n, dtype=int)
    tree = cKDTree(to_unit_xyz(dest_lat, dest_lon))
    return tree.query_ball_point(to_unit_xyz(origin_lat, origin_lon), r=float(miles_to_chord(miles)),
                                 return_length=True)
