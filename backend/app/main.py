"""WindTunnel backend - FastAPI app. Filesystem is the store; no DB, no auth."""
from __future__ import annotations

import json
import math
import shutil
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response

from . import foamcase, ondemand, post
from .runner import Runner

DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "runs"

app = FastAPI(title="WindTunnel backend")
runner = Runner(DATA_DIR)

VALID_UNITS = {"mm", "cm", "m", "in"}
VALID_QUALITY = {"coarse", "medium", "fine"}


def _get_state(run_id: str) -> dict:
    state = runner.get(run_id)
    if state is None:
        raise HTTPException(404, "run not found")
    return state


@app.post("/api/runs", status_code=201)
async def create_run(stl: UploadFile, config: str = Form(...)):
    try:
        cfg = json.loads(config)
    except json.JSONDecodeError:
        raise HTTPException(422, "config is not valid JSON")

    unit = cfg.get("unit")
    quality = cfg.get("quality")
    if unit not in VALID_UNITS:
        raise HTTPException(422, f"unit must be one of {sorted(VALID_UNITS)}")
    if quality not in VALID_QUALITY:
        raise HTTPException(422, f"quality must be one of {sorted(VALID_QUALITY)}")
    try:
        wind_speed = float(cfg["wind_speed"])
        if not (0 < wind_speed < 200):
            raise ValueError
    except (KeyError, TypeError, ValueError):
        raise HTTPException(422, "wind_speed must be a number in (0, 200) m/s")
    cfg.setdefault("name", stl.filename or "unnamed")
    cfg.setdefault("yaw_deg", 0)
    cfg.setdefault("rho", 1.225)
    cfg.setdefault("nu", 1.5e-5)

    yaw_sweep = cfg.pop("yaw_sweep", None)
    if yaw_sweep is not None:
        if (not isinstance(yaw_sweep, list) or not (2 <= len(yaw_sweep) <= 8)
                or not all(isinstance(a, (int, float)) and not isinstance(a, bool)
                           and math.isfinite(a) for a in yaw_sweep)):
            raise HTTPException(
                422, "yaw_sweep must be a list of 2-8 finite numbers (degrees)")

    data = await stl.read()
    if len(data) < 84:
        raise HTTPException(422, "uploaded file does not look like an STL")

    if yaw_sweep is None:
        return {"id": _submit_run(data, cfg)}

    group_id = uuid.uuid4().hex
    base_name = cfg["name"]
    ids = []
    for angle in yaw_sweep:
        child_cfg = dict(cfg)
        child_cfg["yaw_deg"] = float(angle)
        child_cfg["name"] = f"{base_name} @ {angle:g}\N{DEGREE SIGN}"
        ids.append(_submit_run(data, child_cfg, group_id=group_id))
    return {"id": ids[0], "group_id": group_id, "ids": ids}


def _submit_run(stl_bytes: bytes, cfg: dict, group_id: str | None = None) -> str:
    """Create the run directory + initial state and enqueue it."""
    run_id = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
    rd = DATA_DIR / run_id
    rd.mkdir(parents=True)
    (rd / "model.stl").write_bytes(stl_bytes)
    (rd / "config.json").write_text(json.dumps(cfg, indent=1))

    state = {
        "id": run_id,
        "name": cfg["name"],
        "status": "queued",
        "progress": 0.0,
        "message": "Queued",
        "created_at": time.time(),
        "config": cfg,
        "group_id": group_id,
        "model": None,
        "mesh_cells": None,
        "result": None,
        "error": None,
        "log": None,
    }
    runner.submit(state)
    return run_id


@app.get("/api/runs")
def list_runs():
    return [
        {"id": s["id"], "name": s["name"], "status": s["status"],
         "progress": s["progress"], "created_at": s["created_at"],
         "wind_speed": s["config"].get("wind_speed"),
         "quality": s["config"].get("quality"),
         "group_id": s.get("group_id"),
         "yaw_deg": s["config"].get("yaw_deg", 0)}
        for s in runner.list()
    ]


@app.get("/api/runs/{run_id}")
def get_run(run_id: str):
    s = _get_state(run_id)
    model = dict(s["model"]) if s["model"] else None
    if model and "bbox_m" in model:
        model["domain_bbox_m"] = foamcase.domain_bounds(model)
    return {
        "id": s["id"], "name": s["name"], "status": s["status"],
        "progress": s["progress"], "message": s["message"],
        "created_at": s["created_at"], "config": s["config"],
        "group_id": s.get("group_id"),
        "model": model, "mesh_cells": s["mesh_cells"],
        "result": _compat_result(s["result"]), "error": s["error"],
    }


@app.get("/api/runs/{run_id}/log")
def get_log(run_id: str, tail: int = 200):
    s = _get_state(run_id)
    log_name = s.get("log")
    if not log_name:
        return {"stage": s["status"], "lines": [], "total": 0}
    path = DATA_DIR / run_id / "case" / log_name
    try:
        lines = path.read_text(errors="replace").splitlines()
    except OSError:
        lines = []
    tail = max(1, min(tail, 5000))
    return {"stage": s["status"], "lines": lines[-tail:], "total": len(lines)}


@app.get("/api/runs/{run_id}/history")
def get_history(run_id: str):
    _get_state(run_id)
    return post.read_history(DATA_DIR / run_id / "case")


def _compat_result(result: dict | None) -> dict | None:
    """Backfill v2 result fields for runs solved before this feature."""
    if not result:
        return result
    out = dict(result)
    out.setdefault("drag_pressure_N", None)
    out.setdefault("drag_viscous_N", None)
    out.setdefault("stopped_early", False)
    return out


@app.get("/api/runs/{run_id}/result")
def get_result(run_id: str):
    s = _get_state(run_id)
    if s["status"] != "done" or not s["result"]:
        raise HTTPException(404, "result not available (run not done)")
    return _compat_result(s["result"])


@app.get("/api/groups/{group_id}")
def get_group(group_id: str):
    members = [s for s in runner.list() if s.get("group_id") == group_id]
    if not members:
        raise HTTPException(404, "group not found")
    members.sort(key=lambda s: float(s["config"].get("yaw_deg") or 0))
    first = members[0]
    runs = []
    for s in members:
        result = s["result"] if s["status"] == "done" else None
        runs.append({
            "id": s["id"],
            "yaw_deg": s["config"].get("yaw_deg", 0),
            "status": s["status"],
            "progress": s["progress"],
            "cd": result.get("cd") if result else None,
            "drag_N": result.get("drag_N") if result else None,
        })
    # Members are named "<base> @ N°"; the group carries the base name.
    name = first["name"].rsplit(" @ ", 1)[0]
    return {
        "group_id": group_id,
        "name": name,
        "wind_speed": first["config"].get("wind_speed"),
        "quality": first["config"].get("quality"),
        "runs": runs,
    }


@app.get("/api/runs/{run_id}/stl")
def get_stl(run_id: str):
    _get_state(run_id)
    path = DATA_DIR / run_id / "model.stl"
    if not path.exists():
        raise HTTPException(404, "stl not found")
    return FileResponse(path, media_type="model/stl", filename=f"{run_id}.stl")


def _serve_viz(run_id: str, fname: str) -> Response:
    s = _get_state(run_id)
    if s["status"] != "done":
        raise HTTPException(404, "visualization not available (run not done)")
    path = DATA_DIR / run_id / fname
    if not path.exists():
        raise HTTPException(404, "visualization data missing")
    return Response(content=path.read_bytes(), media_type="application/json")


@app.get("/api/runs/{run_id}/viz/surface")
def get_viz_surface(run_id: str):
    return _serve_viz(run_id, "viz_surface.json")


@app.get("/api/runs/{run_id}/viz/slice")
def get_viz_slice(run_id: str, axis: str = "y", pos: float | None = None):
    if axis not in ("x", "y", "z"):
        raise HTTPException(422, "axis must be 'x', 'y' or 'z'")
    # Fast path: the center y/z planes sampled during the run.
    if pos is None and axis in ("y", "z"):
        return _serve_viz(run_id, f"viz_slice_{axis}.json")

    s = _get_state(run_id)
    if s["status"] != "done":
        raise HTTPException(404, "visualization not available (run not done)")
    ax = {"x": 0, "y": 1, "z": 2}[axis]
    lo, hi = (foamcase.domain_bounds(s["model"])[i][ax] for i in (0, 1))
    eps = 0.01 * (hi - lo)
    pos = min(max(pos or 0.0, lo + eps), hi - eps)
    try:
        payload = ondemand.slice_json(DATA_DIR / run_id, axis, pos,
                                      float(s["config"].get("rho") or 1.225))
    except RuntimeError as e:
        raise HTTPException(422, str(e))
    payload["axis"] = axis
    payload["pos"] = pos
    return payload


@app.get("/api/runs/{run_id}/viz/streamlines")
def get_viz_streamlines(run_id: str):
    s = _get_state(run_id)
    if s["status"] != "done":
        raise HTTPException(404, "visualization not available (run not done)")
    try:
        return ondemand.streamlines_json(DATA_DIR / run_id, s["model"],
                                         float(s["config"].get("rho") or 1.225))
    except RuntimeError as e:
        raise HTTPException(422, str(e))


@app.delete("/api/runs/{run_id}")
def delete_run(run_id: str):
    _get_state(run_id)
    if runner.is_active(run_id):
        raise HTTPException(409, "run is currently executing")
    runner.delete(run_id)
    shutil.rmtree(DATA_DIR / run_id, ignore_errors=True)
    return JSONResponse({"deleted": run_id})
