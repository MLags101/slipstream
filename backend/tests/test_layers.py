"""Prism layer controls and the y+ report that tells you whether they worked."""
import math
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


def snappy_params(**kw):
    return foamcase.compute_params(MODEL, cfg(**kw))


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


# --- y+ targeting (absolute first-layer height) ------------------------------

def test_default_mode_stays_relative(tmp_path):
    text = snappy_dict(tmp_path)
    assert "relativeSizes true;" in text
    assert "finalLayerThickness" in text
    assert "firstLayerThickness" not in text
    assert snappy_params()["layer_target"] is None


def test_target_switches_to_an_absolute_first_layer(tmp_path):
    text = snappy_dict(tmp_path, layers={"count": 10, "target_y_plus": 100})
    assert "relativeSizes false;" in text
    assert "firstLayerThickness" in text
    assert "finalLayerThickness" not in text


def test_first_layer_thickness_matches_the_correlation():
    """y = y+ nu / u_tau with Cf = 0.058 Re^-0.2, doubled because
    firstLayerThickness is a cell height and y+ is at the cell center."""
    u, length, nu, target = 60.0, 1.044, 1.5e-5, 100.0
    re_l = u * length / nu
    cf = 0.058 * re_l ** -0.2
    u_tau = u * math.sqrt(cf / 2.0)
    expected = 2.0 * target * nu / u_tau
    got = foamcase.first_layer_thickness(target, u, length, nu)
    assert got == pytest.approx(expected)
    # Sanity: a car-sized body at 60 m/s wants roughly a millimeter.
    assert 0.5e-3 < got < 3e-3


def test_first_layer_scales_linearly_with_target():
    a = foamcase.first_layer_thickness(30, 60, 1.0, 1.5e-5)
    b = foamcase.first_layer_thickness(300, 60, 1.0, 1.5e-5)
    assert b / a == pytest.approx(10.0)


def test_first_layer_shrinks_as_speed_rises():
    slow = foamcase.first_layer_thickness(100, 10, 1.0, 1.5e-5)
    fast = foamcase.first_layer_thickness(100, 100, 1.0, 1.5e-5)
    assert fast < slow


@pytest.mark.parametrize("bad", [
    {"target_y_plus": 0, "u": 60, "L": 1.0, "nu": 1.5e-5},
    {"target_y_plus": 100, "u": 0, "L": 1.0, "nu": 1.5e-5},
    {"target_y_plus": 100, "u": 60, "L": 0, "nu": 1.5e-5},
])
def test_first_layer_rejects_nonsense(bad):
    with pytest.raises(ValueError):
        foamcase.first_layer_thickness(bad["target_y_plus"], bad["u"],
                                       bad["L"], bad["nu"])


def test_target_is_reported_for_the_run():
    target = snappy_params(layers={"count": 8, "target_y_plus": 50})["layer_target"]
    assert target["target_y_plus"] == 50
    assert target["count"] == 8
    assert target["first_layer_m"] > 0


def test_min_thickness_is_a_fraction_of_the_first_layer(tmp_path):
    """In absolute mode minThickness is in meters, so it cannot stay at the
    relative-mode 0.1 — that would be 10 cm and drop every stack."""
    text = snappy_dict(tmp_path, layers={"count": 10, "target_y_plus": 100})
    first = float(re.search(r"firstLayerThickness\s+(\S+);", text).group(1))
    mint = float(re.search(r"minThickness\s+(\S+);", text).group(1))
    assert 0 < mint < first


# --- layer coverage ---------------------------------------------------------

SNAPPY_LOG = """
Layer mesh : cells:273634  faces:800000  points:300000
patch  faces    layers   overall thickness
                         [m]      [%]
-----  -----    ------   ---      ---
ground 1314     12       0.00964  0.279
model  24781    12       0.000558 0.0153

Doing final balance
patch  faces    layers   avg thickness[m]
                wanted   got
-----  -----    ------   ---    ---      ---
ground 1314     12       8.87   0.154    62.4
model  24781    12       8.86   0.0143   89.4
"""


def test_layer_coverage_reads_the_achieved_table_not_the_request(tmp_path):
    p = tmp_path / "log.snappyHexMesh"
    p.write_text(SNAPPY_LOG)
    cov = post.parse_layer_coverage(p)
    assert cov["ground"]["layers"] == pytest.approx(8.87)
    assert cov["ground"]["layers_requested"] == 12
    assert cov["ground"]["coverage_pct"] == pytest.approx(62.4)
    assert cov["model"]["coverage_pct"] == pytest.approx(89.4)


def test_layer_coverage_is_none_without_a_log(tmp_path):
    assert post.parse_layer_coverage(tmp_path / "nope.log") is None
    empty = tmp_path / "log.snappyHexMesh"
    empty.write_text("Layer mesh : cells:100\n")
    assert post.parse_layer_coverage(empty) is None


# --- how many layers actually fit -------------------------------------------

def test_layer_count_is_capped_by_the_cell_it_grows_from():
    """Measured: a 35 mm stack requested on a 3.26 mm surface cell grew 0.1
    layers over 1.8% of the model. The count must come from the geometry."""
    # 1.35 mm first layer on a 3.26 mm cell leaves room for one layer.
    assert foamcase.feasible_layer_count(1.35e-3, 1.2, 3.26e-3, 10) == 1
    # The same first layer on a 209 mm floor cell has room for the lot.
    assert foamcase.feasible_layer_count(1.35e-3, 1.2, 0.209, 10) == 10


def test_a_first_layer_thicker_than_the_cell_fits_nothing():
    assert foamcase.feasible_layer_count(5e-3, 1.2, 3.26e-3, 10) == 0


def test_feasible_count_never_exceeds_the_request():
    assert foamcase.feasible_layer_count(1e-5, 1.2, 1.0, 4) == 4


def test_bridging_count_flags_a_gap_too_big_to_span():
    # Ahmed floor: 209 mm cells, 1.35 mm first layer, ratio 1.2.
    assert foamcase.bridging_layer_count(1.35e-3, 1.2, 0.209) > 12
    # Ahmed model surface: 3.26 mm cells — an easy span.
    assert foamcase.bridging_layer_count(1.35e-3, 1.2, 3.26e-3) <= 12


def test_unreachable_names_the_patch_that_cannot_get_there(tmp_path):
    """The floor's cells are ~60x the first layer the target needs, so the
    stack cannot bridge to them — exactly the case that measured 64% coverage
    and y+ 1868 against a target of 100."""
    model = {"bbox_m": [[0, 0, 0], [1.044, 0.389, 0.288]],
             "frontal_area_m2": 0.112, "centroid": [0.5, 0.2, 0.14]}
    params = foamcase.compute_params(model, {
        "wind_speed": 60, "quality": "medium", "ground_plane": True,
        "layers": {"count": 10, "expansion": 1.2, "target_y_plus": 100,
                   "ground": True}})
    target = params["layer_target"]
    assert target["unreachable"] == ["ground"]
    assert target["counts"]["model"] == 1


def test_a_reachable_target_reports_nothing_unreachable():
    model = {"bbox_m": [[0, 0, 0], [1.044, 0.389, 0.288]],
             "frontal_area_m2": 0.112, "centroid": [0.5, 0.2, 0.14]}
    params = foamcase.compute_params(model, {
        "wind_speed": 60, "quality": "medium",
        "layers": {"count": 6, "expansion": 1.2, "target_y_plus": 100}})
    assert params["layer_target"]["unreachable"] == []
