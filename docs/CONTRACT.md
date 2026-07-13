# WindTunnel — Architecture & API Contract

Free, local AirShaper-equivalent: drop an STL → virtual wind tunnel analysis via OpenFOAM.

## System overview

- `backend/` — Python 3.14 FastAPI app on **http://localhost:8000**. Owns STL processing,
  OpenFOAM case generation, job execution, post-processing. Run data in `backend/data/runs/<id>/`.
- `frontend/` — Vite + React + TypeScript on :5173, proxies `/api` → :8000.
- OpenFOAM v2606 (openfoam.app) is invoked via the `openfoam` wrapper:
  `openfoam -c "cd <case> && blockMesh"` etc. 8 cores available; use 6 for MPI solve.

## Conventions (both sides MUST follow)

- Flow direction: **+X**. Up: **+Z**. Yaw rotates the *model* about Z (backend does this at prep
  time so force axes stay X/Y/Z-aligned).
- All backend geometry/fields in SI (meters, m/s, Pa). STL upload declares its unit
  (`mm|cm|m|in`); backend scales to meters and centers the model at the origin.
- Pressure from solver is kinematic (m²/s²); backend multiplies by rho before serving (Pa),
  and also serves Cp = p / (0.5·rho·U²).
- Statuses: `queued | preparing | meshing | solving | postprocessing | done | error`.
- Quality presets: `coarse | medium | fine` (mesh refinement + iteration count; coarse ≈ 2-4 min,
  medium ≈ 8-15 min, fine ≈ 30+ min on this machine).

## REST API

### POST /api/runs  (multipart/form-data)
Fields: `stl` (file), `config` (JSON string):
```json
{"name": "quad frame v2", "unit": "mm", "wind_speed": 15.0,
 "yaw_deg": 0, "quality": "medium", "rho": 1.225, "nu": 1.5e-5}
```
`rho`/`nu` optional (defaults shown). → `201 {"id": "<run_id>"}`. Runs execute one at a time
(FIFO queue); the new run starts automatically when its turn comes.

### GET /api/runs
`[{"id","name","status","progress","created_at","wind_speed","quality"}]` newest first.

### GET /api/runs/{id}
```json
{"id","name","status","progress":0.0-1.0,"message":"human-readable current step",
 "config":{...as posted...},
 "model":{"bbox_m":[[xmin,ymin,zmin],[xmax,ymax,zmax]],"frontal_area_m2":0.0123,"triangles":15000},
 "mesh_cells": 850000,
 "result": null | {see /result},
 "error": null | "message"}
```

### GET /api/runs/{id}/log?tail=200
`{"stage":"solving","lines":["..."],"total":1234}` — tail of the current (or last) stage log.

### GET /api/runs/{id}/history
Convergence data, available (partial) while solving:
```json
{"iters":[...],"cd":[...],"cl":[...],
 "residuals":{"iters":[...],"p":[...],"Ux":[...],"k":[...],"omega":[...]}}
```

### GET /api/runs/{id}/result  (404 until done)
```json
{"cd":0.82,"cl":-0.05,"cs":0.01,"drag_N":1.24,"lift_N":-0.08,"side_N":0.01,
 "frontal_area_m2":0.0123,"wind_speed":15.0,"rho":1.225,
 "iterations":500,"mesh_cells":850000,"runtime_s":540,
 "cd_std_last20pct":0.004}
```
Coefficients averaged over the last 20% of iterations; `cd_std_last20pct` is the std-dev over
that window (convergence quality indicator).

### GET /api/runs/{id}/stl
The original (unscaled) uploaded STL, `model/stl` — for re-loading old runs in the viewer.

### GET /api/runs/{id}/viz/surface  (404 until done)
Model surface mesh with pressure, as flat arrays for three.js BufferGeometry:
```json
{"positions":[x0,y0,z0,x1,...], "indices":[i0,i1,i2,...],
 "fields":{"p":[...per-vertex Pa...],"cp":[...]},
 "ranges":{"p":[min,max],"cp":[min,max]}}
```
Positions in meters (model centered at origin).

### GET /api/runs/{id}/viz/slice?axis=y&pos=0.05  (404 until done)
Cutting plane, flat-array format, triangulated: `fields: {"u_mag":[m/s],"p":[Pa]}`, plus
`"ranges"`. `axis` ∈ x|y|z. Without `pos`, the center y/z planes sampled during the run are
served instantly; with `pos` (meters, clamped into the domain) the plane is generated
on demand by running `postProcess` on the saved fields (~2-3 s, then cached); the response
echoes `axis`/`pos`. Run detail's `model.domain_bbox_m` gives the valid position range.

### GET /api/runs/{id}/viz/streamlines  (404 until done)
Streamline tracks seeded on a 7×7 rake upstream of the model (on-demand, cached):
```json
{"positions":[...], "lines":[[i0,i1,...],...], "fields":{"u_mag":[...]},
 "ranges":{"u_mag":[min,max]}}
```

### DELETE /api/runs/{id}
Deletes run dir. 409 if currently executing.

## v2 additions (sweeps, drag breakdown, auto-stop)

### Yaw sweeps
`POST /api/runs` accepts optional `"yaw_sweep": [0, 15, 30, 45]` (2–8 angles, degrees;
`yaw_deg` is ignored when present). Creates one run per angle sharing a fresh `group_id`;
each child run is a normal run with its `yaw_deg` set and `" @ N°"` appended to the name.
Response becomes `{"id": <first run id>, "group_id": "...", "ids": [...]}` (plain runs keep
returning just `{"id"}` — no group fields). Runs execute sequentially via the existing FIFO.

- `GET /api/runs` items gain `"group_id": str|null` and `"yaw_deg": number`.
- Run detail gains `"group_id": str|null`.
- `GET /api/groups/{group_id}` →
  `{"group_id","name","wind_speed","quality","runs":[{"id","yaw_deg","status","progress",
  "cd","drag_N"}]}` sorted by yaw; `cd`/`drag_N` null until that member is done. 404 unknown.

### Drag breakdown
`/result` gains `"drag_pressure_N"` and `"drag_viscous_N"` (pressure vs viscous drag split
from a `forces` function object, averaged over the same last-20% window; `null` for runs
solved before this feature).

### Auto-stop on convergence
The solver halts early once std(Cd) over the trailing 60 iterations <
max(0.002, 0.5% · |mean Cd|), after at least 40% of the iteration budget (the case
controlDict is `runTimeModifiable`; the runner flips `stopAt` → `writeNow`).
`/result` gains `"stopped_early": bool`, and `iterations` reflects the actual count.

### Frontend v2
- **Run comparison**: pick any two runs (e.g. per-run "compare" affordance in the sidebar);
  side-by-side stat tiles (Cd, Cl, drag N, frontal area, cells, runtime) with explicit
  deltas, plus both Cd convergence histories overlaid on one chart.
- **Sweep results**: when a run belongs to a group, its detail view shows a sweep panel
  (poll `/api/groups/{gid}`): member status list and — as members finish — a Cd-vs-yaw and
  drag-vs-yaw chart with numeric table.
- **Slice sweep animation**: in slice mode, a play control pre-fetches ~12 plane positions
  spanning the model bbox (±20%) along the active axis (sequentially, with "sampling k/12"
  progress), then steps through them at ~2.5 fps with the position readout updating.
  Frames are colored against a common u_mag range for visual coherence; cached frames replay
  instantly. Explicit play/stop — no scrubbing-on-drag required.
- Results panel shows the pressure/viscous drag split when present, and an "stopped early
  (converged)" note when `stopped_early`.

## Backend pipeline (per run)

1. **preparing** — trimesh: load STL, scale to m, center, rotate −yaw about Z, save binary STL
   to case `constant/triSurface/model.stl`. Compute bbox + frontal area (rasterize projection
   onto YZ grid, 512², count covered cells — no shapely dependency). Generate case from
   template dir with placeholder substitution.
2. **meshing** — `surfaceFeatureExtract` → `blockMesh` → `snappyHexMesh -overwrite`
   (serial snappy is fine), `checkMesh` (log only). Parse cell count.
3. **solving** — `decomposePar` → `mpirun -np 6 --oversubscribe simpleFoam -parallel` →
   `reconstructPar -latestTime`. Live-parse `postProcessing/forceCoeffs1/0/coefficient.dat`
   and `postProcessing/solverInfo1/0/solverInfo.dat` for /history.
4. **postprocessing** — produce VTK for model surface (p) and center slices (U, p) via
   `foamToVTK -latestTime` (or `surfaces` function object written `onEnd`), read with meshio,
   convert to the flat-array JSON, cache as `viz_surface.json` / `viz_slice_y.json` /
   `viz_slice_z.json` in the run dir.

### CFD setup
- Steady incompressible RANS: `simpleFoam`, kOmegaSST, wall functions, potentialFoam-free
  (uniform init is fine).
- Domain from model bbox (L=x-extent, W=y, H=z): x ∈ [−4L, +9L], y ∈ ±max(3W, blockage-safe),
  z ∈ ±max(3H, ...), enforce frontal blockage < 5%.
- Boundaries: inlet fixedValue U=(Uinf,0,0); outlet fixedValue p=0 / zeroGradient U; lateral
  walls slip. Turbulence inlet: I=1%, mixing length ~0.1·H.
- snappyHexMesh: refinement box (model bbox expanded 1L back, 0.5L around) level 2; surface
  refinement level (4 5) coarse / (5 6) medium / (6 7) fine; base cell = domain_length/70;
  3 prism layers on model (expansion 1.2) — if layer addition fails, proceed without (log it).
- `locationInMesh`: near inlet corner of domain, offset inward, guaranteed outside model.
- Iterations: 250 / 500 / 800 by preset. forceCoeffs function object every iteration with
  magUInf, rhoInf, Aref = frontal area, lRef = L, CofR = model centroid,
  dragDir (1 0 0), liftDir (0 0 1). solverInfo function object for residuals.

## Frontend requirements

- Dark, modern engineering-tool aesthetic. Layout: left sidebar = run history + "New run";
  main area = viewer + config / live progress / results.
- New run: drag-and-drop STL → immediate three.js preview (STLLoader) with grid, axes, and an
  arrow showing wind direction (+X). Config: name, unit select, wind speed (m/s), yaw (deg),
  quality select. **Explicit "Run analysis" button — no live-updating; number inputs, not
  sliders** (hard user preference).
- Running: stage indicator (the 6 statuses), progress bar, live log tail (poll /log ~1.5s),
  live convergence chart of Cd/Cl vs iteration + residuals (log scale) from /history (~2s poll).
- Done: results panel (Cd, Cl, drag N, lift N, frontal area, cells, runtime, convergence
  quality); 3D viewer modes: geometry / surface pressure (Cp, diverging colormap) /
  slice (u_mag, viridis) with colorbar + numeric range; convergence chart stays.
- Colormaps implemented in TS (viridis + a blue-white-red diverging), vertex colors on
  BufferGeometry.
- Polling only, no websockets (keep it simple).

## v2.1 additions (pitch, streamline seeding)

- Config gains `pitch_deg` (default 0; positive = nose-down forward-flight tilt, rotation
  about Y applied before yaw) and `pitch_sweep` (mutually exclusive with `yaw_sweep`).
- `GET /api/groups/{gid}` gains `"param": "yaw"|"pitch"` and per-member `"angle"` (the swept
  value); `yaw_deg` kept for compatibility.
- `GET /viz/streamlines` gains `density=low|med|high` (5²/7²/10² seed grid) and
  `region=full|core` (rake span 1.15× / 0.6× model bbox); cached per combination.
- Frontend: pitch input + sweep-axis select on the form; density/region segmented controls
  in streamlines mode; sweep panel labels follow the swept parameter.

## v3 additions (propeller actuator disks)

- Config gains optional `"props"`: up to 8 `{center:[x,y,z], diameter, thrust_g}` entries
  (center/diameter in the STL's own units, thrust in grams; thrust axis is the model's +Z
  and rotates with pitch/yaw). Each disk becomes a cylinder cellZone (topoSet after
  meshing) carrying a semi-implicit momentum source of thrust/rho opposite the thrust
  axis (downwash into the flow). A disk that selects 0 cells fails the run with a clear
  error. Reported forces remain surface integrals over the model patch — thrust itself
  acts on the fluid, so lift_N shows the airframe download in the prop wash.
- Frontend: "Propeller disks — powered flow" checkbox on the form reveals a row editor
  (x/y/z/ø/thrust g per prop, add/remove, max 8).

## v3.1 additions (trim solver)

- `POST /api/runs` accepts optional `"trim": {"weight_g": 700, "max_iters": 5,
  "tol_deg": 0.75}` (`weight_g` required > 0 grams; others optional, defaults shown).
  Requires non-empty `props`; 422 when combined with a sweep. Response is
  `{"id": <first iteration run>, "group_id", "ids": [first]}` — further iterations
  join the group as they are submitted.
- Solver (backend `app/trim.py`, one controller thread per job): finds the
  forward-flight trim attitude. W = weight_g·9.81/1000; with L₀ = 0 and
  θ₁ = −atan2(0.12·W, W) (~−6.8°), iteration i flies pitch θᵢ with total thrust
  Tᵢ = max(W − Lᵢ₋₁, 0.1·W)/cos θᵢ split equally over the props, then
  θᵢ₊₁ = −atan2(Dᵢ, W − Lᵢ). Converged when |θᵢ₊₁ − θᵢ| ≤ tol_deg, else stop at
  max_iters. Trim pitch is negative (thrust leans upstream, −X). Members are normal
  runs named `"<base> @ trim N"` with `sweep_param: "pitch"` and the `trim` dict in
  their config; the final summary is written as `trim_summary.json` in the FIRST
  iteration's run dir. A controller lost to a server restart leaves the group
  without a summary (reported as still trimming).
- `GET /api/groups/{gid}` gains `"kind": "sweep"|"trim"`; trim groups (sorted by
  submission order, not angle) also carry `"trim"`: the summary
  `{"converged", "iterations", "trim_pitch_deg", "tilt_deg", "total_thrust_N",
  "thrust_g_per_prop", "drag_N", "lift_N", "weight_g", "wind_speed",
  "history": [{"pitch_deg","drag_N","lift_N","thrust_g_per_prop"}...], "error"}`
  once written, else partial progress `{"converged": null, "iterations": <members>}`.
- Frontend: "Solve trim attitude" checkbox + craft weight (g) input inside the
  propeller-disks section; pitch, sweep and per-prop thrust inputs are disabled
  ("solved by trim") while on. The sweep panel becomes "Trim solve" for trim groups
  with an amber readout strip (tilt / thrust per prop / drag, or
  "trimming… iteration k").
