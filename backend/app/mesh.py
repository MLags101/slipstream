"""Mesh-independence sweep: rerun one setup at finer meshes until Cd settles.

A CFD answer depends on cell size until the mesh is fine enough that refining
further barely changes it. The sweep runs the same configuration at coarse,
then medium, then fine, and stops as soon as one refinement step changes Cd by
no more than `tol_pct`:

  - coarse -> medium within tol: independent at coarse (medium confirms it)
  - medium -> fine within tol:   independent at medium (fine confirms it)
  - still above tol at fine:     not independent within the available presets

The best estimate is always the finest finished run. Members share a group_id
and the summary is written as mesh_summary.json in the FIRST run's directory,
the same pattern the trim solver uses. A controller lost to a server restart
leaves the group without a summary (reported as incomplete).
"""
from __future__ import annotations

import json
import math
import threading
import time
from pathlib import Path

QUALITIES = ("coarse", "medium", "fine")
DEFAULT_TOL_PCT = 2.0
POLL_S = 5.0

# ------------------------------------------------------------- pure logic


def change_pct(prev_cd: float, cur_cd: float) -> float:
    """Relative change of Cd on refinement, in percent of the finer value."""
    if cur_cd == 0:
        return 0.0 if prev_cd == 0 else math.inf
    return abs(cur_cd - prev_cd) / abs(cur_cd) * 100.0


def next_step(cds: list[float], tol_pct: float) -> tuple[str, str | None]:
    """Decide what to do after `cds` (one Cd per finished quality, in order).

    Returns ("submit", quality), ("independent", coarsest_trusted_quality) or
    ("not_independent", None).
    """
    n = len(cds)
    # Inclusive, with a hair of slack: 1.02 -> 1.00 is "2%" to a person but
    # 2.0000000000000018 in floating point.
    if n >= 2 and change_pct(cds[-2], cds[-1]) <= tol_pct + 1e-9:
        return "independent", QUALITIES[n - 2]
    if n >= len(QUALITIES):
        return "not_independent", None
    return "submit", QUALITIES[n]


def member_cfg(base_cfg: dict, quality: str) -> dict:
    cfg = dict(base_cfg)
    cfg["quality"] = quality
    cfg["name"] = f"{base_cfg['name']} @ {quality} mesh"
    cfg["sweep_param"] = "quality"
    return cfg


# ------------------------------------------------------------- controller


class MeshSweepController(threading.Thread):
    """One background thread per mesh sweep; mirrors trim.TrimController."""

    def __init__(self, runner, submit, base_cfg: dict, group_id: str,
                 first_run_id: str, summary_dir: str | Path,
                 poll_s: float = POLL_S):
        super().__init__(daemon=True, name=f"mesh-{group_id[:8]}")
        self.runner = runner
        self.submit = submit            # callable(cfg) -> run_id (shares group_id)
        self.base_cfg = base_cfg
        self.tol_pct = float(base_cfg["mesh_sweep"]["tol_pct"])
        self.group_id = group_id
        self.first_run_id = first_run_id
        self.summary_path = Path(summary_dir) / "mesh_summary.json"
        self.poll_s = poll_s
        self._history: list[dict] = []

    def run(self) -> None:  # noqa: A003 - Thread API
        try:
            self._sweep()
        except Exception as exc:  # noqa: BLE001 - survive member run errors
            self._write_summary("failed", error=str(exc))

    def _wait_for(self, run_id: str) -> dict:
        while True:
            state = self.runner.get(run_id)
            if state is None:
                raise RuntimeError(f"mesh sweep run {run_id} was deleted")
            if state["status"] in ("error", "cancelled"):
                raise RuntimeError(
                    f"{state['config'].get('quality', 'mesh sweep')} run "
                    f"{state['status']}: {state.get('error') or 'cancelled'}")
            if state["status"] == "done" and state.get("result"):
                return state["result"]
            time.sleep(self.poll_s)

    def _sweep(self) -> None:
        run_id = self.first_run_id
        for quality in QUALITIES:
            result = self._wait_for(run_id)
            cd = float(result["cd"])
            prev = self._history[-1]["cd"] if self._history else None
            self._history.append({
                "quality": quality,
                "mesh_cells": result.get("mesh_cells"),
                "cd": cd,
                "drag_N": result.get("drag_N"),
                "converged": result.get("converged"),
                "change_pct": None if prev is None else change_pct(prev, cd),
            })
            action, arg = next_step([h["cd"] for h in self._history], self.tol_pct)
            if action == "submit":
                run_id = self.submit(member_cfg(self.base_cfg, arg))
                continue
            self._write_summary(action, independent_at=arg)
            return

    def _write_summary(self, status: str, independent_at: str | None = None,
                       error: str | None = None) -> None:
        summary = {
            "status": status,
            "independent_at": independent_at,
            "best_cd": self._history[-1]["cd"] if self._history else None,
            "tol_pct": self.tol_pct,
            "steps": len(self._history),
            "history": self._history,
            "error": error,
        }
        try:
            self.summary_path.write_text(json.dumps(summary, indent=1))
        except OSError:
            pass
