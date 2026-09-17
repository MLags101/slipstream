# Slipstream backend

FastAPI backend that turns an uploaded STL into an OpenFOAM (simpleFoam, kOmegaSST)
external-aero analysis. See `docs/CONTRACT.md` at the repo root for the API contract.

## Requirements

- macOS with **OpenFOAM v2606** installed via [openfoam.app](https://github.com/gerlero/openfoam-app);
  the `openfoam` wrapper must be at `/opt/homebrew/bin/openfoam` (or on `PATH`).
- Python 3.12+ (developed on 3.14).

## Setup

```sh
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
# optional (~170 MB): smaller repaired models via topology-preserving decimation
.venv/bin/pip install pymeshlab
```

## Run

```sh
cd backend
.venv/bin/uvicorn app.main:app --port 8000
```

Launch from a shell where `/opt/homebrew/bin` is on `PATH` (the default on Homebrew
macOS) so the `openfoam` wrapper resolves; the backend calls it with an absolute
path when it exists, and falls back to `PATH` lookup otherwise.

## Data layout

All run data lives on the filesystem under `backend/data/runs/<run_id>/`:

- `model.stl` — the original upload (unscaled), served by `GET /api/runs/{id}/stl`
- `config.json` — the posted config
- `state.json` — persisted run state; the server restores history from these on restart
  (runs that were mid-execution during a restart are marked `error`, queued runs re-queue)
- `case/` — the generated OpenFOAM case, including per-stage logs
  (`log.blockMesh`, `log.snappyHexMesh`, `log.simpleFoam`, ...)
- `viz_surface.json`, `viz_slice_y.json`, `viz_slice_z.json` — cached viz payloads

Runs execute one at a time (FIFO). Delete a run with `DELETE /api/runs/{id}`
(409 while it is executing).

## Smoke test

```sh
# with the server running; generates a sphere fixture if missing
.venv/bin/python tests/e2e_smoke.py
```
