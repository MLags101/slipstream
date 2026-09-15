"""Failed and cancelled runs drop their mesh and fields, keeping logs/history."""
import threading

import pytest

from app import foamcase
from app.runner import Runner


def make_case(case):
    files = {
        "log.snappyHexMesh": "log", "log.simpleFoam": "log",
        "system/controlDict": "dict", "0/U": "field",
        "postProcessing/forces1/0/coefficient.dat": "1 0.5",
        "constant/transportProperties": "nu", "constant/turbulenceProperties": "sst",
        "constant/fvOptions": "disks",
        "constant/polyMesh/owner": "x" * 5000, "constant/polyMesh/cellZones": "z",
        "constant/triSurface/model.stl": "x" * 3000,
        "constant/extendedFeatureEdgeMesh/model.extendedFeatureEdgeMesh": "e",
        "100/U": "x" * 4000, "250.5/p": "x" * 4000,
        "processor0/constant/polyMesh/owner": "x" * 2000,
        "dynamicCode/lib": "so",
    }
    for rel, text in files.items():
        p = case / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)


def remaining(case):
    return sorted(str(p.relative_to(case)) for p in case.rglob("*") if p.is_file())


def test_clean_failed_case_keeps_only_diagnostics(tmp_path):
    case = tmp_path / "case"
    make_case(case)
    freed = foamcase.clean_failed_case(case)
    assert freed >= 5000 + 3000 + 8000 + 2000
    assert remaining(case) == [
        "0/U", "constant/fvOptions", "constant/transportProperties",
        "constant/turbulenceProperties", "log.simpleFoam", "log.snappyHexMesh",
        "postProcessing/forces1/0/coefficient.dat", "system/controlDict"]


def test_clean_failed_case_without_case_dir(tmp_path):
    assert foamcase.clean_failed_case(tmp_path / "missing") == 0


def runner_with(tmp_path, status, **extra):
    runner = Runner.__new__(Runner)
    runner.data_dir = tmp_path
    runner.lock = threading.RLock()
    runner.states = {"r1": {"id": "r1", "status": status, **extra}}
    runner._persist = lambda run_id: None
    make_case(tmp_path / "r1" / "case")
    return runner


@pytest.mark.parametrize("status", ["error", "cancelled"])
def test_failed_runs_are_cleaned_once(tmp_path, status):
    runner = runner_with(tmp_path, status)
    runner._clean_if_failed("r1")
    state = runner.states["r1"]
    assert state["mesh_freed"] is True and state["freed_bytes"] > 0
    assert not (tmp_path / "r1" / "case" / "constant" / "polyMesh").exists()
    # Second call is a no-op (startup migration runs on every launch).
    runner._clean_if_failed("r1")
    assert runner.states["r1"]["freed_bytes"] == state["freed_bytes"]


@pytest.mark.parametrize("status", ["done", "queued", "solving"])
def test_other_runs_keep_their_mesh(tmp_path, status):
    runner = runner_with(tmp_path, status)
    runner._clean_if_failed("r1")
    assert (tmp_path / "r1" / "case" / "constant" / "polyMesh" / "owner").exists()
    assert "mesh_freed" not in runner.states["r1"]
