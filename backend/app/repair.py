"""Model repair: rebuild a broken STL as one closed, manifold surface.

CAD assembly exports are routinely unusable for meshing as-is: open shells,
zero-thickness sheets, overlapping parts, edges shared by 3+ faces. snappyHexMesh
needs a surface that cleanly separates inside from outside, and a leaking or
near-sealed pocket can drive a physically impossible jet through the solve.

Pipeline (units are whatever the STL uses; nothing is rescaled or moved):
  1. surface voxelization at `pitch` (a barycentric lattice per triangle)
  2. fill every region the outside can't reach -> one solid occupancy grid
  3. light Gaussian smooth + marching cubes -> closed manifold surface
  4. pull the surface back 0.62 voxel along its normals (cancels voxel bias)
  5. topology-preserving decimation to a sensible triangle count
  6. translation-only alignment back onto the original surface
  7. validation against the original (shift, deviation, watertightness)

Calibrated on a real aluminum quad-frame export at 0.25 mm voxels: the raw
marching-cubes surface sits +0.58 voxel outside the original; a 0.5 voxel
offset left +0.24, 0.75 left -0.25, so 0.62 centers it. Moving vertices changes
no connectivity, so the offset can't open holes.
"""
from __future__ import annotations

import time
from pathlib import Path
from typing import Callable

import numpy as np
import trimesh
from scipy import ndimage
from scipy.spatial import cKDTree

# Voxels along the model's longest extent. Finer than the `fine` quality's
# surface cells (~L/640), so repair never limits what the solver can resolve.
RESOLUTION = 850
# Memory cap (~5 GB peak at this size); boxy models get a coarser pitch.
MAX_VOXELS = 120e6
TARGET_TRIANGLES = 400_000
SMOOTH_SIGMA = 0.6
INWARD_OFFSET_VOXELS = 0.62
PAD = 4

Progress = Callable[[float, str], None]


def edge_stats(mesh: trimesh.Trimesh) -> tuple[int, int]:
    """(open edges, non-manifold edges): edges used by 1 face, and by 3+."""
    if len(mesh.faces) == 0:
        return 0, 0
    _, counts = np.unique(mesh.edges_sorted, axis=0, return_counts=True)
    return int((counts == 1).sum()), int((counts > 2).sum())


def _load(path: str | Path) -> trimesh.Trimesh:
    mesh = trimesh.load(str(path), file_type="stl", force="mesh")
    if mesh.is_empty or len(mesh.faces) == 0:
        raise ValueError("STL contains no triangles")
    return mesh


def inspect(path: str | Path) -> dict:
    """Cheap health check of an STL, for deciding whether to offer repair."""
    mesh = _load(path)
    open_edges, non_manifold = edge_stats(mesh)
    return {
        "triangles": int(len(mesh.faces)),
        "watertight": bool(mesh.is_watertight),
        "open_edges": open_edges,
        "non_manifold_edges": non_manifold,
        "bodies": int(mesh.body_count),
    }


def voxel_pitch(extents, resolution: int = RESOLUTION,
                max_voxels: float = MAX_VOXELS) -> float:
    ext = np.maximum(np.asarray(extents, dtype=float), 0.0)
    if ext.max() <= 0:
        raise ValueError("STL has zero size")
    return float(max(ext.max() / resolution, (np.prod(ext) / max_voxels) ** (1 / 3)))


def _surface_voxels(mesh: trimesh.Trimesh, lo: np.ndarray, pitch: float,
                    shape: np.ndarray) -> np.ndarray:
    """Mark every voxel a triangle passes through (lattice spacing <= pitch/2)."""
    occ = np.zeros(shape, dtype=bool)
    tris = mesh.triangles
    edge = np.max(np.linalg.norm(tris[:, [1, 2, 0]] - tris, axis=2), axis=1)
    nsub = np.maximum(1, np.ceil(edge / (pitch * 0.5)).astype(int))
    for n in np.unique(nsub):
        sel = tris[nsub == n]
        i, j = np.meshgrid(np.arange(n + 1), np.arange(n + 1), indexing="ij")
        keep = (i + j) <= n
        w = np.stack([1 - (i[keep] + j[keep]) / n, i[keep] / n, j[keep] / n], 1)
        step = max(1, 2_000_000 // len(w))
        for c in range(0, len(sel), step):
            pts = np.einsum("kv,tvd->tkd", w, sel[c:c + step]).reshape(-1, 3)
            idx = np.floor((pts - lo) / pitch).astype(int)
            np.clip(idx, 0, shape - 1, out=idx)
            occ[idx[:, 0], idx[:, 1], idx[:, 2]] = True
    return occ


def _closed(mesh: trimesh.Trimesh) -> bool:
    return bool(mesh.is_watertight) and edge_stats(mesh)[1] == 0


def _oriented(vertices, faces) -> trimesh.Trimesh:
    mesh = trimesh.Trimesh(vertices, faces, process=True)
    if mesh.volume < 0:
        mesh.invert()
    return mesh


def decimate(mesh: trimesh.Trimesh, target: int,
             prefer_pymeshlab: bool = True) -> tuple[trimesh.Trimesh, str]:
    """Reduce triangles without breaking the closed surface.

    pymeshlab's quadric collapse with preservetopology reaches the target and
    stays manifold. fast_simplification is the lightweight fallback: at agg=1
    it cut a real frame's marching-cubes surface from 4.5M to 1.8M triangles
    and stayed manifold, but it can still pinch other shapes (a subdivided box
    gains non-manifold edges), and higher agg pinches badly. So every result is
    checked, and the input is returned ("none") if neither is safe.
    """
    if len(mesh.faces) <= target:
        return mesh, "none"
    bodies = mesh.body_count
    if prefer_pymeshlab:
        try:
            import pymeshlab
        except ImportError:
            pymeshlab = None
        if pymeshlab is not None:
            # pymeshlab can import yet have no filters: its plugins are shared
            # libraries that fail to load without system OpenGL (seen on
            # headless Linux: libOpenGL.so.0 missing -> no decimation filter).
            # Any failure here must fall through, not fail the whole repair.
            try:
                ms = pymeshlab.MeshSet()
                ms.add_mesh(pymeshlab.Mesh(vertex_matrix=mesh.vertices.astype(np.float64),
                                           face_matrix=mesh.faces.astype(np.int32)))
                ms.meshing_decimation_quadric_edge_collapse(
                    targetfacenum=int(target), preservetopology=True,
                    preserveboundary=True, preservenormal=True,
                    optimalplacement=True, planarquadric=True,
                    qualitythr=0.4, autoclean=True)
                m = ms.current_mesh()
                out = _oriented(m.vertex_matrix(), m.face_matrix())
            except Exception:  # noqa: BLE001 — broken install: use the fallback
                out = None
            if out is not None and _closed(out) and out.body_count <= bodies:
                return out, "pymeshlab"
    import fast_simplification
    v, f = fast_simplification.simplify(
        mesh.vertices.astype(np.float32), mesh.faces.astype(np.int64),
        target_reduction=1.0 - target / len(mesh.faces), agg=1)
    out = _oriented(v, f)
    # agg=1 only collapses near-free edges: it reduces the coplanar staircase
    # facets marching cubes makes, but can leave a smooth surface untouched.
    if _closed(out) and out.body_count <= bodies and len(out.faces) < len(mesh.faces):
        return out, "fast_simplification"
    return mesh, "none"


def _align(mesh: trimesh.Trimesh, original: trimesh.Trimesh, pitch: float) -> list[float]:
    """Translation-only ICP onto the original surface. The voxel grid can land
    the rebuild a fraction of a voxel off; props and other coordinates typed
    against the original must still line up. Skipped if it wants to move more
    than two voxels (that would be fitting to interior faces, not drift)."""
    ref, _ = trimesh.sample.sample_surface(original, 1_000_000, seed=1)
    tree = cKDTree(ref)
    pts, _ = trimesh.sample.sample_surface(mesh, 200_000, seed=2)
    t = np.zeros(3)
    for _ in range(6):
        _, k = tree.query(pts + t, workers=-1)
        t += np.median(ref[k] - (pts + t), axis=0)
    if np.linalg.norm(t) > 2 * pitch:
        return [0.0, 0.0, 0.0]
    mesh.apply_translation(t)
    return [float(v) for v in t]


def _validate(mesh: trimesh.Trimesh, original: trimesh.Trimesh) -> dict:
    """Signed median shift (+ = fatter than the original) and deviation of the
    repaired surface from the original, in the STL's own units."""
    ref, face_idx = trimesh.sample.sample_surface(original, 1_500_000, seed=3)
    pts, _ = trimesh.sample.sample_surface(mesh, 200_000, seed=4)
    dist, k = cKDTree(ref).query(pts, workers=-1)
    sign = np.sign(np.einsum("ij,ij->i", pts - ref[k], original.face_normals[face_idx[k]]))
    return {
        "shift_median": float(np.median(dist * sign)),
        "deviation_p95": float(np.percentile(dist, 95)),
        "deviation_max": float(dist.max()),
    }


def repair_stl(src_path: str | Path, out_path: str | Path,
               progress: Progress | None = None,
               resolution: int = RESOLUTION, max_voxels: float = MAX_VOXELS,
               target_triangles: int = TARGET_TRIANGLES,
               prefer_pymeshlab: bool = True) -> dict:
    """Rebuild `src_path` as a closed manifold STL at `out_path`; returns a report."""
    from skimage.measure import marching_cubes

    t0 = time.time()
    step = progress or (lambda frac, stage: None)

    step(0.02, "loading model")
    original = _load(src_path)
    open_in, nonman_in = edge_stats(original)
    pitch = voxel_pitch(original.extents, resolution, max_voxels)
    lo = original.bounds[0] - PAD * pitch
    shape = np.ceil(original.extents / pitch).astype(int) + 2 * PAD + 1

    step(0.08, "voxelizing surface")
    occ = _surface_voxels(original, lo, pitch, shape)

    step(0.25, "filling solid interior")
    solid = ndimage.binary_fill_holes(occ)
    del occ

    step(0.35, "rebuilding surface")
    field = ndimage.gaussian_filter(solid.astype(np.float32), sigma=SMOOTH_SIGMA)
    del solid
    verts, faces, _, _ = marching_cubes(field, level=0.5, spacing=(pitch,) * 3)
    del field
    # marching_cubes returns voxel-index coordinates; voxel i is centered at
    # lo + (i + 0.5) * pitch.
    verts += lo + 0.5 * pitch
    mesh = _oriented(verts, faces)
    bodies = [b for b in mesh.split(only_watertight=False) if b.volume > 8 * pitch ** 3]
    if not bodies:
        raise ValueError("nothing solid left after repair — is the model a flat sheet?")
    mesh = trimesh.util.concatenate(bodies)
    mesh.vertices = mesh.vertices - mesh.vertex_normals * (INWARD_OFFSET_VOXELS * pitch)

    step(0.55, "simplifying surface")
    mesh, decimator = decimate(mesh, target_triangles, prefer_pymeshlab)

    step(0.8, "aligning to original")
    shift = _align(mesh, original, pitch)

    step(0.9, "checking against original")
    report = {
        "pitch": pitch,
        "triangles_in": int(len(original.faces)),
        "triangles_out": int(len(mesh.faces)),
        "open_edges_in": open_in,
        "non_manifold_edges_in": nonman_in,
        "watertight": _closed(mesh),
        "bodies": int(mesh.body_count),
        "decimator": decimator,
        "alignment_shift": shift,
        **_validate(mesh, original),
    }
    mesh.export(str(out_path))
    report["runtime_s"] = round(time.time() - t0, 1)
    step(1.0, "done")
    return report
