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
