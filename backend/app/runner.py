"""FIFO run queue: one run at a time, executed on a background thread.

Each run lives in data/runs/<id>/ with:
    model.stl    original upload (unscaled)
    config.json  posted config
    state.json   persisted run state (survives server restart)
    case/        the OpenFOAM case (logs: case/log.<stage>)
    viz_*.json   cached viz payloads
"""
from __future__ import annotations

import json
import os
import queue
import re
import subprocess
import threading
import time
import traceback
from pathlib import Path

from . import foamcase, geometry, post

OPENFOAM = "/opt/homebrew/bin/openfoam"
if not os.path.exists(OPENFOAM):
    OPENFOAM = "openfoam"  # fall back to PATH

TERMINAL = ("done", "error")


class Runner:
    def __init__(self, data_dir: str | Path):
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.states: dict[str, dict] = {}
        self.queue: queue.Queue[str] = queue.Queue()
        self.current: str | None = None
        self._load_existing()
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()

    # ------------------------------------------------------------------ state

    def run_dir(self, run_id: str) -> Path:
        return self.data_dir / run_id

    def _load_existing(self) -> None:
        for d in sorted(self.data_dir.iterdir()) if self.data_dir.exists() else []:
            sf = d / "state.json"
            if not d.is_dir() or not sf.exists():
                continue
            try:
                state = json.loads(sf.read_text())
            except (OSError, json.JSONDecodeError):
                continue
            status = state.get("status")
            if status == "queued":
                self.states[state["id"]] = state
                self.queue.put(state["id"])
            elif status not in TERMINAL:
                state["status"] = "error"
                state["error"] = "interrupted by server restart"
                state["message"] = "Interrupted by server restart"
                self.states[state["id"]] = state
                self._persist(state["id"])
            else:
                self.states[state["id"]] = state

    def _persist(self, run_id: str) -> None:
        with self.lock:
            state = self.states[run_id]
            path = self.run_dir(run_id) / "state.json"
            tmp = path.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(state, indent=1))
            tmp.replace(path)

    def update(self, run_id: str, **kw) -> None:
        with self.lock:
            self.states[run_id].update(kw)
            self._persist(run_id)

    def get(self, run_id: str) -> dict | None:
        with self.lock:
            return dict(self.states[run_id]) if run_id in self.states else None

    def list(self) -> list[dict]:
        with self.lock:
            return sorted((dict(s) for s in self.states.values()),
                          key=lambda s: s["created_at"], reverse=True)

    def submit(self, state: dict) -> None:
        with self.lock:
            self.states[state["id"]] = state
            self._persist(state["id"])
        self.queue.put(state["id"])

    def is_active(self, run_id: str) -> bool:
        with self.lock:
            return self.current == run_id

    def delete(self, run_id: str) -> bool:
        """Remove run from memory (caller deletes files). False if executing."""
        with self.lock:
            if self.current == run_id:
                return False
            self.states.pop(run_id, None)
            return True

    # ------------------------------------------------------------------ pipeline

    def _loop(self) -> None:
        while True:
            run_id = self.queue.get()
            with self.lock:
                if run_id not in self.states:  # deleted while queued
                    continue
                self.current = run_id
            try:
                self._execute(run_id)
            except Exception as exc:  # noqa: BLE001
                traceback.print_exc()
                try:
                    self.update(run_id, status="error", error=str(exc),
                                message=f"Failed: {exc}")
                except KeyError:
                    pass
            finally:
                with self.lock:
                    self.current = None

    def _foam(self, case: Path, cmd: str, log_name: str, run_id: str,
              progress_cb=None, check: bool = True) -> int:
        """Run one OpenFOAM stage; stdout+stderr -> case/<log_name>."""
        self.update(run_id, log=log_name)
        log_path = case / log_name
        shell = f"cd '{case}' && {cmd} > '{log_path}' 2>&1"
        proc = subprocess.Popen([OPENFOAM, "-c", shell])
        while proc.poll() is None:
            time.sleep(1.0)
            if progress_cb:
                progress_cb()
        if check and proc.returncode != 0:
            tail = self._log_tail(log_path, 30)
            raise RuntimeError(f"{cmd.split()[0]} failed (exit {proc.returncode}). "
                               f"Log tail:\n{tail}")
        return proc.returncode

    @staticmethod
    def _log_tail(path: Path, n: int) -> str:
        try:
            lines = path.read_text(errors="replace").splitlines()
            return "\n".join(lines[-n:])
        except OSError:
            return "(no log)"

    # --------------------------------------------------------- auto-stop

    # Convergence: std(Cd) over the trailing AUTOSTOP_WINDOW iterations below
    # max(AUTOSTOP_ABS_TOL, AUTOSTOP_REL_TOL * |mean Cd|), never before 40% of
    # the iteration budget nor with fewer than AUTOSTOP_WINDOW samples.
    AUTOSTOP_WINDOW = 60
    AUTOSTOP_ABS_TOL = 0.002
    AUTOSTOP_REL_TOL = 0.005
    AUTOSTOP_MIN_FRAC = 0.4

    @classmethod
    def _converged(cls, cd: list[float], it: int, iterations: int) -> bool:
        if it < cls.AUTOSTOP_MIN_FRAC * iterations or len(cd) < cls.AUTOSTOP_WINDOW:
            return False
        tail = cd[-cls.AUTOSTOP_WINDOW:]
        mean = sum(tail) / len(tail)
        std = (sum((x - mean) ** 2 for x in tail) / len(tail)) ** 0.5
        return std < max(cls.AUTOSTOP_ABS_TOL, cls.AUTOSTOP_REL_TOL * abs(mean))

    @staticmethod
    def _request_stop(case: Path) -> bool:
        """Flip stopAt -> writeNow in the (runTimeModifiable) case controlDict
        so the solver writes the current time and exits cleanly."""
        path = case / "system" / "controlDict"
        try:
            text = path.read_text()
        except OSError:
            return False
        new = re.sub(r"^(\s*stopAt\s+)\w+\s*;", r"\1writeNow;", text,
                     count=1, flags=re.MULTILINE)
        if new == text and "writeNow" not in text:
            return False
        path.write_text(new)
        return True

    def _execute(self, run_id: str) -> None:
        t0 = time.time()
        rd = self.run_dir(run_id)
        case = rd / "case"
        state = self.get(run_id)
        config = state["config"]

        # ---- preparing (0 - 0.1) ------------------------------------------
        self.update(run_id, status="preparing", progress=0.02,
                    message="Processing STL geometry", error=None,
                    stopped_early=False)
        tri_dir = case / "constant" / "triSurface"

        model = geometry.prepare_stl(
            str(rd / "model.stl"), config["unit"], float(config.get("yaw_deg") or 0),
            str(rd / "model_prepared.stl"),
            pitch_deg=float(config.get("pitch_deg") or 0))
        params = foamcase.compute_params(model, config)
        iterations = params.pop("iterations")

        self.update(run_id, model=model, progress=0.06,
                    message="Generating OpenFOAM case")
        foamcase.generate_case(case, params)
        tri_dir.mkdir(parents=True, exist_ok=True)
        (rd / "model_prepared.stl").replace(tri_dir / "model.stl")
        self.update(run_id, progress=0.1, message="Case generated")

        # ---- meshing (0.1 - 0.35) -----------------------------------------
        self.update(run_id, status="meshing", progress=0.11,
                    message="Extracting surface features")
        self._foam(case, "surfaceFeatureExtract", "log.surfaceFeatureExtract", run_id)

        self.update(run_id, progress=0.14, message="Building background mesh (blockMesh)")
        self._foam(case, "blockMesh", "log.blockMesh", run_id)

        self.update(run_id, progress=0.17,
                    message="Snapping mesh to geometry (snappyHexMesh)")
        rc = self._foam(case, "snappyHexMesh -overwrite", "log.snappyHexMesh",
                        run_id, check=False)
        if rc != 0:
            # Retry without prism layers.
            self.update(run_id, progress=0.2,
                        message="Layer addition failed - retrying castellated+snap only")
            foamcase.set_add_layers(case, False)
            self._foam(case, "snappyHexMesh -overwrite", "log.snappyHexMesh", run_id)

        self.update(run_id, progress=0.32, message="Checking mesh quality")
        self._foam(case, "checkMesh", "log.checkMesh", run_id, check=False)
        mesh_cells = post.parse_cell_count(case / "log.checkMesh")
        self.update(run_id, mesh_cells=mesh_cells, progress=0.35,
                    message=f"Mesh ready ({mesh_cells or '?'} cells)")

        # ---- solving (0.35 - 0.9) -----------------------------------------
        self.update(run_id, status="solving", progress=0.36,
                    message="Decomposing domain for parallel solve")
        self._foam(case, "decomposePar -force", "log.decomposePar", run_id)

        n = foamcase.NPROCS
        self.update(run_id, message=f"Running simpleFoam on {n} cores "
                                    f"(0/{iterations} iterations)")

        stop = {"requested": False}

        def solve_progress():
            hist = post.read_history(case)
            if hist["iters"]:
                it = int(hist["iters"][-1])
                frac = min(1.0, it / iterations)
                suffix = " - converged, stopping early" if stop["requested"] else ""
                self.update(run_id, progress=max(0.36, 0.35 + 0.55 * frac),
                            message=f"Running simpleFoam on {n} cores "
                                    f"({it}/{iterations} iterations){suffix}")
                if not stop["requested"] and self._converged(hist["cd"], it, iterations):
                    stop["requested"] = self._request_stop(case)
                    if stop["requested"]:
                        self.update(run_id, stopped_early=True)

        # NOTE: --oversubscribe makes Open MPI yield-when-idle, which was measured
        # to slow the solve ~50x on this machine. 6 ranks on 8 cores fit without it;
        # fall back to --oversubscribe only if the plain launch is refused.
        try:
            self._foam(case, f"mpirun -np {n} simpleFoam -parallel",
                       "log.simpleFoam", run_id, progress_cb=solve_progress)
        except RuntimeError:
            if post.read_history(case)["iters"]:
                raise  # solver genuinely diverged/failed mid-run
            self._foam(case, f"mpirun -np {n} --oversubscribe simpleFoam -parallel",
                       "log.simpleFoam", run_id, progress_cb=solve_progress)

        self.update(run_id, progress=0.9, status="postprocessing",
                    message="Reconstructing fields")
        self._foam(case, "reconstructPar -latestTime", "log.reconstructPar",
                   run_id, check=False)

        # ---- postprocessing (0.9 - 1.0) -----------------------------------
        self.update(run_id, progress=0.94, message="Building visualization data")
        rho = float(config.get("rho") or 1.225)
        u_inf = float(config["wind_speed"])
        surface = post.build_surface_viz(case, rho, u_inf)
        (rd / "viz_surface.json").write_text(json.dumps(surface))
        for axis in ("y", "z"):
            sl = post.build_slice_viz(case, axis, rho)
            (rd / f"viz_slice_{axis}.json").write_text(json.dumps(sl))

        self.update(run_id, progress=0.98, message="Computing final coefficients")
        result = post.compute_result(case, config, model, mesh_cells,
                                     runtime_s=time.time() - t0,
                                     stopped_early=stop["requested"])
        done_msg = f"Done - Cd = {result['cd']:.3f}"
        if result["stopped_early"]:
            done_msg += f" (converged early at {result['iterations']} iterations)"
        self.update(run_id, status="done", progress=1.0, result=result,
                    message=done_msg)
