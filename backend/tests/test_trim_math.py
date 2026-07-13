"""Unit tests for the trim solver's pure iteration math (app/trim.py).

Run from backend/:  .venv/bin/python tests/test_trim_math.py
(also collectable by pytest if available — plain asserts, no fixtures).
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import trim  # noqa: E402

G = 9.81


def test_initial_pitch():
    # th_1 = -atan2(0.12 W, W) ~ -6.84 deg, independent of weight.
    for w in (300, 700, 2500):
        deg = math.degrees(trim.initial_pitch_rad(w))
        assert abs(deg - (-6.8428)) < 0.01, deg


def test_first_thrust():
    # L_0 = 0: T_1 = W / cos th_1, split over 4 props, in grams.
    weight_g = 700.0
    th1 = trim.initial_pitch_rad(weight_g)
    w = weight_g * G / 1000.0
    expect_total = w / math.cos(th1)
    assert abs(trim.total_thrust_N(weight_g, 0.0, th1) - expect_total) < 1e-12
    tg = trim.thrust_g_per_prop(weight_g, 0.0, th1, 4)
    assert abs(tg - expect_total / 4 * 1000 / G) < 1e-9
    assert abs(tg - 176.25) < 0.05, tg  # ~176 g/prop for 700 g craft


def test_thrust_floor():
    # Huge positive lift: thrust clamps at 0.1 W / cos th.
    weight_g = 700.0
    w = weight_g * G / 1000.0
    t = trim.total_thrust_N(weight_g, lift_prev_N=2 * w, pitch_rad=-0.1)
    assert abs(t - 0.1 * w / math.cos(-0.1)) < 1e-12


def test_next_pitch_sign_and_value():
    # Drag +X, thrust must lean upstream: next pitch is NEGATIVE.
    weight_g = 700.0
    w = weight_g * G / 1000.0
    th = trim.next_pitch_rad(weight_g, drag_N=0.8, lift_N=-0.5)
    assert th < 0
    assert abs(th - (-math.atan2(0.8, w - (-0.5)))) < 1e-12
    # Zero drag trims level.
    assert trim.next_pitch_rad(weight_g, 0.0, 0.0) == 0.0


def test_convergence_check():
    tol = 0.75
    a = math.radians(-7.0)
    assert trim.is_converged(a, math.radians(-7.5), tol)
    assert trim.is_converged(a, math.radians(-6.3), tol)
    assert not trim.is_converged(a, math.radians(-8.0), tol)


def _iterate(weight_g, aero, max_iters=5, tol_deg=0.75, n_props=4):
    """Mirror TrimController._solve using a fake aero response.

    aero(pitch_deg, thrust_g_per_prop) -> (drag_N, lift_N)
    Returns (converged, iterations, final_pitch_deg, history).
    """
    theta = trim.initial_pitch_rad(weight_g)
    applied_tg = trim.thrust_g_per_prop(weight_g, 0.0, theta, n_props)
    history = []
    for i in range(1, max_iters + 1):
        drag, lift = aero(math.degrees(theta), applied_tg)
        history.append({"pitch_deg": math.degrees(theta), "drag_N": drag,
                        "lift_N": lift, "thrust_g_per_prop": applied_tg})
        theta_next = trim.next_pitch_rad(weight_g, drag, lift)
        if trim.is_converged(theta, theta_next, tol_deg) or i == max_iters:
            return (trim.is_converged(theta, theta_next, tol_deg), i,
                    math.degrees(theta_next), history)
        theta = theta_next
        applied_tg = trim.thrust_g_per_prop(weight_g, lift, theta, n_props)
    raise AssertionError("unreachable")


def test_converges_on_smooth_aero():
    # Smooth fake craft: drag grows mildly with |pitch|, small download.
    weight_g = 700.0
    w = weight_g * G / 1000.0

    def aero(pitch_deg, tg):
        drag = 0.9 + 0.01 * abs(pitch_deg)          # N
        lift = -0.05 * w - 0.002 * tg               # prop-wash download
        return drag, lift

    converged, iters, pitch_deg, hist = _iterate(weight_g, aero)
    assert converged, hist
    assert iters <= 3, iters
    assert pitch_deg < 0
    # Fixed point: th* = -atan2(D, W - L) with D, L at the last iteration.
    d, l = hist[-1]["drag_N"], hist[-1]["lift_N"]
    assert abs(pitch_deg - math.degrees(-math.atan2(d, w - l))) < 1e-9
    # History records the thrust each run actually flew with.
    assert abs(hist[0]["thrust_g_per_prop"]
               - trim.thrust_g_per_prop(weight_g, 0.0,
                                        trim.initial_pitch_rad(weight_g), 4)) < 1e-9


def test_max_iters_cap():
    # Oscillating aero never converges: stops at max_iters, converged False.
    weight_g = 700.0
    state = {"n": 0}

    def aero(pitch_deg, tg):
        state["n"] += 1
        return (3.0 if state["n"] % 2 else 0.2), -0.3

    converged, iters, _, hist = _iterate(weight_g, aero, max_iters=4,
                                         tol_deg=0.1)
    assert not converged
    assert iters == 4
    assert len(hist) == 4


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items())
           if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"ok  {fn.__name__}")
    print(f"\n{len(fns)} trim math tests passed")
