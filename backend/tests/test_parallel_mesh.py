"""Meshing stage: snappyHexMesh on NPROCS ranks with serial fallbacks."""
from pathlib import Path

import pytest

from app import foamcase
from app.runner import Runner

N = foamcase.NPROCS
PARALLEL = f"mpirun -np {N} snappyHexMesh -parallel -overwrite"
SERIAL = "snappyHexMesh -overwrite"
STARTED = Runner.SNAPPY_STARTED + "\nRefinement phase\n"


class FakeFoam:
    """Stands in for Runner._foam: records commands, fails on request and
    mimics the processor*/ directories decomposePar creates."""

    def __init__(self, fail=None):
        self.fail = list(fail or [])  # [(command, log text)] consumed in order
        self.calls = []

    def __call__(self, case: Path, cmd: str, log_name: str, run_id: str,
                 progress_cb=None, check: bool = True) -> int:
        self.calls.append(cmd)
        rc, text = 0, STARTED
        if self.fail and self.fail[0][0] == cmd:
            rc, text = 1, self.fail.pop(0)[1]
        (case / log_name).write_text(text)
        if cmd.startswith("decomposePar"):
            for i in range(N):
                (case / f"processor{i}").mkdir(exist_ok=True)
        if check and rc:
            raise RuntimeError(f"{cmd} failed")
        return rc


@pytest.fixture
def case(tmp_path):
    (tmp_path / "system").mkdir()
    (tmp_path / "system" / "snappyHexMeshDict").write_text("addLayers       true;\n")
    return tmp_path


def mesh(case, foam, monkeypatch, serial_env=False):
    if serial_env:
        monkeypatch.setenv("WINDTUNNEL_SERIAL_MESH", "1")
    else:
        monkeypatch.delenv("WINDTUNNEL_SERIAL_MESH", raising=False)
    runner = Runner.__new__(Runner)  # no data dir, no worker thread
    messages = []
    runner.update = lambda run_id, **kw: messages.append(kw.get("message"))
    runner._foam = foam
    runner._mesh(case, "r1")
    return messages


def layers_on(case):
    return "addLayers       true;" in (case / "system" / "snappyHexMeshDict").read_text()


def test_parallel_mesh_is_merged_back(case, monkeypatch):
    foam = FakeFoam()
    messages = mesh(case, foam, monkeypatch)
    assert foam.calls == ["surfaceFeatureExtract", "blockMesh", "decomposePar -force",
                          PARALLEL, "reconstructParMesh -constant"]
    assert not list(case.glob("processor*"))
    assert layers_on(case)
    assert f"Snapping mesh to geometry on {N} cores (snappyHexMesh)" in messages


def test_parallel_layer_failure_retries_in_parallel_without_layers(case, monkeypatch):
    foam = FakeFoam(fail=[(PARALLEL, STARTED + "layer addition failed\n")])
    mesh(case, foam, monkeypatch)
    assert foam.calls == ["surfaceFeatureExtract", "blockMesh", "decomposePar -force",
                          PARALLEL, "decomposePar -force", PARALLEL,
                          "reconstructParMesh -constant"]
    assert not layers_on(case)
    assert not list(case.glob("processor*"))


def test_mpi_that_never_starts_snappy_falls_back_to_serial(case, monkeypatch):
    foam = FakeFoam(fail=[(PARALLEL, "mpirun: not enough slots available\n")])
    messages = mesh(case, foam, monkeypatch)
    assert foam.calls == ["surfaceFeatureExtract", "blockMesh", "decomposePar -force",
                          PARALLEL, SERIAL]
    assert layers_on(case)  # layers were never the problem
    assert not list(case.glob("processor*"))
    assert "Parallel meshing did not start - meshing on one core" in messages


def test_second_parallel_failure_is_an_error(case, monkeypatch):
    foam = FakeFoam(fail=[(PARALLEL, STARTED), (PARALLEL, STARTED)])
    with pytest.raises(RuntimeError):
        mesh(case, foam, monkeypatch)
    assert "reconstructParMesh -constant" not in foam.calls


def test_serial_env_keeps_the_old_path(case, monkeypatch):
    foam = FakeFoam(fail=[(SERIAL, STARTED)])
    mesh(case, foam, monkeypatch, serial_env=True)
    assert foam.calls == ["surfaceFeatureExtract", "blockMesh", SERIAL, SERIAL]
    assert not layers_on(case)


# -- re-solve: reuse another run's mesh ---------------------------------------

def reuse_runner(data_dir):
    import threading
    runner = Runner.__new__(Runner)
    runner.data_dir = data_dir
    runner.lock = threading.RLock()
    runner.states = {"src": {"id": "src", "name": "quad"}}
    runner.messages = []
    runner.update = lambda run_id, **kw: runner.messages.append(kw.get("message"))
    return runner


def test_reuse_mesh_copies_mesh_without_prop_zones(tmp_path):
    src = tmp_path / "src" / "case" / "constant" / "polyMesh"
    (src / "sets").mkdir(parents=True)
    for name in ("owner", "neighbour", "faces", "points", "boundary", "cellZones"):
        (src / name).write_text(name)
    (src / "sets" / "disk1Cells").write_text("cells")
    case = tmp_path / "child" / "case"
    (case / "constant" / "polyMesh").mkdir(parents=True)
    (case / "constant" / "polyMesh" / "blockmesh-leftover").write_text("old")

    runner = reuse_runner(tmp_path)
    runner._reuse_mesh(case, "src", "child")
    dst = case / "constant" / "polyMesh"
    assert sorted(p.name for p in dst.iterdir()) == [
        "boundary", "faces", "neighbour", "owner", "points"]
    assert "Reusing mesh from quad" in runner.messages


def test_reuse_mesh_fails_clearly_when_source_is_gone(tmp_path):
    case = tmp_path / "child" / "case"
    (case / "constant").mkdir(parents=True)
    with pytest.raises(RuntimeError, match="Re-run"):
        reuse_runner(tmp_path)._reuse_mesh(case, "src", "child")
