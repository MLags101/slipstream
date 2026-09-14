"""Mesh-independence sweep: stopping rule and controller, without OpenFOAM."""
from __future__ import annotations

import json
import math

import pytest

from app import mesh


def test_change_pct_is_relative_to_the_finer_value():
    assert mesh.change_pct(0.906, 0.894) == pytest.approx(1.342, abs=1e-3)
    assert mesh.change_pct(1.0, 1.0) == 0.0
    assert mesh.change_pct(0.0, 0.0) == 0.0
    assert math.isinf(mesh.change_pct(0.1, 0.0))


@pytest.mark.parametrize("cds, expect", [
    ([0.90], ("submit", "medium")),
    ([0.906, 0.894], ("independent", "coarse")),        # 1.3% <= 2%
    ([0.779, 0.740], ("submit", "fine")),               # 5.3% > 2%
    ([0.779, 0.740, 0.736], ("independent", "medium")),  # 0.5% <= 2%
    ([0.70, 0.80, 0.90], ("not_independent", None)),    # still 11% at fine
])
def test_next_step(cds, expect):
    assert mesh.next_step(cds, tol_pct=2.0) == expect


def test_tolerance_is_inclusive():
    assert mesh.next_step([1.02, 1.0], tol_pct=2.0) == ("independent", "coarse")


def test_member_cfg_sets_quality_and_name():
    base = {"name": "quad", "quality": "fine", "wind_speed": 15,
            "mesh_sweep": {"tol_pct": 2.0}}
    cfg = mesh.member_cfg(base, "medium")
    assert cfg["quality"] == "medium"
    assert cfg["name"] == "quad @ medium mesh"
    assert cfg["sweep_param"] == "quality"
    assert base["quality"] == "fine"  # base untouched


class FakeRunner:
    """Finishes every submitted run instantly with a preset Cd per quality."""

    def __init__(self, cds_by_quality, fail_quality=None):
        self.cds = cds_by_quality
        self.fail_quality = fail_quality
        self.states = {}
        self.submitted = []

    def add(self, cfg):
        run_id = f"run-{len(self.states)}"
        q = cfg["quality"]
        if q == self.fail_quality:
            self.states[run_id] = {"status": "error", "error": "boom", "config": cfg}
        else:
            self.states[run_id] = {
                "status": "done", "config": cfg,
                "result": {"cd": self.cds[q], "drag_N": self.cds[q] * 2,
                           "mesh_cells": {"coarse": 3e5, "medium": 1.2e6, "fine": 4e6}[q],
                           "converged": True},
            }
        self.submitted.append(q)
        return run_id

    def get(self, run_id):
        return self.states.get(run_id)


def _run_controller(tmp_path, runner):
    base = {"name": "quad", "wind_speed": 15, "mesh_sweep": {"tol_pct": 2.0}}
    first = runner.add(mesh.member_cfg(base, "coarse"))
    ctl = mesh.MeshSweepController(runner=runner, submit=runner.add, base_cfg=base,
                                   group_id="g" * 32, first_run_id=first,
                                   summary_dir=tmp_path, poll_s=0.0)
    ctl.run()  # synchronously
    return json.loads((tmp_path / "mesh_summary.json").read_text())


def test_controller_stops_at_first_settled_refinement(tmp_path):
    runner = FakeRunner({"coarse": 0.779, "medium": 0.740, "fine": 0.736})
    summary = _run_controller(tmp_path, runner)
    assert runner.submitted == ["coarse", "medium", "fine"]
    assert summary["status"] == "independent"
    assert summary["independent_at"] == "medium"
    assert summary["best_cd"] == 0.736
    assert [h["quality"] for h in summary["history"]] == ["coarse", "medium", "fine"]
    assert summary["history"][0]["change_pct"] is None
    assert summary["history"][2]["change_pct"] == pytest.approx(0.543, abs=1e-3)


def test_controller_skips_fine_when_medium_confirms_coarse(tmp_path):
    runner = FakeRunner({"coarse": 0.906, "medium": 0.894, "fine": 0.0})
    summary = _run_controller(tmp_path, runner)
    assert runner.submitted == ["coarse", "medium"]
    assert summary["status"] == "independent" and summary["independent_at"] == "coarse"


def test_controller_reports_not_independent(tmp_path):
    runner = FakeRunner({"coarse": 0.70, "medium": 0.80, "fine": 0.90})
    summary = _run_controller(tmp_path, runner)
    assert summary["status"] == "not_independent"
    assert summary["independent_at"] is None and summary["steps"] == 3


def test_controller_reports_a_failed_member(tmp_path):
    runner = FakeRunner({"coarse": 0.70, "medium": 0.80}, fail_quality="medium")
    summary = _run_controller(tmp_path, runner)
    assert summary["status"] == "failed"
    assert "medium" in summary["error"] and "boom" in summary["error"]
    assert summary["steps"] == 1
