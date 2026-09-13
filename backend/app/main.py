"""WindTunnel backend - FastAPI app. Filesystem is the store; no DB, no auth."""
from __future__ import annotations

import json
import math
import os
import shutil
import threading
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response

from starlette.concurrency import run_in_threadpool

from . import foamcase, geometry, ondemand, post, repair, trim
from .runner import Runner

DATA_DIR = Path(
    os.environ.get("WINDTUNNEL_DATA_DIR")
    or Path(__file__).resolve().parent.parent / "data"
) / "runs"

app = FastAPI(title="WindTunnel backend")
runner = Runner(DATA_DIR)

VALID_UNITS = {"mm", "cm", "m", "in"}
VALID_QUALITY = {"coarse", "medium", "fine"}


def _num(v) -> bool:
    return (isinstance(v, (int, float)) and not isinstance(v, bool)
            and math.isfinite(v))


def _get_state(run_id: str) -> dict:
    state = runner.get(run_id)
    if state is None:
        raise HTTPException(404, "run not found")
    return state


@app.get("/api/health")
def health():
    from .foamenv import find_openfoam
    p = find_openfoam()
    return {"ok": True, "openfoam": p, "data_dir": str(DATA_DIR)}


def _compacted_msg(state: dict) -> str | None:
    if state.get("compacted"):
        return ("This run was compacted to save space — its mesh was freed, so "
                "new slice angles and streamlines can't be generated. "
                "Already-saved views still work.")
    return None


def _dir_size(path: Path) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += (Path(root) / f).stat().st_size
            except OSError:
                pass
    return total


@app.get("/api/storage")
def storage():
    """Disk usage of the run store and how much a prune would reclaim."""
    states = runner.list()
    # Group ids that still have an in-progress member are off-limits to prune.
    busy_groups = {
        s.get("group_id") for s in states
        if s["status"] not in ("done", "error") and s.get("group_id")
    }
    total = finished = reclaimable = compactable = 0
    for s in states:
        rd = DATA_DIR / s["id"]
        size = _dir_size(rd)
        total += size
        terminal = s["status"] in ("done", "error")
        freeable = (terminal and not runner.is_active(s["id"])
                    and s.get("group_id") not in busy_groups)
        if terminal:
            finished += 1
        if freeable:
            reclaimable += size
            if not s.get("compacted"):
                compactable += _dir_size(rd / "case")
    return {
        "total_bytes": total,
        "run_count": len(states),
        "finished_count": finished,
        "reclaimable_bytes": reclaimable,
        "compactable_bytes": compactable,
    }


@app.post("/api/runs/compact")
def compact_runs():
    """Drop the OpenFOAM case (mesh + fields) from every finished run, keeping
    results and already-generated visualizations. Frees the bulk of the space
    but disables new slice angles / streamlines for those runs."""
    states = runner.list()
    busy_groups = {
        s.get("group_id") for s in states
        if s["status"] not in ("done", "error") and s.get("group_id")
    }
    compacted, freed = [], 0
    for s in states:
        if s["status"] not in ("done", "error"):
            continue
        if (runner.is_active(s["id"]) or s.get("group_id") in busy_groups
                or s.get("compacted")):
            continue
        freed += foamcase.compact_case(DATA_DIR / s["id"])
        runner.update(s["id"], compacted=True)
        compacted.append(s["id"])
    return {"compacted": compacted, "freed_bytes": freed}


@app.post("/api/runs/prune")
def prune_runs():
    """Delete every finished run that isn't part of an in-progress group."""
    states = runner.list()
    busy_groups = {
        s.get("group_id") for s in states
        if s["status"] not in ("done", "error") and s.get("group_id")
    }
    deleted, freed = [], 0
    for s in states:
        if s["status"] not in ("done", "error"):
            continue
        if runner.is_active(s["id"]) or s.get("group_id") in busy_groups:
            continue
        rd = DATA_DIR / s["id"]
        freed += _dir_size(rd)
        runner.delete(s["id"])
        shutil.rmtree(rd, ignore_errors=True)
        deleted.append(s["id"])
    return {"deleted": deleted, "freed_bytes": freed}


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
    cfg.setdefault("pitch_deg", 0)
    cfg.setdefault("roll_deg", 0)
    cfg.setdefault("rho", 1.225)
    cfg.setdefault("nu", 1.5e-5)

    roll = cfg.get("roll_deg")
    if not (_num(roll) and -180 <= roll <= 180):
        raise HTTPException(422, "roll_deg must be a number in [-180, 180]")

    ref = cfg.get("ref_area_cm2")
    if ref is not None and not (_num(ref) and ref > 0):
        raise HTTPException(422, "ref_area_cm2 must be a positive number (cm^2)")

    if "ground_plane" in cfg and not isinstance(cfg["ground_plane"], bool):
        raise HTTPException(422, "ground_plane must be true or false")
    if cfg.get("ground") not in (None, "moving", "static"):
        raise HTTPException(422, "ground must be 'moving' or 'static'")

    if "symmetry" in cfg and not isinstance(cfg["symmetry"], bool):
        raise HTTPException(422, "symmetry must be true or false")

    props = cfg.get("props")
    if props is not None:
        if (not isinstance(props, list) or len(props) > 8 or not all(
                isinstance(p, dict)
                and isinstance(p.get("center"), list) and len(p["center"]) == 3
                and all(_num(v) for v in p["center"])
                and _num(p.get("diameter")) and p["diameter"] > 0
                and _num(p.get("thrust_g")) and p["thrust_g"] >= 0
                for p in props)):
            raise HTTPException(
                422, "props must be a list of up to 8 "
                     "{center:[x,y,z], diameter>0, thrust_g>=0} entries "
                     "(original STL units / grams)")
        if not props:
            cfg.pop("props")

    sweeps = {p: cfg.pop(f"{p}_sweep", None) for p in ("yaw", "pitch")}
    sweeps = {p: v for p, v in sweeps.items() if v is not None}
    if len(sweeps) > 1:
        raise HTTPException(422, "provide only one of yaw_sweep / pitch_sweep")
    for p, angles in sweeps.items():
        if (not isinstance(angles, list) or not (2 <= len(angles) <= 8)
                or not all(isinstance(a, (int, float)) and not isinstance(a, bool)
                           and math.isfinite(a) for a in angles)):
            raise HTTPException(
                422, f"{p}_sweep must be a list of 2-8 finite numbers (degrees)")

    trim_req = cfg.get("trim")
    if trim_req is not None:
        if not isinstance(trim_req, dict) or not _num(trim_req.get("weight_g")) \
                or trim_req["weight_g"] <= 0:
            raise HTTPException(
                422, "trim.weight_g must be a positive number (grams)")
        if not cfg.get("props"):
            raise HTTPException(
                422, "trim requires at least one propeller disk (props)")
        if sweeps:
            raise HTTPException(422, "trim cannot be combined with a sweep")
        mi = trim_req.get("max_iters", trim.DEFAULT_MAX_ITERS)
        td = trim_req.get("tol_deg", trim.DEFAULT_TOL_DEG)
        if not (isinstance(mi, int) and not isinstance(mi, bool) and 1 <= mi <= 10):
            raise HTTPException(422, "trim.max_iters must be an integer in [1, 10]")
        if not _num(td) or td <= 0:
            raise HTTPException(422, "trim.tol_deg must be a positive number")

    # Half-model symmetry only makes sense for a left-right-symmetric setup:
    # 0° yaw, 0° roll, no yaw sweep, no props, no trim. Pitch (about Y)
    # preserves the left-right symmetry, so pitch_deg / pitch_sweep are
    # allowed; roll (about X) tips the model out of the Y=0 mirror plane and
    # does not. The runtime also checks the geometry itself is mirror-symmetric
    # (auto-cancel).
    if cfg.get("symmetry"):
        if (float(cfg.get("yaw_deg") or 0) != 0
                or float(cfg.get("roll_deg") or 0) != 0 or "yaw" in sweeps
                or cfg.get("props") or trim_req is not None):
            raise HTTPException(
                422, "symmetry requires 0\N{DEGREE SIGN} yaw and roll and no "
                     "props/trim/yaw-sweep")

    data = await stl.read()
    if len(data) < 84:
        raise HTTPException(422, "uploaded file does not look like an STL")

    if trim_req is not None:
        cfg["trim"] = {"weight_g": float(trim_req["weight_g"]),
                       "max_iters": mi, "tol_deg": float(td)}
        return _submit_trim(data, cfg)

    if not sweeps:
        return {"id": _submit_run(data, cfg)}

    (param, angles), = sweeps.items()
    group_id = uuid.uuid4().hex
    base_name = cfg["name"]
    suffix = "" if param == "yaw" else " pitch"
    ids = []
    for angle in angles:
        child_cfg = dict(cfg)
        child_cfg[f"{param}_deg"] = float(angle)
        child_cfg["sweep_param"] = param
        child_cfg["name"] = f"{base_name} @ {angle:g}\N{DEGREE SIGN}{suffix}"
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


def _submit_trim(stl_bytes: bytes, cfg: dict) -> dict:
    """Submit the first trim iteration and start its controller thread."""
    trim_cfg = cfg["trim"]
    group_id = uuid.uuid4().hex
    theta1 = trim.initial_pitch_rad(trim_cfg["weight_g"])
    tg = trim.thrust_g_per_prop(trim_cfg["weight_g"], 0.0, theta1,
                                len(cfg["props"]))
    first_cfg = dict(cfg)
    first_cfg["pitch_deg"] = math.degrees(theta1)
    first_cfg["props"] = [dict(p, thrust_g=tg) for p in cfg["props"]]
    first_cfg["name"] = f"{cfg['name']} @ trim 1"
    first_cfg["sweep_param"] = "pitch"
    first_id = _submit_run(stl_bytes, first_cfg, group_id=group_id)

    controller = trim.TrimController(
        runner=runner,
        submit=lambda c: _submit_run(stl_bytes, c, group_id=group_id),
        base_cfg=cfg, trim_cfg=trim_cfg, group_id=group_id,
        first_run_id=first_id, first_pitch_rad=theta1,
        summary_dir=DATA_DIR / first_id)
    controller.start()
    return {"id": first_id, "group_id": group_id, "ids": [first_id]}


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
        model["domain_bbox_m"] = foamcase.domain_bounds(
            model, ground=bool(s["config"].get("ground_plane")),
            symmetry=bool(s["config"].get("symmetry")))
    # Prop disks in the prepared model frame (meters, same frame as the viz
    # payloads), so result views can draw them where the solver put them.
    cfg = s["config"]
    props_m = None
    if cfg.get("props") and s["model"] and "_c1" in s["model"]:
        props_m = geometry.transform_props(
            cfg["props"], cfg["unit"], float(cfg.get("yaw_deg") or 0),
            float(cfg.get("pitch_deg") or 0), s["model"],
            roll_deg=float(cfg.get("roll_deg") or 0))
    return {
        "id": s["id"], "name": s["name"], "status": s["status"],
        "progress": s["progress"], "message": s["message"],
        "created_at": s["created_at"], "config": s["config"],
        "group_id": s.get("group_id"),
        "model": model, "mesh_cells": s["mesh_cells"],
        "props_m": props_m,
        "result": _compat_result(s["result"]), "error": s["error"],
    }


# ---------------------------------------------------------------------------
# Model repair: inspect an STL, and rebuild a broken one as a closed solid
# ---------------------------------------------------------------------------

REPAIR_DIR = DATA_DIR.parent / "repairs"
# Repaired STLs go straight back to the browser; job folders older than this
# are pruned when a new repair starts so they don't pile up beside run data.
REPAIR_KEEP_S = 24 * 3600
_repair_jobs: dict[str, dict] = {}
_repair_lock = threading.Lock()


async def _read_stl_upload(stl: UploadFile) -> bytes:
    data = await stl.read()
    if len(data) < 84:
        raise HTTPException(422, "uploaded file does not look like an STL")
    return data


@app.post("/api/stl/inspect")
async def inspect_stl(stl: UploadFile):
    data = await _read_stl_upload(stl)
    REPAIR_DIR.mkdir(parents=True, exist_ok=True)
    tmp = REPAIR_DIR / f"inspect-{uuid.uuid4().hex}.stl"
    tmp.write_bytes(data)
    try:
        return await run_in_threadpool(repair.inspect, tmp)
    except Exception as e:  # noqa: BLE001 — any unreadable upload is a 422
        raise HTTPException(422, f"could not read STL: {e}")
    finally:
        tmp.unlink(missing_ok=True)


def _prune_repairs() -> None:
    if not REPAIR_DIR.exists():
        return
    cutoff = time.time() - REPAIR_KEEP_S
    running = {j["id"] for j in _repair_jobs.values() if j["status"] == "running"}
    for d in REPAIR_DIR.iterdir():
        if d.is_dir() and d.name not in running and d.stat().st_mtime < cutoff:
            shutil.rmtree(d, ignore_errors=True)
            _repair_jobs.pop(d.name, None)


def _run_repair(job: dict, job_dir: Path) -> None:
    def progress(frac: float, stage: str) -> None:
        job.update(progress=round(frac, 3), stage=stage)

    try:
        report = repair.repair_stl(job_dir / "input.stl", job_dir / "repaired.stl",
                                   progress=progress)
        job.update(status="done", progress=1.0, stage="done", report=report)
    except MemoryError:
        job.update(status="error", error="ran out of memory rebuilding the model")
    except Exception as e:  # noqa: BLE001 — report any failure to the UI
        job.update(status="error", error=str(e) or type(e).__name__)


@app.post("/api/repair", status_code=201)
async def start_repair(stl: UploadFile):
    data = await _read_stl_upload(stl)
    with _repair_lock:
        if any(j["status"] == "running" for j in _repair_jobs.values()):
            raise HTTPException(409, "a model repair is already running")
        _prune_repairs()
        job_id = uuid.uuid4().hex[:12]
        job_dir = REPAIR_DIR / job_id
        job_dir.mkdir(parents=True)
        (job_dir / "input.stl").write_bytes(data)
        job = {"id": job_id, "status": "running", "progress": 0.0,
               "stage": "queued", "report": None, "error": None}
        _repair_jobs[job_id] = job
    threading.Thread(target=_run_repair, args=(job, job_dir), daemon=True).start()
    return {"id": job_id}


def _get_repair_job(job_id: str) -> dict:
    job = _repair_jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "repair job not found")
    return job


@app.get("/api/repair/{job_id}")
def get_repair(job_id: str):
    return dict(_get_repair_job(job_id))


@app.get("/api/repair/{job_id}/stl")
def get_repair_stl(job_id: str):
    job = _get_repair_job(job_id)
    path = REPAIR_DIR / job_id / "repaired.stl"
    if job["status"] != "done" or not path.exists():
        raise HTTPException(409, "repair is not finished")
    return FileResponse(path, media_type="model/stl", filename="repaired.stl")


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
    param = members[0]["config"].get("sweep_param", "yaw")
    is_trim = any(s["config"].get("trim") for s in members)
    if is_trim:  # trim iterations in submission order, not angle order
        members.sort(key=lambda s: s["created_at"])
    else:
        members.sort(key=lambda s: float(s["config"].get(f"{param}_deg") or 0))
    first = members[0]
    runs = []
    for s in members:
        result = s["result"] if s["status"] == "done" else None
        angle = s["config"].get(f"{param}_deg", 0)
        runs.append({
            "id": s["id"],
            "yaw_deg": s["config"].get("yaw_deg", 0),
            "angle": angle,
            "status": s["status"],
            "progress": s["progress"],
            "cd": result.get("cd") if result else None,
            "drag_N": result.get("drag_N") if result else None,
        })
    # Members are named "<base> @ N°"; the group carries the base name.
    name = first["name"].rsplit(" @ ", 1)[0]
    out = {
        "group_id": group_id,
        "name": name,
        "param": param,
        "kind": "trim" if is_trim else "sweep",
        "wind_speed": first["config"].get("wind_speed"),
        "quality": first["config"].get("quality"),
        "runs": runs,
    }
    if is_trim:
        summary = None
        for s in members:
            p = DATA_DIR / s["id"] / "trim_summary.json"
            if p.exists():
                try:
                    summary = json.loads(p.read_text())
                except (OSError, json.JSONDecodeError):
                    summary = None
                break
        # No summary yet (still trimming, or controller lost to a restart):
        # report partial progress.
        out["trim"] = summary or {"converged": None, "iterations": len(members)}
    return out


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
    _db = foamcase.domain_bounds(
        s["model"], ground=bool(s["config"].get("ground_plane")),
        symmetry=bool(s["config"].get("symmetry")))
    lo, hi = _db[0][ax], _db[1][ax]
    eps = 0.01 * (hi - lo)
    pos = min(max(pos or 0.0, lo + eps), hi - eps)
    try:
        payload = ondemand.slice_json(DATA_DIR / run_id, axis, pos,
                                      float(s["config"].get("rho") or 1.225),
                                      symmetry=bool(s["config"].get("symmetry")))
    except RuntimeError as e:
        raise HTTPException(422, _compacted_msg(s) or str(e))
    payload["axis"] = axis
    payload["pos"] = pos
    return payload


@app.get("/api/runs/{run_id}/viz/streamlines")
def get_viz_streamlines(run_id: str, density: str = "med", region: str = "full"):
    if density not in ondemand.STREAM_DENSITY:
        raise HTTPException(422, "density must be low, med or high")
    if region not in ondemand.STREAM_REGION:
        raise HTTPException(422, "region must be full or core")
    s = _get_state(run_id)
    if s["status"] != "done":
        raise HTTPException(404, "visualization not available (run not done)")
    try:
        return ondemand.streamlines_json(DATA_DIR / run_id, s["model"],
                                         float(s["config"].get("rho") or 1.225),
                                         density=density, region=region,
                                         symmetry=bool(s["config"].get("symmetry")))
    except RuntimeError as e:
        raise HTTPException(422, _compacted_msg(s) or str(e))


@app.post("/api/runs/{run_id}/cancel")
def cancel_run(run_id: str):
    _get_state(run_id)
    if not runner.cancel(run_id):
        raise HTTPException(409, "run has already finished")
    return {"cancelled": run_id}


@app.post("/api/runs/{run_id}/rerun", status_code=201)
def rerun(run_id: str):
    """Re-submit a run's exact configuration as a new run. Works even on
    compacted runs (the original STL + config are always kept), so it's the
    recovery path when you need a fresh mesh to slice again."""
    _get_state(run_id)
    rd = DATA_DIR / run_id
    stl, cfg_path = rd / "model.stl", rd / "config.json"
    if not stl.exists() or not cfg_path.exists():
        raise HTTPException(410, "run inputs are no longer available")
    cfg = json.loads(cfg_path.read_text())
    # Strip group bookkeeping so it re-runs as a standalone run.
    for k in ("sweep_param", "trim"):
        cfg.pop(k, None)
    return {"id": _submit_run(stl.read_bytes(), cfg, group_id=None)}


@app.delete("/api/runs/{run_id}")
def delete_run(run_id: str):
    _get_state(run_id)
    if runner.is_active(run_id):
        raise HTTPException(409, "run is currently executing")
    runner.delete(run_id)
    shutil.rmtree(DATA_DIR / run_id, ignore_errors=True)
    return JSONResponse({"deleted": run_id})


# Desktop/app mode: serve the built frontend when WINDTUNNEL_STATIC is set.
_static = os.environ.get("WINDTUNNEL_STATIC")
if _static and Path(_static).is_dir():
    from fastapi.staticfiles import StaticFiles
    app.mount("/", StaticFiles(directory=_static, html=True), name="ui")
