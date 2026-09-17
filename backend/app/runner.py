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
import math
import os
import queue
import re
import shutil
import subprocess
import threading
import time
import traceback
from pathlib import Path

from . import foamcase, geometry, meshimport, post
from .foamenv import OPENFOAM, find_openfoam

import signal

TERMINAL = ("done", "error", "cancelled")


class _Cancelled(Exception):
    """Raised inside the pipeline when the user cancels a run."""


class Runner:
    def __init__(self, data_dir: str | Path):
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.states: dict[str, dict] = {}
        self.queue: queue.Queue[str] = queue.Queue()
        self.current: str | None = None
        self._proc: subprocess.Popen | None = None  # currently running OF stage
        self._cancel: set[str] = set()              # run ids requested to cancel
        self._load_existing()
        # Nothing is solving at startup, so any leftover per-processor
        # decomposition is dead weight — reclaim it (harmless, ~45%/run).
        for rid in list(self.states):
            foamcase.free_processor_dirs(self.data_dir / rid / "case")
            self._clean_if_failed(rid)
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
                if run_id in self._cancel:      # cancelled before it started
                    self._cancel.discard(run_id)
                    self.update(run_id, status="cancelled", progress=0.0,
                                message="Cancelled")
                    continue
                self.current = run_id
            try:
                self._execute(run_id)
            except _Cancelled:
                try:
                    self.update(run_id, status="cancelled",
                                message="Cancelled by user", error=None)
                except KeyError:
                    pass
            except Exception as exc:  # noqa: BLE001
                traceback.print_exc()
                try:
                    self.update(run_id, status="error", error=str(exc),
                                message=f"Failed: {exc}")
                except KeyError:
                    pass
            finally:
                with self.lock:
                    self._cancel.discard(run_id)
                    self.current = None
                self._clean_if_failed(run_id)

    def _clean_if_failed(self, run_id: str) -> None:
        """A failed or cancelled run's mesh and fields are dead weight (often
        GBs); drop them but keep logs and convergence history. Re-run still
        works from the kept STL + config."""
        s = self.get(run_id)
        if not s or s["status"] not in ("error", "cancelled") or s.get("mesh_freed"):
            return
        freed = foamcase.clean_failed_case(self.run_dir(run_id) / "case")
        try:
            self.update(run_id, mesh_freed=True, freed_bytes=freed)
        except KeyError:  # deleted meanwhile
            pass

    def cancel(self, run_id: str) -> bool:
        """Request cancellation. Running: signals the pipeline to stop. Queued:
        marked cancelled at once (and skipped when dequeued). Returns False if
        already finished."""
        with self.lock:
            s = self.states.get(run_id)
            if s is None or s["status"] in TERMINAL:
                return False
            self._cancel.add(run_id)
            if run_id != self.current:  # queued, not yet running
                self.update(run_id, status="cancelled", progress=0.0,
                            message="Cancelled")
            return True

    def _foam(self, case: Path, cmd: str, log_name: str, run_id: str,
              progress_cb=None, check: bool = True) -> int:
        """Run one OpenFOAM stage; stdout+stderr -> case/<log_name>."""
        self.update(run_id, log=log_name)
        log_path = case / log_name
        shell = f"cd '{case}' && {cmd} > '{log_path}' 2>&1"
        # Resolve per stage, not at import: OpenFOAM installed while the app is
        # open must work without a restart (the health check already sees it).
        foam = find_openfoam() or OPENFOAM
        try:
            # New session -> its own process group, so cancel can kill the whole
            # mpirun/solver tree in one signal.
            proc = subprocess.Popen([foam, "-c", shell], start_new_session=True)
        except FileNotFoundError:
            raise RuntimeError(
                "OpenFOAM not found. Install it with `brew install --cask "
                "gerlero/openfoam/openfoam`, then re-run.") from None
        self._proc = proc
        try:
            while proc.poll() is None:
                time.sleep(1.0)
                if run_id in self._cancel:
                    self._kill_proc(proc)
                    raise _Cancelled()
                if progress_cb:
                    progress_cb()  # may raise (divergence) — kill happens there
        finally:
            self._proc = None
        if check and proc.returncode != 0:
            tail = self._log_tail(log_path, 30)
            raise RuntimeError(f"{cmd.split()[0]} failed (exit {proc.returncode}). "
                               f"Log tail:\n{tail}")
        return proc.returncode

    @staticmethod
    def _kill_proc(proc: subprocess.Popen) -> None:
        """Terminate a stage's whole process group."""
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            proc.terminate()
        try:
            proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                proc.kill()

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

    # A solution is physically impossible long before |Cd| reaches the 1e4
    # divergence trip. A broken surface can leave a near-sealed interior cavity
    # whose pressure solution drives a jet through one bad face — measured at
    # 900x freestream on a real assembly export — which corrupts the force
    # integrals while residuals still look healthy. Nothing in external
    # aerodynamics legitimately exceeds a few times freestream.
    MAX_SPEED_FACTOR = 10.0
    # The peak probe reports over a trailing PEAK_WINDOW, but the impulsive
    # start spikes far past the limit before it settles. Unpowered: 501 m/s at
    # iteration 2 of a healthy 15 m/s run, gone by ~25. Powered (prop disks)
    # takes much longer: a healthy 25 m/s run peaked at 1430 m/s at iteration
    # 23, stayed above the limit until ~50, and settled at 51 m/s (prop wash)
    # with Cd 0.859 +/- 0.003. The same frame's original CAD export was worse:
    # 8030 m/s at iteration ~45, above the limit until ~80, settling at 56 m/s
    # with Cd 0.899 +/- 0.012 — a trailing-25 window still holds 1220 m/s at
    # iteration 100. So judge no earlier than auto-stop may first fire
    # (AUTOSTOP_MIN_FRAC of the run): late enough for startup, and a run can
    # still never be reported converged with a live hotspot. A real cavity jet
    # never settles, so the only cost is solve time spent on a broken STL.
    MAX_SPEED_MIN_ITER = 100

    @classmethod
    def _speed_not_physical(cls, umax: float | None, u0: float, it: int,
                            iterations: int) -> bool:
        start = max(cls.MAX_SPEED_MIN_ITER, cls.AUTOSTOP_MIN_FRAC * iterations)
        return (umax is not None and it >= start
                and umax > cls.MAX_SPEED_FACTOR * u0)

    @classmethod
    def _converged(cls, cd: list[float], it: int, iterations: int) -> bool:
        if it < cls.AUTOSTOP_MIN_FRAC * iterations or len(cd) < cls.AUTOSTOP_WINDOW:
            return False
        return cls._cd_scatter(cd) is not None and cls._settled(cd)

    @classmethod
    def _cd_scatter(cls, cd: list[float]) -> tuple[float, float] | None:
        """(|mean|, std) of Cd over the trailing window, or None if too short."""
        if len(cd) < cls.AUTOSTOP_WINDOW:
            return None
        tail = cd[-cls.AUTOSTOP_WINDOW:]
        mean = sum(tail) / len(tail)
        std = (sum((x - mean) ** 2 for x in tail) / len(tail)) ** 0.5
        return abs(mean), std

    @classmethod
    def _settled(cls, cd: list[float]) -> bool:
        got = cls._cd_scatter(cd)
        if got is None:
            return False
        mean, std = got
        return std < max(cls.AUTOSTOP_ABS_TOL, cls.AUTOSTOP_REL_TOL * mean)

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

    # Printed once snappyHexMesh has actually started working on the case.
    SNAPPY_STARTED = "Reading refinement surfaces."

    def _mesh(self, case: Path, run_id: str) -> None:
        """surfaceFeatureExtract -> blockMesh -> snappyHexMesh into
        constant/polyMesh. snappyHexMesh runs on NPROCS ranks and the pieces are
        merged back (reconstructParMesh), so checkMesh, topoSet and the solve's
        own decomposePar see exactly the serial layout. A failed snappy is
        retried without prism layers; if MPI never got snappy started, the mesh
        is built on one core instead. WINDTUNNEL_SERIAL_MESH=1 forces serial."""
        self.update(run_id, status="meshing", progress=0.11,
                    message="Extracting surface features")
        self._foam(case, "surfaceFeatureExtract", "log.surfaceFeatureExtract", run_id)

        self.update(run_id, progress=0.14, message="Building background mesh (blockMesh)")
        self._foam(case, "blockMesh", "log.blockMesh", run_id)

        n = foamcase.NPROCS
        if n > 1 and not os.environ.get("WINDTUNNEL_SERIAL_MESH"):
            parallel = f"mpirun -np {n} snappyHexMesh -parallel -overwrite"
            self._foam(case, "decomposePar -force", "log.decomposePar.mesh", run_id)
            self.update(run_id, progress=0.17,
                        message=f"Snapping mesh to geometry on {n} cores (snappyHexMesh)")
            rc = self._foam(case, parallel, "log.snappyHexMesh", run_id, check=False)
            if rc != 0 and self.SNAPPY_STARTED in self._log_tail(
                    case / "log.snappyHexMesh", 10**6):
                # Retry without prism layers. snappy only wrote into
                # processor*/, so constant/polyMesh is still the block mesh.
                self.update(run_id, progress=0.2,
                            message="Layer addition failed - retrying castellated+snap only")
                foamcase.set_add_layers(case, False)
                self._foam(case, "decomposePar -force", "log.decomposePar.mesh", run_id)
                rc = self._foam(case, parallel, "log.snappyHexMesh", run_id)
            if rc == 0:
                self.update(run_id, progress=0.3, message="Merging mesh pieces")
                self._foam(case, "reconstructParMesh -constant",
                           "log.reconstructParMesh", run_id)
                foamcase.free_processor_dirs(case)
                return
            foamcase.free_processor_dirs(case)
            self.update(run_id, message="Parallel meshing did not start - "
                                        "meshing on one core")

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

    def _reuse_mesh(self, case: Path, source_id: str, run_id: str) -> None:
        """Re-solve: copy another run's finished mesh instead of meshing. The
        API only allows inputs that leave the mesh unchanged, so the freshly
        generated case (boundary names, ground, symmetry) matches it. Prop
        cellZones and sets are dropped; topoSet re-marks the disks."""
        src = self.run_dir(source_id) / "case" / "constant" / "polyMesh"
        source = self.get(source_id)
        label = source["name"] if source else source_id
        self.update(run_id, status="meshing", progress=0.2,
                    message=f"Reusing mesh from {label}")
        if not any(src.glob("owner*")):
            raise RuntimeError(
                f"the mesh from {label} is gone (run deleted or compacted) - "
                "use Re-run to mesh again")
        dst = case / "constant" / "polyMesh"
        shutil.rmtree(dst, ignore_errors=True)
        shutil.copytree(src, dst, ignore=shutil.ignore_patterns("sets", "cellZones*"))

    def _extract_import_surface(self, rd: Path, roles: dict, run_id: str) -> None:
        stage = rd / "mesh_import"
        meshimport.write_minimal_case(stage)
        names = " ".join(n for n, r in roles.items() if r == "model")
        self._foam(stage, f"surfaceMeshExtract -patches '({names})' '{rd / 'model.stl'}'",
                   "log.surfaceMeshExtract", run_id)
        if not (rd / "model.stl").exists():
            raise RuntimeError("couldn't extract the model patches from the imported mesh")

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

        # Imported mesh: the model is whatever patches were given the model
        # role, extracted once as the run's STL (viewer, frontal area, lRef).
        imported = config.get("mesh_import")
        if imported and not (rd / "model.stl").exists():
            self.update(run_id, message="Extracting the model surface from the imported mesh")
            self._extract_import_surface(rd, imported["roles"], run_id)

        model = geometry.prepare_stl(
            str(rd / "model.stl"), config["unit"], float(config.get("yaw_deg") or 0),
            str(rd / "model_prepared.stl"),
            pitch_deg=float(config.get("pitch_deg") or 0),
            roll_deg=float(config.get("roll_deg") or 0))

        # Half-model symmetry is only valid if the model really is mirror-
        # symmetric about its centerline (Y=0). If not, auto-cancel here
        # rather than silently solving half of an asymmetric body.
        if config.get("symmetry") and not model.get("symmetric"):
            self.update(run_id, model=model, status="cancelled", progress=0.0,
                        error=None, message=(
                            "Symmetry requested but the model isn't mirror-"
                            "symmetric about its centerline (Y=0) — re-run "
                            "without symmetry."))
            return

        props_cfg = config.get("props") or []
        props = geometry.transform_props(
            props_cfg, config["unit"], float(config.get("yaw_deg") or 0),
            float(config.get("pitch_deg") or 0), model,
            roll_deg=float(config.get("roll_deg") or 0)) if props_cfg else []

        params = foamcase.compute_params(model, config, props_m=props)
        iterations = params.pop("iterations")
        refinement_info = params.pop("refinement_info")

        self.update(run_id, model=model, progress=0.06,
                    refinement=refinement_info if config.get("refinement") else None,
                    message="Generating OpenFOAM case")
        foamcase.generate_case(case, params)
        if config.get("ground_plane"):
            # Rolling road unless the user asked for a fixed ground.
            foamcase.add_ground_plane(
                case, params, moving=config.get("ground") != "static")
        if config.get("symmetry"):
            foamcase.add_symmetry_plane(case)
        if imported:
            meshimport.add_role_fields(case, imported["roles"])
        tri_dir.mkdir(parents=True, exist_ok=True)
        (rd / "model_prepared.stl").replace(tri_dir / "model.stl")
        self.update(run_id, progress=0.1, message="Case generated")

        # ---- meshing (0.1 - 0.35) -----------------------------------------
        if config.get("mesh_from"):
            self._reuse_mesh(case, config["mesh_from"], run_id)
        elif imported:
            self.update(run_id, status="meshing", progress=0.2,
                        message="Installing the imported mesh")
            # Move the mesh into the model frame (model bbox centered on 0).
            meshimport.install_mesh(rd / "mesh_import" / "constant" / "polyMesh", case,
                                    imported["roles"], [-c for c in model["_c1"]])
        else:
            self._mesh(case, run_id)

        self.update(run_id, progress=0.32, message="Checking mesh quality")
        self._foam(case, "checkMesh", "log.checkMesh", run_id, check=False)
        mesh_cells = post.parse_cell_count(case / "log.checkMesh")
        if imported:
            check = meshimport.parse_checkmesh(
                (case / "log.checkMesh").read_text(errors="replace"))
            self.update(run_id, domain_bbox_m=check["bounds_m"])
        self.update(run_id, mesh_cells=mesh_cells, progress=0.35,
                    message=f"Mesh ready ({mesh_cells or '?'} cells)")

        # ---- propeller actuator disks (optional) ---------------------------
        if props:
            self.update(run_id, message=f"Marking {len(props_cfg)} propeller "
                                        "disk zones")
            foamcase.write_prop_disks(case, props,
                                      float(config.get("rho") or 1.225),
                                      params["base_cell"])
            self._foam(case, "topoSet -dict system/topoSetDict.props",
                       "log.topoSet", run_id)
            log = (case / "log.topoSet").read_text(errors="replace")
            import re as _re
            counts = [int(m.group(1)) for m in
                      _re.finditer(r"cellZoneSet disk\d+ now size (\d+)", log)]
            if not counts or min(counts) == 0:
                raise RuntimeError(
                    "a propeller disk selected 0 mesh cells - check its "
                    "position/diameter against the model (see log.topoSet)")

        # ---- solving (0.35 - 0.9) -----------------------------------------
        self.update(run_id, status="solving", progress=0.36,
                    message="Decomposing domain for parallel solve")
        self._foam(case, "decomposePar -force", "log.decomposePar", run_id)

        n = foamcase.NPROCS
        self.update(run_id, message=f"Running simpleFoam on {n} cores "
                                    f"(0/{iterations} iterations)")

        u0 = float(config["wind_speed"])
        stop = {"requested": False}

        def solve_progress():
            hist = post.read_history(case)
            if hist["iters"]:
                it = int(hist["iters"][-1])
                # Divergence guard: a blown-up or non-finite Cd means the solve
                # is producing garbage — stop now with a useful message.
                cd_last = hist["cd"][-1] if hist["cd"] else 0.0
                if not math.isfinite(cd_last) or abs(cd_last) > 1e4:
                    if self._proc is not None:
                        self._kill_proc(self._proc)
                    raise RuntimeError(
                        f"solution diverged at iteration {it} (Cd={cd_last:.3g}). "
                        "Try a finer mesh, a lower wind speed, or check the STL "
                        "for holes/self-intersections.")
                # Physically impossible peak speed: catches a leaking interior
                # cavity, which corrupts the forces while residuals look fine.
                umax = post.read_max_speed(case)
                if self._speed_not_physical(umax, u0, it, iterations):
                    if self._proc is not None:
                        self._kill_proc(self._proc)
                    raise RuntimeError(
                        f"solution is not physical at iteration {it}: peak speed "
                        f"{umax:.3g} m/s is {umax / u0:.0f}x the {u0:g} m/s "
                        "freestream. This is almost always a sealed or leaking "
                        "cavity inside the geometry — typical of an assembly "
                        "exported as overlapping shells. Repair the STL into a "
                        "single watertight solid (or delete interior parts) and "
                        "re-run.")
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

        # The per-processor decomposition is only needed during the parallel
        # solve; once fields are reconstructed it is pure dead weight (~45% of
        # the case). Drop it immediately.
        foamcase.free_processor_dirs(case)

        # ---- postprocessing (0.9 - 1.0) -----------------------------------
        self.update(run_id, progress=0.94, message="Building visualization data")
        rho = float(config.get("rho") or 1.225)
        u_inf = float(config["wind_speed"])
        symmetry = bool(config.get("symmetry"))
        surface = post.build_surface_viz(case, rho, u_inf, symmetry=symmetry)
        (rd / "viz_surface.json").write_text(json.dumps(surface))
        for axis in ("y", "z"):
            sl = post.build_slice_viz(case, axis, rho, symmetry=symmetry)
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
