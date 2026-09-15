"""Build the validation models as STLs (millimeters, flow along +X, up +Z).

    backend/.venv/bin/python examples/validation/make_models.py

- ahmed_25.stl: Ahmed body with a 25° rear slant (Ahmed, Ramm & Faltin 1984,
  SAE 840300): 1044 x 389 x 288 mm, 100 mm radius on the four front edges,
  222 mm long slant. No stilts (see VALIDATION.md).
- sphere_100mm.stl: 100 mm diameter sphere.

The Ahmed body is the intersection of its side profile (extruded across Y) and
its plan profile (extruded along Z). It is meshed from the exact signed
distance of that intersection with marching cubes, so edges are sharp to
within one voxel (PITCH_MM), then decimated without opening the surface.
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np
import trimesh
from shapely.geometry import Point, Polygon
from skimage.measure import marching_cubes, points_in_poly

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent.parent / "backend"))
from app import repair  # noqa: E402

L, W, H, R = 1044.0, 389.0, 288.0, 100.0
SLANT_LEN = 222.0
PITCH_MM = 1.5
TARGET_TRIANGLES = 300_000


def rounded_front_profile(length: float, height: float, radius: float,
                          top_cut: tuple[float, float] | None = None) -> Polygon:
    """2D outline (u along the body, v across it) with both front corners
    rounded. `top_cut` = (u where the cut starts, v at the base) replaces the
    top rear corner with a straight slant."""
    arc = 24
    pts = []
    for i in range(arc + 1):  # bottom-front corner, from 180° to 270°
        a = math.pi + (math.pi / 2) * i / arc
        pts.append((radius + radius * math.cos(a), radius + radius * math.sin(a)))
    pts.append((length, 0.0))
    if top_cut:
        pts += [(length, top_cut[1]), (top_cut[0], height)]
    else:
        pts.append((length, height))
    for i in range(arc + 1):  # top-front corner, from 90° to 180°
        a = math.pi / 2 + (math.pi / 2) * i / arc
        pts.append((radius + radius * math.cos(a), height - radius + radius * math.sin(a)))
    return Polygon(pts)


def signed_distance_2d(poly: Polygon, u: np.ndarray, v: np.ndarray) -> np.ndarray:
    """Exact 2D signed distance to a polygon (negative inside)."""
    ring = np.asarray(poly.exterior.coords)
    a, b = ring[:-1], ring[1:]
    pu, pv = u[..., None], v[..., None]
    ab = b - a
    t = np.clip(((pu - a[:, 0]) * ab[:, 0] + (pv - a[:, 1]) * ab[:, 1])
                / np.maximum((ab ** 2).sum(1), 1e-12), 0.0, 1.0)
    du = pu - (a[:, 0] + t * ab[:, 0])
    dv = pv - (a[:, 1] + t * ab[:, 1])
    dist = np.sqrt(du * du + dv * dv).min(-1)
    inside = points_in_poly(np.stack([u.ravel(), v.ravel()], 1), ring).reshape(u.shape)
    return np.where(inside, -dist, dist)


def mirror_about_y(mesh: trimesh.Trimesh) -> trimesh.Trimesh:
    """Keep the +Y half and mirror it, so the body is exactly symmetric about
    Y=0 (decimation isn't), which the half-model symmetry solve requires."""
    half = mesh.slice_plane([0.0, 0.0, 0.0], [0.0, 1.0, 0.0], cap=False)
    v = half.vertices.copy()
    v[np.abs(v[:, 1]) < 1e-6, 1] = 0.0
    mirrored = v * np.array([1.0, -1.0, 1.0])
    faces = np.vstack([half.faces, half.faces[:, ::-1] + len(v)])
    whole = trimesh.Trimesh(np.vstack([v, mirrored]), faces, process=False)
    whole.merge_vertices(digits_vertex=6)
    whole.remove_unreferenced_vertices()
    whole.fix_normals()
    return whole


def ahmed_body(slant_deg: float) -> trimesh.Trimesh:
    drop = SLANT_LEN * math.sin(math.radians(slant_deg))
    run = SLANT_LEN * math.cos(math.radians(slant_deg))
    side = rounded_front_profile(L, H, R, top_cut=(L - run, H - drop))  # (x, z)
    plan = rounded_front_profile(L, W, R)                               # (x, y + W/2)

    # Offset the grid by a fraction of a voxel so no sample lands exactly on a
    # flat face (a zero-distance plane makes marching cubes emit slivers).
    pad = 3 * PITCH_MM
    off = 0.37 * PITCH_MM
    xs = np.arange(-pad, L + pad, PITCH_MM) + off
    ys = np.arange(-W / 2 - pad, W / 2 + pad, PITCH_MM) + off
    zs = np.arange(-pad, H + pad, PITCH_MM) + off
    # Both profiles are extrusions, so their 2D distances are computed once on
    # their own plane and broadcast; the intersection is the max of the two.
    xz_u, xz_v = np.meshgrid(xs, zs, indexing="ij")
    d_side = signed_distance_2d(side, xz_u, xz_v)             # (nx, nz)
    xy_u, xy_v = np.meshgrid(xs, ys + W / 2, indexing="ij")
    d_plan = signed_distance_2d(plan, xy_u, xy_v)             # (nx, ny)
    sdf = np.maximum(d_side[:, None, :], d_plan[:, :, None]).astype(np.float32)

    verts, faces, _, _ = marching_cubes(sdf, level=0.0, spacing=(PITCH_MM,) * 3)
    verts += np.array([xs[0], ys[0], zs[0]])
    mesh = trimesh.Trimesh(verts, faces[:, ::-1], process=True)
    mesh.fix_normals()
    mesh, method = repair.decimate(mesh, TARGET_TRIANGLES)
    mesh = mirror_about_y(mesh)
    assert mesh.is_watertight, "Ahmed body mesh is not closed"
    print(f"ahmed_{slant_deg:g}: {len(mesh.faces)} triangles ({method}), "
          f"bbox {np.round(mesh.extents, 1)} mm, volume {mesh.volume / 1e9:.4f} m^3")
    return mesh


def sphere() -> trimesh.Trimesh:
    mesh = trimesh.creation.icosphere(subdivisions=5, radius=50.0)
    print(f"sphere: {len(mesh.faces)} triangles, diameter {mesh.extents[0]:.1f} mm")
    return mesh


if __name__ == "__main__":
    ahmed_body(25.0).export(HERE / "ahmed_25.stl")
    sphere().export(HERE / "sphere_100mm.stl")
