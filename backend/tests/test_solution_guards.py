"""Guards that stop a physically impossible solve being reported as a result.

Numbers here are the ones measured on a real assembly-export STL whose
overlapping shells left a leaking interior cavity: peak speed 2.3e4 m/s against
a 25 m/s freestream, and Cd swinging +/-260 for the whole solve while residuals
stayed at ~1e-4. The old guards let that through — |Cd| never reached the 1e4
divergence trip, and cd_std was recorded but never acted on.
"""
from __future__ import annotations

import numpy as np
import pytest

from app.post import CONVERGED_REL_TOL
from app.runner import Runner


class TestSpeedGuard:
    def test_measured_cavity_jet_is_over_the_limit(self):
        u0 = 25.0
        assert 2.296e4 > Runner.MAX_SPEED_FACTOR * u0

    def test_healthy_external_aero_is_under_the_limit(self):
        # Real converged runs on this geometry peaked well under 2x freestream;
        # even a generous prop-wash acceleration must not trip the guard.
        u0 = 25.0
        for peak in (25.0, 40.0, 60.0, 3.0 * u0):
            assert peak <= Runner.MAX_SPEED_FACTOR * u0, peak

    def test_startup_spike_is_not_judged(self):
        # Measured on healthy runs at iteration 2: 501 m/s @ 15 m/s, and
        # 1068 m/s @ 25 m/s with prop disks (killed before this guard waited).
        assert not Runner._speed_not_physical(501.5, 15.0, it=2, iterations=250)
        assert not Runner._speed_not_physical(1068.0, 25.0, it=2, iterations=500)
        assert not Runner._speed_not_physical(
            1068.0, 25.0, it=Runner.MAX_SPEED_MIN_ITER - 1, iterations=250)

    def test_slow_powered_startup_is_not_judged(self):
        # Measured healthy powered runs, 25 m/s, medium (500 iterations):
        # rebuilt STL — trailing-25 peak 1430 m/s at it 30, settled to 51 by ~70;
        # original CAD — 8030 m/s at ~45 and still 1220 m/s in the trailing
        # window at it 100 (a fixed 100-iteration cutoff killed it), 56 by ~90.
        assert not Runner._speed_not_physical(1430.0, 25.0, it=30, iterations=500)
        assert not Runner._speed_not_physical(1219.7, 25.0, it=100, iterations=500)
        assert not Runner._speed_not_physical(55.9, 25.0, it=200, iterations=500)

    def test_start_scales_with_run_length(self):
        # Never before auto-stop may fire, never before MAX_SPEED_MIN_ITER.
        assert not Runner._speed_not_physical(2.3e4, 25.0, it=199, iterations=500)
        assert Runner._speed_not_physical(2.3e4, 25.0, it=200, iterations=500)
        assert not Runner._speed_not_physical(2.3e4, 25.0, it=99, iterations=250)
        assert Runner._speed_not_physical(2.3e4, 25.0, it=100, iterations=250)

    def test_sustained_jet_is_judged_once_past_startup(self):
        assert Runner._speed_not_physical(2.3e4, 25.0, it=320, iterations=800)
        assert not Runner._speed_not_physical(40.0, 25.0, it=320, iterations=800)
        assert not Runner._speed_not_physical(None, 25.0, it=500, iterations=500)

    def test_guard_waits_for_the_window_to_clear_startup(self):
        from app import post

        assert Runner.MAX_SPEED_MIN_ITER > post.PEAK_WINDOW


class TestConvergenceFlag:
    @staticmethod
    def _converged(cd: float, cd_std: float) -> bool:
        return bool(cd_std <= CONVERGED_REL_TOL * abs(cd)) if cd else False

    def test_oscillating_cd_is_not_converged(self):
        # The failing powered run: mean near zero, enormous scatter.
        assert not self._converged(cd=0.894, cd_std=120.0)

    def test_real_converged_runs_pass(self):
        # Measured: medium powered and fine unpowered on the same frame.
        assert self._converged(cd=0.8939, cd_std=0.00399)
        assert self._converged(cd=0.7360, cd_std=0.00305)

    def test_zero_cd_is_never_called_converged(self):
        assert not self._converged(cd=0.0, cd_std=0.0)

    def test_borderline_is_judged_relative_to_cd(self):
        assert self._converged(cd=1.0, cd_std=0.049)
        assert not self._converged(cd=1.0, cd_std=0.051)


class TestAutostopUnchangedForHealthyRuns:
    def test_settled_series_still_autostops(self):
        cd = [0.9 + 0.0001 * np.sin(i) for i in range(Runner.AUTOSTOP_WINDOW)]
        assert Runner._converged(cd, it=500, iterations=800)

    def test_oscillating_series_never_autostops(self):
        cd = [(-1) ** i * 90.0 for i in range(Runner.AUTOSTOP_WINDOW)]
        assert not Runner._converged(cd, it=700, iterations=800)

    def test_too_early_never_autostops(self):
        cd = [0.9] * Runner.AUTOSTOP_WINDOW
        assert not Runner._converged(cd, it=10, iterations=800)


# Verbatim rows from a real run's postProcessing/maxU/0/fieldMinMax.dat. The
# format is NOT the simple two-column table it is easy to assume: there is a
# string field name and two parenthesised location vectors, which is why a
# plausible-looking parser returned nothing and left the guard permanently inert.
_HEADER = (
    "# Field minima and maxima\n"
    "# Time          \tfield           \tmin             \tlocation(min)   \t"
    "processor       \tmax             \tlocation(max)   \tprocessor       \n"
)
_ROW = (
    "{t}               \tmag(U)          \t0.00000000e+00\t"
    "(-8.37181506e-02 7.48283944e-02 -2.27303827e-02)\t0\t{v:.8e}\t"
    "(2.07614157e-02 1.73571179e-02 -5.56421260e-04)\t4\n"
)


def _write_minmax(tmp_path, values, fo="maxU"):
    d = tmp_path / "postProcessing" / fo / "0"
    d.mkdir(parents=True)
    d.joinpath("fieldMinMax.dat").write_text(
        _HEADER + "".join(_ROW.format(t=i + 1, v=v) for i, v in enumerate(values)))
    return tmp_path


def test_reads_the_real_fieldminmax_format(tmp_path):
    from app import post

    _write_minmax(tmp_path, [23.2, 21.4, 20.9])
    assert post.read_max_speed(tmp_path) == pytest.approx(23.2)


def test_startup_transient_does_not_latch(tmp_path):
    """Measured on a healthy 15 m/s run: 501 m/s at iteration 2, settling to 21.

    Reporting the all-time peak would condemn that run forever, so only the
    trailing window counts.
    """
    from app import post

    values = [23.2, 501.5, 312.8, 222.7] + [21.0] * (post.PEAK_WINDOW + 5)
    assert post.read_max_speed(tmp_path := _write_minmax(tmp_path, values)) \
        == pytest.approx(21.0)
    assert post.read_max_speed(tmp_path) < Runner.MAX_SPEED_FACTOR * 15.0


def test_sustained_cavity_jet_is_still_reported(tmp_path):
    from app import post

    _write_minmax(tmp_path, [2.3e4] * (post.PEAK_WINDOW + 5))
    assert post.read_max_speed(tmp_path) == pytest.approx(2.3e4)
    assert post.read_max_speed(tmp_path) > Runner.MAX_SPEED_FACTOR * 25.0


def test_max_k_reads_its_own_probe(tmp_path):
    from app import post

    _write_minmax(tmp_path, [0.09, 0.11], fo="maxK")
    assert post.read_max_k(tmp_path) == pytest.approx(0.11)


def test_read_max_speed_missing_file_is_unknown_not_zero(tmp_path):
    """None must not be confused with 0.0, or the guard would never fire."""
    from app import post

    assert post.read_max_speed(tmp_path) is None
