"""STL loading, unit scaling, centering, yaw rotation, bbox and frontal area."""
from __future__ import annotations

import math

import numpy as np
import trimesh

UNIT_SCALE = {"mm": 0.001, "cm": 0.01, "m": 1.0, "in": 0.0254}


def prepare_stl(stl_path: str, unit: str, yaw_deg: float, out_path: str,
                pitch_deg: float = 0.0) -> dict:
    """Load an STL, scale to meters, center bbox at origin, rotate the model
    (pitch about Y, then -yaw about Z; wind stays along +X), save a binary STL
    at out_path. Positive pitch = nose-down (forward-flight tilt).
    Returns model metadata (SI units)."""
    scale = UNIT_SCALE[unit]
    mesh = trimesh.load(stl_path, file_type="stl", force="mesh")
    if mesh.is_empty or len(mesh.faces) == 0:
        raise ValueError("STL contains no triangles")

    mesh.apply_scale(scale)

    # Center bounding-box center at origin.
    center = mesh.bounds.mean(axis=0)
    mesh.apply_translation(-center)

    if pitch_deg:
        rot = trimesh.transformations.rotation_matrix(
            math.radians(pitch_deg), [0, 1, 0], [0, 0, 0]
        )
        mesh.apply_transform(rot)
    if yaw_deg:
        rot = trimesh.transformations.rotation_matrix(
            math.radians(-yaw_deg), [0, 0, 1], [0, 0, 0]
        )
        mesh.apply_transform(rot)
    if pitch_deg or yaw_deg:
        # Re-center after rotation (bbox changes).
        center = mesh.bounds.mean(axis=0)
        mesh.apply_translation(-center)

    mesh.export(out_path, file_type="stl")  # binary STL

    bbox = mesh.bounds  # (2, 3)
    frontal_area = frontal_area_yz(mesh.triangles, resolution=512)

    return {
        "bbox_m": [list(map(float, bbox[0])), list(map(float, bbox[1]))],
        "frontal_area_m2": float(frontal_area),
        "triangles": int(len(mesh.faces)),
        "centroid": [float(c) for c in mesh.bounds.mean(axis=0)],
    }


def frontal_area_yz(triangles: np.ndarray, resolution: int = 512) -> float:
    """Project triangles onto the YZ plane and rasterize to estimate the
    frontal area (as seen by flow along +X). triangles: (n, 3, 3)."""
    # 2D projected triangles: (n, 3, 2) with columns (y, z)
    tri2 = triangles[:, :, 1:3].astype(np.float64)

    lo = tri2.reshape(-1, 2).min(axis=0)
    hi = tri2.reshape(-1, 2).max(axis=0)
    span = hi - lo
    if span[0] <= 0 or span[1] <= 0:
        return 0.0
    # small padding so edge pixels are not clipped
    pad = 1e-9 + span * 1e-6
    lo -= pad
    hi += pad
    span = hi - lo

    cell = span / resolution
    mask = np.zeros((resolution, resolution), dtype=bool)

    # Pixel-center coordinates
    for tri in tri2:
        # Pixel bbox of this triangle
        tmin = np.floor((tri.min(axis=0) - lo) / cell).astype(int)
        tmax = np.ceil((tri.max(axis=0) - lo) / cell).astype(int)
        tmin = np.clip(tmin, 0, resolution - 1)
        tmax = np.clip(tmax, 1, resolution)
        iy = np.arange(tmin[0], tmax[0])
        iz = np.arange(tmin[1], tmax[1])
        if len(iy) == 0 or len(iz) == 0:
            continue
        py = lo[0] + (iy + 0.5) * cell[0]
        pz = lo[1] + (iz + 0.5) * cell[1]
        PY, PZ = np.meshgrid(py, pz, indexing="ij")

        a, b, c = tri[0], tri[1], tri[2]
        d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
        if abs(d) < 1e-30:
            continue
        w1 = ((b[1] - c[1]) * (PY - c[0]) + (c[0] - b[0]) * (PZ - c[1])) / d
        w2 = ((c[1] - a[1]) * (PY - c[0]) + (a[0] - c[0]) * (PZ - c[1])) / d
        w3 = 1.0 - w1 - w2
        eps = -1e-9
        inside = (w1 >= eps) & (w2 >= eps) & (w3 >= eps)
        mask[tmin[0]:tmax[0], tmin[1]:tmax[1]] |= inside

    return float(mask.sum() * cell[0] * cell[1])
