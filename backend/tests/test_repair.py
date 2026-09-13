"""Model repair: broken STLs come back closed, manifold, and where they were."""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
import trimesh

from app import repair

SPHERE = Path(__file__).parent / "fixtures" / "sphere_100mm.stl"
# Coarse enough to run in seconds; accuracy assertions scale with the pitch.
FAST = dict(resolution=120, target_triangles=20_000)


def _broken_assembly(tmp_path: Path) -> Path:
    """A sphere with a hole punched in it plus a second, overlapping sphere —
    open edges and intersecting shells, like a careless assembly export."""
    s = trimesh.load(SPHERE, force="mesh")
    holed = s.copy()
    center = s.bounds.mean(axis=0)
    top = np.argsort(-(s.triangles_center - center)[:, 2])[:40]
    holed.update_faces(np.setdiff1d(np.arange(len(s.faces)), top))
    holed.remove_unreferenced_vertices()
    other = s.copy()
    other.apply_translation([30.0, 0.0, 0.0])
    broken = trimesh.util.concatenate([holed, other])
    path = tmp_path / "broken.stl"
    broken.export(path)
    return path


def test_inspect_flags_broken_and_passes_clean(tmp_path):
    clean = repair.inspect(SPHERE)
    assert clean["watertight"] and clean["open_edges"] == 0

    broken = repair.inspect(_broken_assembly(tmp_path))
    assert not broken["watertight"]
    assert broken["open_edges"] > 0
    assert broken["bodies"] == 2


def test_repair_closes_and_merges_broken_assembly(tmp_path):
    out = tmp_path / "repaired.stl"
    report = repair.repair_stl(_broken_assembly(tmp_path), out, **FAST)
    assert report["watertight"]
    assert report["bodies"] == 1                     # overlapping shells merged
    assert report["open_edges_in"] > 0
    result = repair.inspect(out)
    assert result["watertight"] and result["open_edges"] == 0
    assert result["non_manifold_edges"] == 0


def test_repair_keeps_size_and_position(tmp_path):
    """A clean sphere must come back the same size, in the same place."""
    out = tmp_path / "sphere.stl"
    report = repair.repair_stl(SPHERE, out, **FAST)
    src = trimesh.load(SPHERE, force="mesh")
    got = trimesh.load(out, force="mesh")
    center = src.bounds.mean(axis=0)
    r_src = np.linalg.norm(src.vertices - center, axis=1).mean()
    r_got = np.linalg.norm(got.vertices - center, axis=1).mean()
    pitch = report["pitch"]
    assert abs(r_got - r_src) < 0.3 * pitch, (r_got, r_src, pitch)
    assert np.allclose(got.bounds.mean(axis=0), center, atol=0.3 * pitch)
    assert abs(report["shift_median"]) < 0.3 * pitch


def test_progress_reports_monotonic_stages(tmp_path):
    seen = []
    repair.repair_stl(SPHERE, tmp_path / "p.stl",
                      progress=lambda f, s: seen.append((f, s)), **FAST)
    fracs = [f for f, _ in seen]
    assert fracs == sorted(fracs) and fracs[-1] == 1.0
    assert seen[-1][1] == "done"


@pytest.mark.parametrize("prefer_pymeshlab", [True, False])
def test_decimation_never_breaks_the_surface(prefer_pymeshlab):
    """Either decimator may be used; neither may open or pinch the surface, and
    the report must not claim a reduction that didn't happen."""
    if prefer_pymeshlab:
        pytest.importorskip("pymeshlab")
    dense = trimesh.creation.icosphere(subdivisions=6, radius=50.0)   # 80k tris
    out, used = repair.decimate(dense, 8_000, prefer_pymeshlab=prefer_pymeshlab)
    assert out.is_watertight and repair.edge_stats(out) == (0, 0)
    if used == "none":
        assert len(out.faces) == len(dense.faces)
    else:
        assert len(out.faces) < len(dense.faces)
    if prefer_pymeshlab:
        assert used == "pymeshlab" and len(out.faces) <= 8_000 * 1.05


def test_fallback_result_is_rejected_if_it_pinches():
    """fast_simplification can pinch even simple shapes (measured: a subdivided
    box gains 5 edges shared by 3+ faces at agg=1). That result must be dropped,
    not returned."""
    box = trimesh.creation.box(extents=(40.0, 20.0, 10.0))
    for _ in range(5):
        box = box.subdivide()                                          # 12k tris
    out, used = repair.decimate(box, 500, prefer_pymeshlab=False)
    assert out.is_watertight and repair.edge_stats(out) == (0, 0)
    if used == "none":
        assert len(out.faces) == len(box.faces)


def test_repair_without_pymeshlab_stays_closed_and_reports_honestly(tmp_path):
    out = tmp_path / "fallback.stl"
    report = repair.repair_stl(_broken_assembly(tmp_path), out,
                               prefer_pymeshlab=False, **FAST)
    assert report["decimator"] in ("fast_simplification", "none")
    assert report["watertight"] and report["bodies"] == 1
    written = repair.inspect(out)
    assert written["watertight"] and written["non_manifold_edges"] == 0
    assert written["triangles"] == report["triangles_out"]


def test_voxel_pitch_respects_resolution_and_memory_cap():
    assert repair.voxel_pitch([170, 210, 42]) == pytest.approx(210 / repair.RESOLUTION)
    # A boxy model is limited by the voxel budget instead.
    p = repair.voxel_pitch([300, 300, 300])
    assert p > 300 / repair.RESOLUTION
    assert (300 / p) ** 3 <= repair.MAX_VOXELS * 1.001
    with pytest.raises(ValueError):
        repair.voxel_pitch([0, 0, 0])
