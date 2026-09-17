"""Exact supersonic shock relations, and measuring a shock angle from a solved
case.

This is the validation kit for the compressible work in
docs/ROADMAP_COMPRESSIBLE.md. A wedge and a cone in supersonic flow both have
closed-form shock angles, so a solver can be checked against theory rather than
against a digitized chart:

  * wedge — the theta-beta-Mach relation, exact and algebraic
  * cone  — Taylor-Maccoll, exact but needs an ODE integration

Run this file directly to check both against known values:

    backend/.venv/bin/python examples/validation/supersonic.py
"""
from __future__ import annotations

import math

import numpy as np
from scipy.integrate import solve_ivp
from scipy.optimize import brentq

GAMMA = 1.4


# ---------------------------------------------------------------------------
# Wedge: the theta-beta-Mach relation
# ---------------------------------------------------------------------------

def wedge_deflection(beta_rad: float, mach: float, gamma: float = GAMMA) -> float:
    """Flow deflection (rad) produced by an oblique shock at angle `beta`.

        tan(theta) = 2 cot(beta) (M^2 sin^2(beta) - 1)
                     / (M^2 (gamma + cos(2 beta)) + 2)
    """
    m2s2 = (mach * math.sin(beta_rad)) ** 2
    num = 2.0 / math.tan(beta_rad) * (m2s2 - 1.0)
    den = mach ** 2 * (gamma + math.cos(2.0 * beta_rad)) + 2.0
    return math.atan2(num, den)


def wedge_shock_angle(mach: float, half_angle_deg: float,
                      gamma: float = GAMMA) -> float:
    """Weak-solution oblique shock angle (deg) for a wedge.

    The theta-beta-M relation has two roots; the weak one (the smaller beta,
    the one nature picks for an attached shock) is bracketed between the Mach
    angle and the deflection maximum.
    """
    theta = math.radians(half_angle_deg)
    mach_angle = math.asin(1.0 / mach)
    # beta at maximum deflection separates the weak and strong branches.
    betas = np.linspace(mach_angle + 1e-9, math.pi / 2 - 1e-9, 20000)
    defl = np.array([wedge_deflection(b, mach, gamma) for b in betas])
    i_max = int(np.argmax(defl))
    if theta > defl[i_max]:
        raise ValueError(
            f"no attached shock: {half_angle_deg}deg exceeds the "
            f"{math.degrees(defl[i_max]):.2f}deg maximum at Mach {mach}")
    root = brentq(lambda b: wedge_deflection(b, mach, gamma) - theta,
                  betas[0], betas[i_max])
    return math.degrees(root)


# ---------------------------------------------------------------------------
# Cone: Taylor-Maccoll
# ---------------------------------------------------------------------------

def _post_shock_state(beta_rad: float, mach: float, gamma: float):
    """Velocity components just behind an oblique shock at angle `beta`,
    non-dimensionalized by the maximum (total) velocity, in the spherical
    frame Taylor-Maccoll uses."""
    theta = wedge_deflection(beta_rad, mach, gamma)
    mn1 = mach * math.sin(beta_rad)
    mn2_sq = (1.0 + 0.5 * (gamma - 1.0) * mn1 ** 2) / (
        gamma * mn1 ** 2 - 0.5 * (gamma - 1.0))
    m2 = math.sqrt(mn2_sq) / math.sin(beta_rad - theta)
    # v/vmax from Mach number
    v_vmax = 1.0 / math.sqrt(1.0 + 2.0 / ((gamma - 1.0) * m2 ** 2))
    # Components along and normal to the ray at angle beta.
    vr = v_vmax * math.cos(beta_rad - theta)
    vtheta = -v_vmax * math.sin(beta_rad - theta)
    return vr, vtheta


def _taylor_maccoll(theta: float, y, gamma: float):
    """dV/dtheta for the Taylor-Maccoll equation, y = [vr, vtheta]."""
    vr, vt = y
    a = 0.5 * (gamma - 1.0) * (1.0 - vr * vr - vt * vt)
    dvt = (vt * vt * vr - a * (2.0 * vr + vt / math.tan(theta))) / (a - vt * vt)
    return [vt, dvt]


def cone_shock_angle(mach: float, half_angle_deg: float,
                     gamma: float = GAMMA) -> float:
    """Shock angle (deg) for a sharp cone at zero incidence, by integrating
    Taylor-Maccoll inward from a guessed shock angle until the flow becomes
    tangent to the cone. A cone's shock sits closer to the body than a wedge's
    of the same half-angle, because the flow can relieve in three dimensions.
    """
    cone = math.radians(half_angle_deg)

    def tangency(beta_deg: float) -> float:
        beta = math.radians(beta_deg)
        vr, vt = _post_shock_state(beta, mach, gamma)

        def hit_cone(theta, y, *_):
            return y[1]  # vtheta = 0 means flow is parallel to the ray
        hit_cone.terminal = True
        hit_cone.direction = 1
        sol = solve_ivp(_taylor_maccoll, [beta, cone * 0.5], [vr, vt],
                        args=(gamma,), events=hit_cone, rtol=1e-10, atol=1e-12,
                        max_step=math.radians(0.05))
        if sol.t_events[0].size:
            return sol.t_events[0][0] - cone  # surface ray minus the cone
        return -cone  # never turned: shock guessed too weak

    lo = math.degrees(math.asin(1.0 / mach)) + 1e-6
    hi = wedge_shock_angle(mach, half_angle_deg, gamma)
    return brentq(tangency, lo, hi, xtol=1e-10)


# ---------------------------------------------------------------------------
# Measuring a shock angle out of a solved case
# ---------------------------------------------------------------------------

def measure_shock_angle(centers: np.ndarray, rho: np.ndarray,
                        apex: tuple[float, float] = (0.0, 0.0),
                        x_frac: tuple[float, float] = (0.35, 0.9),
                        n_stations: int = 25) -> dict:
    """Shock angle (deg) from a density field, by finding the density-gradient
    ridge at a series of x stations and fitting a line through the apex.

    `centers` is (N, 3) cell centers, `rho` the matching density. Only the
    downstream part of the domain is used, where the shock is established and
    away from the outlet.
    """
    x, y = centers[:, 0], centers[:, 1]
    x0 = apex[0] + x_frac[0] * (x.max() - apex[0])
    x1 = apex[0] + x_frac[1] * (x.max() - apex[0])
    stations = np.linspace(x0, x1, n_stations)
    # Column width: a couple of cells either side of the station.
    half = 0.5 * (stations[1] - stations[0])
    xs, ys = [], []
    for xc in stations:
        m = np.abs(x - xc) <= half
        if m.sum() < 8:
            continue
        yy, rr = y[m], rho[m]
        order = np.argsort(yy)
        yy, rr = yy[order], rr[order]
        grad = np.abs(np.gradient(rr, yy))
        j = int(np.argmax(grad))
        xs.append(xc)
        ys.append(yy[j])
    if len(xs) < 5:
        raise RuntimeError("not enough stations resolved a shock")
    xs, ys = np.array(xs), np.array(ys)
    # Fit through the apex: the shock springs from it, so fit slope only.
    dx, dy = xs - apex[0], ys - apex[1]
    slope = float(np.sum(dx * dy) / np.sum(dx * dx))
    resid = dy - slope * dx
    return {
        "angle_deg": math.degrees(math.atan(slope)),
        "stations": len(xs),
        "residual_m": float(np.sqrt(np.mean(resid ** 2))),
    }


if __name__ == "__main__":
    # Published check values (Anderson, Modern Compressible Flow, tables).
    for mach, wedge, expect in [(2.0, 15.0, 45.34), (5.0, 15.0, 24.31),
                                (3.0, 20.0, 37.76)]:
        got = wedge_shock_angle(mach, wedge)
        print(f"wedge M={mach} theta={wedge}deg -> beta={got:.2f}deg "
              f"(expected ~{expect})")
    # Cone values are harder to source than wedge ones; M=2 at 15 deg is the
    # classic textbook case. For others, the check is that the cone's shock
    # lies between the Mach angle and the wedge solution — a cone relieves in
    # three dimensions, so its shock always sits closer to the body.
    for mach, cone in [(2.0, 15.0), (5.0, 15.0), (3.0, 20.0)]:
        got = cone_shock_angle(mach, cone)
        mach_angle = math.degrees(math.asin(1.0 / mach))
        wedge = wedge_shock_angle(mach, cone)
        ok = mach_angle < got < wedge
        note = "expected ~33.9" if (mach, cone) == (2.0, 15.0) else (
            f"between {mach_angle:.1f} and {wedge:.1f}: {'ok' if ok else 'WRONG'}")
        print(f"cone  M={mach} half={cone}deg -> beta={got:.2f}deg ({note})")
