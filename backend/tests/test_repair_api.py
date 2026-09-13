"""Repair endpoints end to end, against a throwaway data directory."""
from __future__ import annotations

import os
import sys
import tempfile
import time
from functools import partial
from pathlib import Path

import pytest
import trimesh

if "app.main" in sys.modules:  # pragma: no cover — never touch real run data
    pytest.skip("app.main already imported with the real data dir", allow_module_level=True)
os.environ["WINDTUNNEL_DATA_DIR"] = tempfile.mkdtemp(prefix="wt-test-")

from fastapi.testclient import TestClient  # noqa: E402

from app import main  # noqa: E402
from tests.test_repair import SPHERE, _broken_assembly  # noqa: E402

client = TestClient(main.app)  # no lifespan: startup migrations don't run


def _post(path: str, stl_path: Path):
    with open(stl_path, "rb") as fh:
        return client.post(path, files={"stl": (stl_path.name, fh, "model/stl")})


def test_inspect_endpoint():
    res = _post("/api/stl/inspect", SPHERE)
    assert res.status_code == 200
    assert res.json()["watertight"] is True


def test_inspect_rejects_non_stl():
    res = client.post("/api/stl/inspect", files={"stl": ("x.stl", b"not an stl", "model/stl")})
    assert res.status_code == 422


def test_repair_job_round_trip(tmp_path, monkeypatch):
    monkeypatch.setattr(main.repair, "repair_stl",
                        partial(main.repair.repair_stl, resolution=120,
                                target_triangles=20_000))
    res = _post("/api/repair", _broken_assembly(tmp_path))
    assert res.status_code == 201
    job_id = res.json()["id"]

    deadline = time.time() + 120
    while True:
        job = client.get(f"/api/repair/{job_id}").json()
        if job["status"] != "running" or time.time() > deadline:
            break
        time.sleep(0.2)
    assert job["status"] == "done", job
    assert job["report"]["watertight"] and job["report"]["bodies"] == 1

    stl = client.get(f"/api/repair/{job_id}/stl")
    assert stl.status_code == 200
    out = tmp_path / "from_api.stl"
    out.write_bytes(stl.content)
    assert trimesh.load(out, force="mesh").is_watertight


def test_unknown_job_is_404():
    assert client.get("/api/repair/nope").status_code == 404
    assert client.get("/api/repair/nope/stl").status_code == 404
