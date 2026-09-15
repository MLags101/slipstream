"""Optional mesh refinement: long wake box and prop slipstream cylinders."""
import math
import re

import pytest

from app import foamcase

# 0.3 m x 0.3 m x 0.1 m quad-sized body at the origin.
MODEL = {
    "bbox_m": [[-0.15, -0.15, -0.05], [0.15, 0.15, 0.05]],
    "frontal_area_m2": 0.03,
    "centroid": [0.0, 0.0, 0.0],
}
PROP = {"center_m": [0.1, 0.1, 0.02], "axis": [0.0, 0.0, 1.0],
        "diameter_m": 0.127, "thrust_N": 3.0}


def cfg(**kw):
    base = {"wind_speed": 15.0, "quality": "coarse"}
    base.update(kw)
    return base


def snappy_dict(tmp_path, params):
    foamcase.generate_case(tmp_path / "case", params)
    return (tmp_path / "case" / "system" / "snappyHexMeshDict").read_text()


def test_default_dict_is_unchanged(tmp_path):
    params = foamcase.compute_params(MODEL, cfg(), props_m=[PROP])
    text = snappy_dict(tmp_path, params)
    assert "wakeBox" not in text and "slipstream" not in text
    assert float(params["rbx1"]) == pytest.approx(0.15 + 1.5 * 0.3)
    assert params["refinement_info"] == {"long_wake": None, "slipstreams": []}


def test_long_wake_extends_box_and_adds_level1_region(tmp_path):
    params = foamcase.compute_params(MODEL, cfg(refinement={"long_wake": True}))
    L = 0.3
    assert float(params["rbx1"]) == pytest.approx(0.15 + 4.0 * L)
    text = snappy_dict(tmp_path, params)
    geom = re.search(r"wakeBox\s*\{\s*type box;\s*min\s*\(([^)]*)\);\s*max\s*\(([^)]*)\);",
                     text)
    assert geom, text
    x_max = float(geom.group(2).split()[0])
    assert x_max == pytest.approx(0.15 + 8.0 * L)
    assert re.search(r"wakeBox\s*\{\s*mode inside;\s*levels \(\(1E15 1\)\);", text)
    # Still inside the domain (outlet is 9L behind the model).
    domain = foamcase.domain_bounds(MODEL)
    assert x_max < domain[1][0]


def test_induced_velocity_matches_momentum_theory():
    area = math.pi * 0.127 ** 2 / 4
    hover = foamcase.induced_velocity(3.0, 1.225, area, 0.0)
    assert hover == pytest.approx(math.sqrt(3.0 / (2 * 1.225 * area)), rel=1e-6)
    fast = foamcase.induced_velocity(3.0, 1.225, area, 25.0)
    assert fast * math.sqrt(25.0 ** 2 + fast ** 2) == pytest.approx(
        3.0 / (2 * 1.225 * area), rel=1e-6)
    assert fast < hover
    assert foamcase.induced_velocity(0.0, 1.225, area, 10.0) == 0.0


def test_slipstream_points_down_in_hover_and_tilts_back_at_speed():
    base_cell = 0.06
    (hover,) = foamcase.slipstream_regions([PROP], 0.0, 1.225, base_cell, "coarse", 5)
    assert hover["direction"] == pytest.approx([0.0, 0.0, -1.0])
    (fast,) = foamcase.slipstream_regions([PROP], 25.0, 1.225, base_cell, "coarse", 5)
    dx, _, dz = fast["direction"]
    assert dx > 0.9 and dz < 0  # mostly swept back, still pushed down a bit
    # Starts upstream of the disk, ends 3 diameters downstream.
    c = PROP["center_m"]
    assert math.dist(fast["point2"], c) == pytest.approx(3.0 * 0.127)
    assert math.dist(fast["point1"], c) == pytest.approx(0.5 * 0.127)
    assert fast["radius"] == pytest.approx(0.6 * 0.127)


def test_unpowered_disk_in_still_air_covers_its_own_wake():
    prop = dict(PROP, thrust_N=0.0)
    (r,) = foamcase.slipstream_regions([prop], 0.0, 1.225, 0.06, "coarse", 5)
    assert r["direction"] == pytest.approx([0.0, 0.0, -1.0])


@pytest.mark.parametrize("base_cell,diameter,quality,expected", [
    (0.06, 0.127, "coarse", 3),   # needs <= 7.9 mm -> 7.5 mm
    (0.06, 0.127, "medium", 4),   # needs <= 5.3 mm -> 3.75 mm
    (0.06, 0.127, "fine", 4),     # needs <= 4.0 mm -> 3.75 mm
    # Sample quad at coarse: needs <= 8.7 mm from a 42 mm base cell. Rounding
    # to the nearest level gave level 2 (10.5 mm, same as the wake box).
    (0.042, 0.1392, "coarse", 3),
])
def test_slipstream_level_gives_at_least_target_cells_across(
        base_cell, diameter, quality, expected):
    prop = dict(PROP, diameter_m=diameter)
    (r,) = foamcase.slipstream_regions([prop], 15.0, 1.225, base_cell, quality, 7)
    assert r["level"] == expected
    assert r["cell_m"] == pytest.approx(base_cell / 2 ** expected)
    assert diameter / r["cell_m"] >= foamcase.SLIPSTREAM_CELLS_ACROSS[quality]


def test_slipstream_level_is_clamped_between_wake_box_and_surface_level():
    (r,) = foamcase.slipstream_regions([PROP], 15.0, 1.225, 1.0, "fine", 5)
    assert r["level"] == 5
    # Huge prop vs. tiny base cell: still one level finer than the wake box.
    (r,) = foamcase.slipstream_regions([PROP], 15.0, 1.225, 0.001, "coarse", 5)
    assert r["level"] == foamcase.SLIPSTREAM_MIN_LEVEL


def test_slipstream_cylinders_written_per_prop(tmp_path):
    props = [PROP, dict(PROP, center_m=[-0.1, 0.1, 0.02])]
    params = foamcase.compute_params(
        MODEL, cfg(refinement={"prop_slipstream": True, "long_wake": True}),
        props_m=props)
    text = snappy_dict(tmp_path, params)
    for i in (1, 2):
        assert re.search(
            rf"slipstream{i}\s*\{{\s*type\s+cylinder;\s*point1\s*\([^)]*\);"
            rf"\s*point2\s*\([^)]*\);\s*radius\s+[\d.e-]+;", text)
        assert re.search(rf"slipstream{i}\s*\{{\s*mode inside;\s*levels \(\(1E15 \d\)\);",
                         text)
    assert "wakeBox" in text
    info = params["refinement_info"]
    assert len(info["slipstreams"]) == 2 and info["long_wake"]
    # Balanced braces: the fragments slot into the dict cleanly.
    assert text.count("{") == text.count("}")


def test_slipstream_flag_without_props_adds_nothing(tmp_path):
    params = foamcase.compute_params(MODEL, cfg(refinement={"prop_slipstream": True}))
    assert "slipstream" not in snappy_dict(tmp_path, params)
