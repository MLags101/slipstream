"""Trim solver: iterate CFD runs to find the forward-flight trim attitude.

Conventions (see docs/CONTRACT.md):
- Wind flows along +X; drag on the model is +X. pitch_deg rotates the model
  about +Y; the prop thrust axis (model +Z) becomes (sin th, 0, cos th) after
  pitch th. To push thrust upstream (-X) the trim pitch is NEGATIVE.
- Iteration i (th in radians):
    T_i = max(W_N - L_{i-1}, 0.1 * W_N) / cos(th_i)   (split equally over props)
    th_{i+1} = -atan2(D_i, W_N - L_i),   L_0 = 0
    th_1 = -atan2(0.12 * W_N, W_N)
  Converged when |th_{i+1} - th_i| <= tol_deg.
"""
from __future__ import annotations

import json
import math
import threading
import time
from pathlib import Path

G = 9.81
POLL_S = 5.0
DEFAULT_MAX_ITERS = 5
DEFAULT_TOL_DEG = 0.75
INITIAL_DRAG_FRAC = 0.12  # first-guess drag as a fraction of weight (~7 deg)
MIN_THRUST_FRAC = 0.1     # never command less than 10% of weight

# ------------------------------------------------------------- pure math


def weight_N(weight_g: float) -> float:
    return weight_g * G / 1000.0


def initial_pitch_rad(weight_g: float) -> float:
    """th_1 = -atan2(0.12 W, W) - a ~7 degree nose-into-wind initial guess."""
    w = weight_N(weight_g)
    return -math.atan2(INITIAL_DRAG_FRAC * w, w)


def total_thrust_N(weight_g: float, lift_prev_N: float, pitch_rad: float) -> float:
    """T_i = max(W - L_{i-1}, 0.1 W) / cos th_i."""
    w = weight_N(weight_g)
    return max(w - lift_prev_N, MIN_THRUST_FRAC * w) / math.cos(pitch_rad)


def thrust_g_per_prop(weight_g: float, lift_prev_N: float, pitch_rad: float,
                      n_props: int) -> float:
    return total_thrust_N(weight_g, lift_prev_N, pitch_rad) / n_props * 1000.0 / G


def next_pitch_rad(weight_g: float, drag_N: float, lift_N: float) -> float:
    """th_{i+1} = -atan2(D_i, W - L_i)."""
    return -math.atan2(drag_N, weight_N(weight_g) - lift_N)


def is_converged(pitch_rad: float, next_rad: float, tol_deg: float) -> bool:
    return abs(math.degrees(next_rad - pitch_rad)) <= tol_deg


# ------------------------------------------------------------- controller


class TrimController(threading.Thread):
    """One background thread per trim job.

    Waits for each iteration run to settle (polling runner.get), computes the
    next pitch/thrust, submits the next member run into the shared group, and
    on convergence / max_iters / error writes trim_summary.json into the FIRST
    iteration run's directory. A controller lost to a server restart simply
    leaves the group without a summary (reported as incomplete).
    """

    def __init__(self, runner, submit, base_cfg: dict, trim_cfg: dict,
                 group_id: str, first_run_id: str, first_pitch_rad: float,
                 summary_dir: str | Path):
        super().__init__(daemon=True, name=f"trim-{group_id[:8]}")
        self.runner = runner
        self.submit = submit          # callable(cfg) -> run_id (shares group_id)
        self.base_cfg = base_cfg      # original config: base name, original props
        self.trim_cfg = trim_cfg      # {"weight_g", "max_iters", "tol_deg"}
        self.group_id = group_id
        self.first_run_id = first_run_id
        self.first_pitch_rad = first_pitch_rad
        self.summary_path = Path(summary_dir) / "trim_summary.json"
        self._history: list[dict] = []
        self._theta = first_pitch_rad

    # -- lifecycle ---------------------------------------------------------

    def run(self) -> None:  # noqa: A003 - Thread API
        try:
            self._solve()
        except Exception as exc:  # noqa: BLE001 - survive member run errors
            self._write_summary(converged=False, iterations=len(self._history),
                                pitch_rad=self._theta, error=str(exc))

    def _wait_for(self, run_id: str) -> dict:
        """Block until the member run settles; return its result dict."""
        while True:
            state = self.runner.get(run_id)
            if state is None:
                raise RuntimeError(f"iteration run {run_id} was deleted")
            if state["status"] == "error":
                raise RuntimeError(
                    f"iteration run {run_id} failed: {state.get('error')}")
            if state["status"] == "done" and state.get("result"):
                return state["result"]
            time.sleep(POLL_S)

    # -- solve loop ----------------------------------------------------------

    def _solve(self) -> None:
        weight_g = float(self.trim_cfg["weight_g"])
        tol_deg = float(self.trim_cfg["tol_deg"])
        max_iters = int(self.trim_cfg["max_iters"])
        n_props = len(self.base_cfg["props"])

        # Thrust the first run flew with (L_0 = 0).
        applied_tg = thrust_g_per_prop(weight_g, 0.0, self._theta, n_props)
        run_id = self.first_run_id

        for i in range(1, max_iters + 1):
            result = self._wait_for(run_id)
            drag, lift = float(result["drag_N"]), float(result["lift_N"])
            self._history.append({
                "pitch_deg": math.degrees(self._theta),
                "drag_N": drag, "lift_N": lift,
                "thrust_g_per_prop": applied_tg,
            })
            theta_next = next_pitch_rad(weight_g, drag, lift)
            done = is_converged(self._theta, theta_next, tol_deg)
            if done or i == max_iters:
                self._write_summary(converged=done, iterations=i,
                                    pitch_rad=theta_next, drag_N=drag,
                                    lift_N=lift)
                return
            self._theta = theta_next
            applied_tg = thrust_g_per_prop(weight_g, lift, self._theta, n_props)
            run_id = self.submit(self._iteration_cfg(i + 1, applied_tg))

    def _iteration_cfg(self, iteration: int, thrust_g: float) -> dict:
        cfg = dict(self.base_cfg)
        cfg["pitch_deg"] = math.degrees(self._theta)
        cfg["props"] = [dict(p, thrust_g=thrust_g) for p in self.base_cfg["props"]]
        cfg["name"] = f"{self.base_cfg['name']} @ trim {iteration}"
        cfg["sweep_param"] = "pitch"
        cfg["trim"] = self.trim_cfg
        return cfg

    # -- summary ---------------------------------------------------------------

    def _write_summary(self, converged: bool, iterations: int,
                       pitch_rad: float, drag_N: float | None = None,
                       lift_N: float | None = None,
                       error: str | None = None) -> None:
        weight_g = float(self.trim_cfg["weight_g"])
        n_props = len(self.base_cfg["props"])
        total_T = thrust_g = None
        if lift_N is not None:
            total_T = total_thrust_N(weight_g, lift_N, pitch_rad)
            thrust_g = total_T / n_props * 1000.0 / G
        summary = {
            "converged": converged,
            "iterations": iterations,
            "trim_pitch_deg": math.degrees(pitch_rad),
            "tilt_deg": abs(math.degrees(pitch_rad)),
            "total_thrust_N": total_T,
            "thrust_g_per_prop": thrust_g,
            "drag_N": drag_N,
            "lift_N": lift_N,
            "weight_g": weight_g,
            "wind_speed": self.base_cfg.get("wind_speed"),
            "history": self._history,
            "error": error,
        }
        try:
            self.summary_path.write_text(json.dumps(summary, indent=1))
        except OSError:
            pass
