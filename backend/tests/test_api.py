"""API endpoints end to end, against a throwaway data directory."""
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


def test_run_is_refused_without_openfoam(monkeypatch):
    monkeypatch.setattr(main.foamenv, "find_openfoam", lambda: None)
    with open(SPHERE, "rb") as fh:
        res = client.post("/api/runs", files={"stl": ("s.stl", fh, "model/stl")},
                          data={"config": '{"unit":"mm","wind_speed":15,"quality":"coarse"}'})
    assert res.status_code == 503
    assert "brew install --cask gerlero/openfoam/openfoam" in res.json()["detail"]
    assert client.get("/api/health").json()["openfoam"] is None


def test_health_reports_openfoam_path(monkeypatch):
    monkeypatch.setattr(main.foamenv, "find_openfoam", lambda: "/opt/homebrew/bin/openfoam")
    assert client.get("/api/health").json()["openfoam"] == "/opt/homebrew/bin/openfoam"


@pytest.mark.parametrize("extra, fragment", [
    ({"mesh_sweep": {"tol_pct": 2}, "trim": {"weight_g": 700}}, "cannot be combined"),
    ({"mesh_sweep": {"tol_pct": 2}, "yaw_sweep": [0, 15]}, "cannot be combined"),
    ({"mesh_sweep": {"tol_pct": 0}}, "tol_pct"),
    ({"mesh_sweep": {"tol_pct": 80}}, "tol_pct"),
    ({"mesh_sweep": "yes"}, "mesh_sweep must be an object"),
])
def test_mesh_sweep_validation(monkeypatch, extra, fragment):
    import json as _json
    monkeypatch.setattr(main.foamenv, "find_openfoam", lambda: "/opt/homebrew/bin/openfoam")
    cfg = {"unit": "mm", "wind_speed": 15, "quality": "coarse", **extra}
    if "trim" in extra:
        cfg["props"] = [{"center": [0, 0, 0], "diameter": 127, "thrust_g": 200}]
    with open(SPHERE, "rb") as fh:
        res = client.post("/api/runs", files={"stl": ("s.stl", fh, "model/stl")},
                          data={"config": _json.dumps(cfg)})
    assert res.status_code == 422, res.text
    assert fragment in res.json()["detail"]


def _post_run(cfg: dict):
    import json as _json
    with open(SPHERE, "rb") as fh:
        return client.post("/api/runs", files={"stl": ("s.stl", fh, "model/stl")},
                           data={"config": _json.dumps(cfg)})


PROPS = [{"center": [0, 0, 0], "diameter": 127, "thrust_g": 200}]


@pytest.mark.parametrize("extra, fragment", [
    ({"refinement": "long"}, "refinement must be an object"),
    ({"refinement": {"wake": True}}, "refinement must be an object"),
    ({"refinement": {"long_wake": 1}}, "refinement must be an object"),
    ({"refinement": {"prop_slipstream": True}}, "requires propeller disks"),
])
def test_refinement_validation(monkeypatch, extra, fragment):
    monkeypatch.setattr(main.foamenv, "find_openfoam", lambda: "/opt/homebrew/bin/openfoam")
    res = _post_run({"unit": "mm", "wind_speed": 15, "quality": "coarse", **extra})
    assert res.status_code == 422, res.text
    assert fragment in res.json()["detail"]


@pytest.mark.parametrize("refinement, stored", [
    ({"long_wake": True, "prop_slipstream": True},
     {"long_wake": True, "prop_slipstream": True}),
    ({"long_wake": True, "prop_slipstream": False}, {"long_wake": True}),
    ({"long_wake": False}, None),
])
def test_refinement_is_normalized_into_run_config(monkeypatch, refinement, stored):
    monkeypatch.setattr(main.foamenv, "find_openfoam", lambda: "/opt/homebrew/bin/openfoam")
    submitted = []
    # Capture the config instead of queuing a real OpenFOAM run.
    monkeypatch.setattr(main, "_submit_run",
                        lambda data, cfg: submitted.append(cfg) or "fake-id")
    res = _post_run({"unit": "mm", "wind_speed": 15, "quality": "coarse",
                     "props": PROPS, "refinement": refinement})
    assert res.status_code == 201, res.text
    assert submitted[0].get("refinement") == stored


# -- re-solve on an existing mesh ---------------------------------------------

QUAD_CFG = {"name": "quad", "unit": "mm", "wind_speed": 15, "quality": "coarse",
            "props": PROPS * 4, "sweep_param": "yaw"}


@pytest.fixture
def finished_run(monkeypatch):
    """A done run with a mesh on disk, plus a captured (never queued) submit."""
    import json as _json
    monkeypatch.setattr(main.foamenv, "find_openfoam", lambda: "/opt/homebrew/bin/openfoam")
    submitted = []
    monkeypatch.setattr(main, "_submit_run",
                        lambda data, cfg, group_id=None: submitted.append(cfg) or "child")
    made = []

    def make(cfg=QUAD_CFG, mesh=True, **state):
        import uuid as _uuid
        rid = f"20260101-000000-{_uuid.uuid4().hex[:6]}"
        rd = main.DATA_DIR / rid
        poly = rd / "case" / "constant" / "polyMesh"
        poly.mkdir(parents=True)
        if mesh:
            (poly / "owner").write_text("mesh")
        (rd / "model.stl").write_bytes(SPHERE.read_bytes())
        (rd / "config.json").write_text(_json.dumps(cfg))
        main.runner.states[rid] = {
            "id": rid, "name": cfg["name"], "status": "done", "progress": 1.0,
            "message": "", "created_at": 0.0, "config": cfg, "group_id": None,
            "model": None, "mesh_cells": 1000, "result": None, "error": None,
            "log": None, **state}
        made.append(rid)
        return rid

    make.submitted = submitted
    yield make
    for rid in made:
        main.runner.states.pop(rid, None)


def test_resolve_inherits_mesh_inputs_and_applies_new_speed_and_thrust(finished_run):
    rid = finished_run()
    assert client.get(f"/api/runs/{rid}").json()["has_mesh"] is True
    res = client.post(f"/api/runs/{rid}/resolve", json={"wind_speed": 25, "thrust_g": 250})
    assert res.status_code == 201, res.text
    cfg, = finished_run.submitted
    assert cfg["mesh_from"] == rid
    assert cfg["wind_speed"] == 25.0
    assert [p["thrust_g"] for p in cfg["props"]] == [250.0] * 4
    assert cfg["name"] == "quad @ 25 m/s re-solve"
    assert cfg["quality"] == "coarse" and "sweep_param" not in cfg


def test_resolve_per_prop_thrust_and_custom_name(finished_run):
    rid = finished_run()
    res = client.post(f"/api/runs/{rid}/resolve",
                      json={"thrust_g": [100, 200, 300, 400], "name": " hover check "})
    assert res.status_code == 201, res.text
    cfg, = finished_run.submitted
    assert [p["thrust_g"] for p in cfg["props"]] == [100.0, 200.0, 300.0, 400.0]
    assert cfg["wind_speed"] == 15.0 and cfg["name"] == "hover check"


def test_resolve_of_a_resolve_keeps_the_base_name(finished_run):
    child_cfg = dict(QUAD_CFG, name="quad @ 25 m/s re-solve", resolve_base_name="quad")
    rid = finished_run(child_cfg)
    assert client.post(f"/api/runs/{rid}/resolve", json={"wind_speed": 10}).status_code == 201
    assert finished_run.submitted[0]["name"] == "quad @ 10 m/s re-solve"


@pytest.mark.parametrize("body, fragment", [
    ({"yaw_deg": 15}, "only wind_speed, thrust_g and name"),
    ({"wind_speed": 0}, "wind_speed must be"),
    ({"thrust_g": [100, 200]}, "list of 4"),
    ({"thrust_g": -1}, "thrust_g must be"),
    ({"name": "  "}, "name must be"),
    ([1, 2], "body must be a JSON object"),
])
def test_resolve_validation(finished_run, body, fragment):
    rid = finished_run()
    res = client.post(f"/api/runs/{rid}/resolve", json=body)
    assert res.status_code == 422, res.text
    assert fragment in res.json()["detail"]
    assert not finished_run.submitted


def test_resolve_thrust_needs_props(finished_run):
    rid = finished_run({k: v for k, v in QUAD_CFG.items() if k != "props"})
    res = client.post(f"/api/runs/{rid}/resolve", json={"thrust_g": 100})
    assert res.status_code == 422 and "propeller disks" in res.json()["detail"]


@pytest.mark.parametrize("kwargs", [
    {"mesh": False},
    {"compacted": True},
    {"mesh_cells": None},
])
def test_resolve_needs_a_mesh_on_disk(finished_run, kwargs):
    rid = finished_run(**kwargs)
    assert client.get(f"/api/runs/{rid}").json()["has_mesh"] is False
    res = client.post(f"/api/runs/{rid}/resolve", json={"wind_speed": 20})
    assert res.status_code == 409 and "Re-run" in res.json()["detail"]


# -- rename -------------------------------------------------------------------

def test_rename_run(finished_run):
    rid = finished_run()
    res = client.patch(f"/api/runs/{rid}", json={"name": "  quad, props at 300 g  "})
    assert res.status_code == 200, res.text
    assert res.json()["name"] == "quad, props at 300 g"
    assert client.get(f"/api/runs/{rid}").json()["name"] == "quad, props at 300 g"
    assert any(r["name"] == "quad, props at 300 g" for r in client.get("/api/runs").json())


@pytest.mark.parametrize("body", [{"name": ""}, {"name": "x" * 201}, {"name": 5},
                                  {"name": "ok", "wind_speed": 20}, {}, [1]])
def test_rename_validation(finished_run, body):
    rid = finished_run()
    assert client.patch(f"/api/runs/{rid}", json=body).status_code == 422
    assert client.get(f"/api/runs/{rid}").json()["name"] == "quad"


def test_rename_unknown_run_is_404():
    assert client.patch("/api/runs/nope", json={"name": "x"}).status_code == 404


# -- motor detection ------------------------------------------------------------

QUAD_STL = Path(__file__).resolve().parents[2] / "examples" / "quad_frame.stl"


def test_detect_props_endpoint_finds_quad_motors():
    with open(QUAD_STL, "rb") as fh:
        res = client.post("/api/stl/props", files={"stl": ("q.stl", fh, "model/stl")},
                          data={"unit": "mm"})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["reason"] is None and len(body["props"]) == 4


def test_detect_props_endpoint_declines_a_sphere():
    res = _post("/api/stl/props", SPHERE)
    assert res.status_code == 200
    assert res.json()["props"] == [] and res.json()["reason"]


def test_detect_props_endpoint_validates_input():
    with open(QUAD_STL, "rb") as fh:
        assert client.post("/api/stl/props", files={"stl": ("q.stl", fh, "model/stl")},
                           data={"unit": "furlong"}).status_code == 422
    assert client.post("/api/stl/props", files={
        "stl": ("x.stl", b"not an stl", "model/stl")}).status_code == 422
