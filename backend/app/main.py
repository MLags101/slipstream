"""WindTunnel backend - FastAPI app. Filesystem is the store; no DB, no auth."""
from __future__ import annotations

import json
import shutil
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response

from . import post
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

    run_id = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
    rd = DATA_DIR / run_id
    rd.mkdir(parents=True)
    data = await stl.read()
    if len(data) < 84:
        shutil.rmtree(rd)
        raise HTTPException(422, "uploaded file does not look like an STL")
    (rd / "model.stl").write_bytes(data)
    (rd / "config.json").write_text(json.dumps(cfg, indent=1))

    state = {
        "id": run_id,
        "name": cfg["name"],
        "status": "queued",
        "progress": 0.0,
        "message": "Queued",
        "created_at": time.time(),
        "config": cfg,
        "model": None,
        "mesh_cells": None,
        "result": None,
        "error": None,
        "log": None,
    }
    runner.submit(state)
    return {"id": run_id}


@app.get("/api/runs")
def list_runs():
    return [
        {"id": s["id"], "name": s["name"], "status": s["status"],
         "progress": s["progress"], "created_at": s["created_at"],
         "wind_speed": s["config"].get("wind_speed"),
         "quality": s["config"].get("quality")}
        for s in runner.list()
    ]


@app.get("/api/runs/{run_id}")
def get_run(run_id: str):
    s = _get_state(run_id)
    return {
        "id": s["id"], "name": s["name"], "status": s["status"],
        "progress": s["progress"], "message": s["message"],
        "created_at": s["created_at"], "config": s["config"],
        "model": s["model"], "mesh_cells": s["mesh_cells"],
        "result": s["result"], "error": s["error"],
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


@app.get("/api/runs/{run_id}/result")
def get_result(run_id: str):
    s = _get_state(run_id)
    if s["status"] != "done" or not s["result"]:
        raise HTTPException(404, "result not available (run not done)")
    return s["result"]


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
def get_viz_slice(run_id: str, axis: str = "y"):
    if axis not in ("y", "z"):
        raise HTTPException(422, "axis must be 'y' or 'z'")
    return _serve_viz(run_id, f"viz_slice_{axis}.json")


@app.delete("/api/runs/{run_id}")
def delete_run(run_id: str):
    _get_state(run_id)
    if runner.is_active(run_id):
        raise HTTPException(409, "run is currently executing")
    runner.delete(run_id)
    shutil.rmtree(DATA_DIR / run_id, ignore_errors=True)
    return JSONResponse({"deleted": run_id})
