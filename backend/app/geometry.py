"""STL loading, unit scaling, centering, yaw rotation, bbox and frontal area."""
from __future__ import annotations

import math

import numpy as np
import trimesh

UNIT_SCALE = {"mm": 0.001, "cm": 0.01, "m": 1.0, "in": 0.0254}


def prepare_stl(stl_path: str, unit: str, yaw_deg: float, out_path: str,
                pitch_deg: float = 0.0, roll_deg: float = 0.0) -> dict:
    """Load an STL, scale to meters, center bbox at origin, rotate the model
    (roll about X, then pitch about Y, then -yaw about Z; wind stays along +X),
    save a binary STL at out_path. Positive pitch = nose-down (forward-flight
    tilt). Returns model metadata (SI units)."""
    scale = UNIT_SCALE[unit]
    mesh = trimesh.load(stl_path, file_type="stl", force="mesh")
    if mesh.is_empty or len(mesh.faces) == 0:
        raise ValueError("STL contains no triangles")
    # Watertight (closed, manifold) meshes mesh cleanly; open/degenerate ones
    # are the usual cause of cryptic snappyHexMesh failures — flag, don't block.
    watertight = bool(mesh.is_watertight)

    mesh.apply_scale(scale)

    # Center bounding-box center at origin.
    center = mesh.bounds.mean(axis=0)
    c1 = [float(v) for v in center]
    c2 = [0.0, 0.0, 0.0]
    mesh.apply_translation(-center)

    if roll_deg:
        rot = trimesh.transformations.rotation_matrix(
            math.radians(roll_deg), [1, 0, 0], [0, 0, 0]
        )
        mesh.apply_transform(rot)
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
    if roll_deg or pitch_deg or yaw_deg:
        # Re-center after rotation (bbox changes).
        center = mesh.bounds.mean(axis=0)
        c2 = [float(v) for v in center]
        mesh.apply_translation(-center)

    mesh.export(out_path, file_type="stl")  # binary STL

    bbox = mesh.bounds  # (2, 3)
    frontal_area = frontal_area_yz(mesh.triangles, resolution=512)

    sym_error = symmetry_error_y(mesh)

    return {
        "bbox_m": [list(map(float, bbox[0])), list(map(float, bbox[1]))],
        "frontal_area_m2": float(frontal_area),
        "triangles": int(len(mesh.faces)),
        "centroid": [float(c) for c in mesh.bounds.mean(axis=0)],
        "watertight": watertight,
        "symmetry_error": sym_error,
        "symmetric": bool(sym_error < 0.02),
        "_c1": c1,
        "_c2": c2,
    }


def symmetry_error_y(mesh) -> float:
    """Mirror-symmetry error about the X-Z plane (Y=0), normalized by the
    model's Y-extent W. Uses the mesh *vertices*: a body that is mirror-
    symmetric about its centerline has vertices in exact ±Y pairs, so each
    Y-mirrored vertex sits right on top of an original one (distance ~0). We
    report the 90th-percentile nearest-neighbour distance / W, so a missing or
    shifted side (whose mirror lands in empty space) scores high. numpy-only,
    no rtree/scipy. inf for a degenerate (zero-width) model."""
    lo, hi = mesh.bounds
    W = float(hi[1] - lo[1])
    if W <= 0:
        return float("inf")
    V = np.asarray(mesh.vertices, dtype=np.float64)
    if len(V) == 0:
        return float("inf")
    # Reference set (cap huge meshes; density stays high enough for ~0 on a
    # symmetric body). Query = a Y-mirrored subsample.
    ref = V if len(V) <= 20000 else V[np.random.default_rng(0).choice(len(V), 20000, replace=False)]
    q = V if len(V) <= 3000 else V[np.random.default_rng(1).choice(len(V), 3000, replace=False)]
    q = q * np.array([1.0, -1.0, 1.0])
    dmin = np.empty(len(q))
    for i in range(0, len(q), 256):
        chunk = q[i:i + 256]
        d2 = ((chunk[:, None, :] - ref[None, :, :]) ** 2).sum(axis=2)
        dmin[i:i + len(chunk)] = np.sqrt(d2.min(axis=1))
    return float(np.percentile(dmin, 90) / W)


def transform_props(props: list[dict], unit: str, yaw_deg: float,
                    pitch_deg: float, model: dict,
                    roll_deg: float = 0.0) -> list[dict]:
    """Map propeller disk specs given in original STL coordinates into the
    prepared model frame (meters, centered, pitched, yawed) — the same
    transform prepare_stl applies to the mesh. Each prop: {"center": [x,y,z]
    original units, "diameter": original units, "thrust_g": grams}. The thrust
    axis is +Z in the model's own frame (rotates with pitch/yaw).

    Reconstructing the exact two centering shifts prepare_stl used would
    require the mesh; instead we replay it: scale/center/rotate the centers
    with the recorded final bbox center of the *model* as reference. To keep
    this exact, prepare_stl is re-run logic-free here: we recompute both
    centering shifts from the raw mesh bounds passed via `model["_c1"]` /
    `model["_c2"]` recorded during preparation."""
    import numpy as np
    scale = UNIT_SCALE[unit]
    c1 = np.asarray(model["_c1"])
    c2 = np.asarray(model["_c2"])
    rr = trimesh.transformations.rotation_matrix(
        math.radians(roll_deg), [1, 0, 0])[:3, :3]
    rp = trimesh.transformations.rotation_matrix(
        math.radians(pitch_deg), [0, 1, 0])[:3, :3]
    ry = trimesh.transformations.rotation_matrix(
        math.radians(-yaw_deg), [0, 0, 1])[:3, :3]
    # Same order prepare_stl applies to the mesh: roll, then pitch, then yaw.
    rot = ry @ rp @ rr
    out = []
    for p in props:
        c = rot @ (np.asarray(p["center"], dtype=float) * scale - c1) - c2
        axis = rot @ np.asarray([0.0, 0.0, 1.0])
        out.append({
            "center_m": [float(v) for v in c],
            "axis": [float(v) for v in axis],
            "diameter_m": float(p["diameter"]) * scale,
            "thrust_N": float(p["thrust_g"]) * 9.81 / 1000.0,
        })
    return out


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
