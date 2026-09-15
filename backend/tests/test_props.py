"""Motor detection for automatic prop disk placement."""
import math
from pathlib import Path

import pytest
import trimesh

from app.props import detect_props, standard_prop_diameter

ROOT = Path(__file__).resolve().parents[2]
QUAD = ROOT / "examples" / "quad_frame.stl"
CAR = ROOT / "examples" / "sample_car.stl"
WING = ROOT / "examples" / "sample_wing.stl"
SPHERE = Path(__file__).parent / "fixtures" / "sphere_100mm.stl"


def load(path):
    return trimesh.load(path, force="mesh")


def hexacopter(arm=150.0, pad_r=14.0):
    """Hub + 6 arms with round motor pads and motor cans on top."""
    parts = [trimesh.creation.cylinder(radius=40.0, height=20.0)]
    for k in range(6):
        a = 2 * math.pi * k / 6
        x, y = arm * math.cos(a), arm * math.sin(a)
        bar = trimesh.creation.box(extents=[arm, 12.0, 6.0])
        bar.apply_transform(trimesh.transformations.rotation_matrix(a, [0, 0, 1]))
        bar.apply_translation([x / 2, y / 2, 0.0])
        pad = trimesh.creation.cylinder(radius=pad_r, height=6.0)
        pad.apply_translation([x, y, 0.0])
        can = trimesh.creation.cylinder(radius=pad_r * 0.9, height=16.0)
        can.apply_translation([x, y, 11.0])
        parts += [bar, pad, can]
    return trimesh.util.concatenate(parts)


def test_quad_motors_found_on_the_arm_tips():
    out = detect_props(load(QUAD), "mm")
    assert out["reason"] is None and len(out["props"]) == 4
    for p in out["props"]:
        x, y, z = p["center"]
        assert abs(abs(x) - 88) < 3 and abs(abs(y) - 88) < 3
        assert z > 0
    assert {tuple(math.copysign(1, v) for v in p["center"][:2]) for p in out["props"]} == {
        (1, 1), (-1, 1), (-1, -1), (1, -1)}
    # 176 mm between neighbors: the largest common prop that fits is 6".
    assert out["props"][0]["diameter"] == pytest.approx(152.4)


def test_hexacopter_has_six_motors():
    mesh = hexacopter()
    out = detect_props(mesh, "mm")
    assert out["reason"] is None and len(out["props"]) == 6
    for p in out["props"]:
        assert math.hypot(*p["center"][:2]) == pytest.approx(150.0, abs=4.0)
        assert p["center"][2] >= mesh.bounds[1][2]  # on top of the motor can


@pytest.mark.parametrize("path", [CAR, WING, SPHERE])
def test_non_multirotors_are_declined(path):
    out = detect_props(load(path), "mm")
    assert out["props"] == [] and out["reason"]


@pytest.mark.parametrize("max_d, unit, expected", [
    (133.0, "mm", 127.0),   # 5"
    (13.3, "cm", 12.7),     # same prop in cm
    (0.133, "m", 0.127),
    (5.2, "in", 5.0),
    (40.0, "mm", None),     # smaller than any listed prop
])
def test_standard_prop_diameter(max_d, unit, expected):
    got = standard_prop_diameter(max_d, unit)
    assert got == (pytest.approx(expected) if expected is not None else None)
