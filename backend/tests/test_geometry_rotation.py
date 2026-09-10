"""prepare_stl and transform_props must apply the SAME rotation.

The prop disks are placed by replaying the mesh transform on their centres, so
if the two ever disagree on rotation order the disks silently drift off the
rotors — and with roll in the mix there are six possible orders to get wrong.
"""
from __future__ import annotations

import numpy as np
import pytest
import trimesh

from app.geometry import prepare_stl, transform_props


def _write_asymmetric_stl(path) -> trimesh.Trimesh:
    """A body with no rotational symmetry, so a wrong order cannot pass."""
    parts = [
        trimesh.creation.box(extents=[120, 40, 10]),
        trimesh.creation.box(extents=[20, 20, 30]),
    ]
    parts[1].apply_translation([45, 12, 18])
    mesh = trimesh.util.concatenate(parts)
    mesh.export(path, file_type="stl")
    return mesh


# Roll alone, and roll combined with pitch/yaw where order actually matters.
ANGLES = [
    (0.0, 0.0, 0.0),
    (0.0, 0.0, 30.0),
    (25.0, 0.0, 0.0),
    (0.0, -18.0, 0.0),
    (25.0, -18.0, 30.0),
    (-40.0, 55.0, -70.0),
]


@pytest.mark.parametrize("yaw,pitch,roll", ANGLES)
def test_prop_centres_track_the_mesh(tmp_path, yaw, pitch, roll):
    src = tmp_path / "model.stl"
    out = tmp_path / "prepared.stl"
    mesh = _write_asymmetric_stl(src)

    model = prepare_stl(str(src), "mm", yaw, str(out),
                        pitch_deg=pitch, roll_deg=roll)

    # The vertex centroid is affine-covariant, so wherever it lands in the
    # prepared mesh is exactly where transform_props must map it to.
    orig_centroid = np.asarray(mesh.vertices).mean(axis=0)
    expected = np.asarray(trimesh.load(out, file_type="stl",
                                       force="mesh").vertices).mean(axis=0)

    got = transform_props(
        [{"center": list(orig_centroid), "diameter": 100.0, "thrust_g": 0.0}],
        "mm", yaw, pitch, model, roll_deg=roll,
    )[0]

    assert np.allclose(got["center_m"], expected, atol=1e-9), (
        f"disk centre drifted from the mesh at yaw={yaw} pitch={pitch} roll={roll}"
    )


@pytest.mark.parametrize("yaw,pitch,roll", ANGLES)
def test_thrust_axis_is_the_rotated_model_z(tmp_path, yaw, pitch, roll):
    src = tmp_path / "model.stl"
    out = tmp_path / "prepared.stl"
    _write_asymmetric_stl(src)
    model = prepare_stl(str(src), "mm", yaw, str(out),
                        pitch_deg=pitch, roll_deg=roll)

    axis = transform_props(
        [{"center": [0.0, 0.0, 0.0], "diameter": 100.0, "thrust_g": 0.0}],
        "mm", yaw, pitch, model, roll_deg=roll,
    )[0]["axis"]

    # Thrust acts along the model's own +Z, carried through the same rotation.
    rr = trimesh.transformations.rotation_matrix(np.radians(roll), [1, 0, 0])[:3, :3]
    rp = trimesh.transformations.rotation_matrix(np.radians(pitch), [0, 1, 0])[:3, :3]
    ry = trimesh.transformations.rotation_matrix(np.radians(-yaw), [0, 0, 1])[:3, :3]
    assert np.allclose(axis, (ry @ rp @ rr) @ np.array([0.0, 0.0, 1.0]), atol=1e-12)
    assert np.isclose(np.linalg.norm(axis), 1.0)


def test_roll_actually_rotates_the_mesh(tmp_path):
    """A 90° roll should swap the model's Y and Z extents."""
    src = tmp_path / "model.stl"
    _write_asymmetric_stl(src)
    flat = prepare_stl(str(src), "mm", 0.0, str(tmp_path / "a.stl"))
    rolled = prepare_stl(str(src), "mm", 0.0, str(tmp_path / "b.stl"),
                         roll_deg=90.0)

    def extents(m):
        (x0, y0, z0), (x1, y1, z1) = m["bbox_m"]
        return x1 - x0, y1 - y0, z1 - z0

    fx, fy, fz = extents(flat)
    rx, ry, rz = extents(rolled)
    assert np.isclose(rx, fx, atol=1e-9)
    assert np.isclose(ry, fz, atol=1e-9)
    assert np.isclose(rz, fy, atol=1e-9)
