"""Prism layer controls and the y+ report that tells you whether they worked."""
import re

import pytest

from app import foamcase, post

MODEL = {
    "bbox_m": [[-0.15, -0.15, -0.05], [0.15, 0.15, 0.05]],
    "frontal_area_m2": 0.03,
    "centroid": [0.0, 0.0, 0.0],
}


def cfg(**kw):
    base = {"wind_speed": 15.0, "quality": "coarse"}
    base.update(kw)
    return base


def snappy_dict(tmp_path, **kw):
    params = foamcase.compute_params(MODEL, cfg(**kw))
    foamcase.generate_case(tmp_path / "case", params)
    return (tmp_path / "case" / "system" / "snappyHexMeshDict").read_text()


def n_layers(text, patch):
    m = re.search(patch + r"\s*\{\s*nSurfaceLayers\s+(\d+);", text)
    return int(m.group(1)) if m else None


def scalar(text, key):
    return float(re.search(key + r"\s+(\S+);", text).group(1))


def test_defaults_reproduce_the_original_hard_coded_stack(tmp_path):
    """No layers config must generate exactly what the template used to hold,
    so existing runs and reruns keep their meshes."""
    text = snappy_dict(tmp_path)
    assert n_layers(text, "model") == 3
    assert scalar(text, "expansionRatio") == pytest.approx(1.2)
    assert scalar(text, "finalLayerThickness") == pytest.approx(0.3)
    assert scalar(text, "minThickness") == pytest.approx(0.1)
    assert "addLayers       true;" in text
    assert n_layers(text, "ground") is None


def test_custom_settings_reach_the_dict(tmp_path):
    text = snappy_dict(tmp_path, layers={
        "count": 8, "expansion": 1.15, "final_thickness": 0.5,
        "min_thickness": 0.05})
    assert n_layers(text, "model") == 8
    assert scalar(text, "expansionRatio") == pytest.approx(1.15)
    assert scalar(text, "finalLayerThickness") == pytest.approx(0.5)
    assert scalar(text, "minThickness") == pytest.approx(0.05)


def test_zero_layers_turns_the_whole_stage_off(tmp_path):
    text = snappy_dict(tmp_path, layers={"count": 0})
    assert "addLayers       false;" in text


def test_ground_layers_only_when_asked_for(tmp_path):
    on = snappy_dict(tmp_path, ground_plane=True, layers={"ground": True})
    assert n_layers(on, "ground") == 3
    off = snappy_dict(tmp_path, ground_plane=True)
    assert n_layers(off, "ground") is None


def test_ground_layers_need_a_ground_plane(tmp_path):
    """Asking for floor layers without a floor must not name a patch that the
    mesh has no such patch for — snappyHexMesh would abort."""
    text = snappy_dict(tmp_path, layers={"ground": True})
    assert n_layers(text, "ground") is None


def test_out_of_range_values_are_clamped_not_rejected():
    lay = foamcase.layer_settings({"layers": {
        "count": 999, "expansion": 9.0, "final_thickness": 0.0}})
    assert lay["count"] == foamcase.LAYER_LIMITS["count"][1]
    assert lay["expansion"] == foamcase.LAYER_LIMITS["expansion"][1]
    assert lay["final_thickness"] == foamcase.LAYER_LIMITS["final_thickness"][0]


def test_min_thickness_never_exceeds_final_thickness():
    """snappyHexMesh silently drops the whole stack when it does."""
    lay = foamcase.layer_settings({"layers": {
        "final_thickness": 0.1, "min_thickness": 0.4}})
    assert lay["min_thickness"] <= lay["final_thickness"]


# --- y+ ---------------------------------------------------------------------

YPLUS_LOG = """yPlus yPlus write:
    writing field yPlus
    patch model y+ : min = 0.49652908, max = 172.00955, average = 13.151267
    patch ground y+ : min = 120.5, max = 4100.2, average = 2980.4

End
"""


def test_parse_y_plus_reads_every_patch(tmp_path):
    p = tmp_path / "log.yPlus"
    p.write_text(YPLUS_LOG)
    y = post.parse_y_plus(p)
    assert y["model"]["average"] == pytest.approx(13.151267)
    assert y["model"]["max"] == pytest.approx(172.00955)
    assert y["ground"]["average"] == pytest.approx(2980.4)


def test_parse_y_plus_is_none_when_there_is_nothing_to_read(tmp_path):
    assert post.parse_y_plus(tmp_path / "missing.yPlus") is None
    empty = tmp_path / "log.yPlus"
    empty.write_text("yPlus yPlus write:\n    writing field yPlus\n")
    assert post.parse_y_plus(empty) is None


@pytest.mark.parametrize("avg,expected", [
    (2.0, "low"), (13.15, "low"), (60.0, "ok"), (300.0, "ok"), (2980.0, "high"),
])
def test_verdict_brackets_the_wall_function_range(avg, expected):
    assert post.y_plus_verdict({"model": {"average": avg}}) == expected


def test_verdict_prefers_the_model_patch():
    y = {"ground": {"average": 3000.0}, "model": {"average": 60.0}}
    assert post.y_plus_verdict(y) == "ok"


def test_verdict_is_none_without_data():
    assert post.y_plus_verdict(None) is None
    assert post.y_plus_verdict({}) is None
