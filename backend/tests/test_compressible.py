"""Compressible and supersonic case generation (docs/ROADMAP_COMPRESSIBLE.md)."""
import math
import re

import pytest

from app import foamcase, post

MODEL = {
    "bbox_m": [[0.0, -0.08, -0.08], [0.30, 0.08, 0.08]],
    "frontal_area_m2": 0.02,
    "centroid": [0.15, 0.0, 0.0],
}


def cfg(**kw):
    base = {"wind_speed": 15.0, "quality": "coarse"}
    base.update(kw)
    return base


def case_files(tmp_path, **kw):
    params = foamcase.compute_params(MODEL, cfg(**kw))
    fm = params["flow_model"]
    foamcase.generate_case(tmp_path / "case", params,
                           compressible=params["compressible"],
                           supersonic=fm == "supersonic")
    return tmp_path / "case"


def test_default_is_still_incompressible(tmp_path):
    """Every run before v9 must generate byte-identical cases."""
    case = case_files(tmp_path)
    assert not (case / "0" / "T").exists()
    assert not (case / "constant" / "thermophysicalProperties").exists()
    assert "application     simpleFoam;" in (case / "system" / "controlDict").read_text()
    # Kinematic pressure: dimensions are m2/s2, not Pa.
    assert "[0 2 -2 0 0 0 0]" in (case / "0" / "p").read_text()


def test_unknown_flow_model_is_rejected():
    with pytest.raises(ValueError):
        foamcase.flow_model({"flow_model": "hypersonic"})


@pytest.mark.parametrize("fm,solver", [
    ("incompressible", "simpleFoam"),
    ("transonic", "rhoSimpleFoam"),
    ("supersonic", "rhoCentralFoam"),
])
def test_flow_model_picks_its_solver(tmp_path, fm, solver):
    case = case_files(tmp_path, flow_model=fm)
    assert f"application     {solver};" in (case / "system" / "controlDict").read_text()


def test_compressible_overlay_adds_thermo_and_fields(tmp_path):
    case = case_files(tmp_path, flow_model="transonic")
    assert (case / "0" / "T").exists()
    assert (case / "0" / "alphat").exists()
    thermo = (case / "constant" / "thermophysicalProperties").read_text()
    assert "perfectGas" in thermo
    # mu must come from the run's own nu*rho, not a Sutherland fit, so a
    # low-speed compressible run stays comparable with the incompressible one.
    mu = float(re.search(r"mu\s+(\S+);", thermo).group(1))
    assert mu == pytest.approx(1.5e-5 * 1.225)


def test_compressible_pressure_is_absolute(tmp_path):
    p = (case_files(tmp_path, flow_model="transonic") / "0" / "p").read_text()
    assert "[1 -1 -2 0 0 0 0]" in p           # pascals
    assert str(int(foamcase.P_AMBIENT)) in p


def test_force_coefficients_always_get_rhoinf(tmp_path):
    """forceCoeffs needs rhoInf even with `rho rho;` — omitting it is a fatal
    IO error at the first time step, not a warning."""
    for fm in ("incompressible", "transonic"):
        text = (case_files(tmp_path / fm, flow_model=fm)
                / "system" / "controlDict").read_text()
        assert "rhoInf" in text


def test_supersonic_outlet_does_not_fix_pressure(tmp_path):
    """A fixedValue outlet reflects shocks back into the domain."""
    case = case_files(tmp_path, flow_model="supersonic")
    p = (case / "0" / "p").read_text()
    # Split on the patch entry, not the first mention of the word: the header
    # comment talks about the outlet too.
    outlet = p.split("    outlet\n    {", 1)[1].split("}", 1)[0]
    assert "zeroGradient" in outlet
    assert "fixedValue" not in outlet


def test_supersonic_uses_shock_capturing_schemes(tmp_path):
    schemes = (case_files(tmp_path, flow_model="supersonic")
               / "system" / "fvSchemes").read_text()
    assert "fluxScheme          Kurganov;" in schemes
    assert "vanLeer" in schemes          # limited, or shocks oscillate
    assert "steadyState" not in schemes  # transient


def test_supersonic_time_controls_are_courant_limited(tmp_path):
    u = 680.0
    case = case_files(tmp_path, flow_model="supersonic", wind_speed=u)
    text = (case / "system" / "controlDict").read_text()
    assert "adjustTimeStep  yes;" in text
    end = float(re.search(r"endTime\s+(\S+);", text).group(1))
    maxco = float(re.search(r"maxCo\s+(\S+);", text).group(1))
    assert maxco == pytest.approx(foamcase.SUPERSONIC_MAX_CO)
    # Long enough for the flow to cross the (supersonic, tighter) domain
    # FLOW_THROUGHS times.
    mach = u / foamcase.speed_of_sound(foamcase.T_AMBIENT)
    (dx0, _, _), (dx1, _, _) = foamcase.supersonic_bounds(MODEL, mach)
    assert end == pytest.approx(foamcase.FLOW_THROUGHS * (dx1 - dx0) / u)


def test_steady_models_still_count_iterations(tmp_path):
    text = (case_files(tmp_path, flow_model="transonic")
            / "system" / "controlDict").read_text()
    assert "deltaT          1;" in text
    assert "adjustTimeStep" not in text


# --- pressure conversion ----------------------------------------------------

def test_kinematic_pressure_is_scaled_by_density():
    import numpy as np
    p = np.array([10.0, -20.0])
    assert post.to_pascals(p, 1.225, compressible=False) == pytest.approx(p * 1.225)


def test_absolute_pressure_is_left_alone():
    """Scaling absolute pressure again would inflate everything by rho."""
    import numpy as np
    p = np.array([101325.0, 101000.0])
    assert post.to_pascals(p, 1.225, compressible=True) == pytest.approx(p)


def test_cp_references_ambient_only_when_absolute():
    import numpy as np
    rho, u = 1.225, 15.0
    q = 0.5 * rho * u * u
    inc = post.pressure_coefficient(np.array([q]), rho, u, compressible=False)
    com = post.pressure_coefficient(np.array([foamcase.P_AMBIENT + q]), rho, u,
                                    compressible=True)
    assert inc[0] == pytest.approx(1.0)
    assert com[0] == pytest.approx(1.0)


def test_speed_of_sound_is_right_for_air():
    assert foamcase.speed_of_sound(288.15) == pytest.approx(340.3, abs=0.5)


# --- supersonic refinement cap ---------------------------------------------

def test_refinement_cap_scales_with_the_body_not_the_level():
    """An absolute level cap tuned on a 0.3 m cone gave 0.3 m surface cells on
    a 17 m aircraft, because the domain — and so the base cell — scales with
    the model. Both should land near the same cells-along-body."""
    cone = foamcase.supersonic_level_cap(0.30, 0.0212)
    jet = foamcase.supersonic_level_cap(17.1, 1.221)
    cells_cone = 0.30 / (0.0212 / 2 ** cone)
    cells_jet = 17.1 / (1.221 / 2 ** jet)
    assert 80 < cells_cone < 260
    assert 80 < cells_jet < 260
    assert abs(cells_cone - cells_jet) < 40


def test_refinement_cap_never_goes_below_the_body_target():
    """Refining past the target buys detail the shock does not need while
    halving the time step for every level."""
    for body, base in [(0.3, 0.02), (1.0, 0.05), (17.1, 1.2), (60.0, 4.0)]:
        lvl = foamcase.supersonic_level_cap(body, base)
        assert base / 2 ** lvl >= body / foamcase.SUPERSONIC_CELLS_PER_BODY
        assert 0 <= lvl <= 8


def test_supersonic_run_uses_the_cap(tmp_path):
    big = {"bbox_m": [[-8.5, -6.0, -1.8], [8.5, 6.0, 1.8]],
           "frontal_area_m2": 9.0, "centroid": [0.0, 0.0, 0.0]}
    params = foamcase.compute_params(big, {
        "wind_speed": 476.0, "quality": "fine", "flow_model": "supersonic",
        "symmetry": True, "layers": {"count": 0}})
    # "fine" asks for level 7; the supersonic cap must override it.
    assert int(params["surfMax"]) < QUALITY_FINE_SURF_MAX
    cell = params["base_cell"] / 2 ** int(params["surfMax"])
    assert 17.0 / cell > 80


QUALITY_FINE_SURF_MAX = 7


# --- shock isosurface -------------------------------------------------------

def test_shock_payload_shape():
    """Flat arrays the viewer can hand straight to three.js."""
    import numpy as np
    from app import ondemand
    pts = np.array([[0.0, 0, 0], [1, 0, 0], [0, 1, 0]])
    tris = np.array([[0, 1, 2]])
    fields = {"U": np.array([[10.0, 0, 0], [20, 0, 0], [30, 0, 0]])}
    out = ondemand.shock_payload(pts, tris, fields)
    assert len(out["positions"]) == 9
    assert out["indices"] == [0, 1, 2]
    assert out["triangles"] == 1
    assert out["ranges"]["u_mag"] == pytest.approx([10.0, 30.0])


def test_shock_payload_survives_a_missing_velocity_field():
    import numpy as np
    from app import ondemand
    pts = np.array([[0.0, 0, 0], [1, 0, 0], [0, 1, 0]])
    out = ondemand.shock_payload(pts, np.array([[0, 1, 2]]), {})
    assert out["ranges"]["u_mag"] == [0.0, 0.0]


def test_shock_compression_range_is_sane():
    from app import ondemand
    lo, hi = ondemand.SHOCK_COMPRESSION_RANGE
    assert 0 < lo < ondemand.SHOCK_COMPRESSION < hi
