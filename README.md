<p align="center"><img src="assets/icon-1024.png" width="128" alt="Slipstream icon"></p>

# Slipstream

[![Tests](https://github.com/OwenTWebb/slipstream/actions/workflows/tests.yml/badge.svg)](https://github.com/OwenTWebb/slipstream/actions/workflows/tests.yml)

**Drop in an STL. Get a wind tunnel analysis. Free, local, yours.**

Slipstream is a desktop virtual wind tunnel for anyone with a shape and a question:
RC planes and multirotors, model cars, bike and motorcycle fairings, spoilers and
cowlings, pinewood derby racers, boat hulls, architectural models — anything you can
export as an STL. It wraps [OpenFOAM](https://www.openfoam.com)
(the industry-standard open-source CFD solver) in a one-window app: no dictionaries,
no meshing tutorials, no cloud fees.

![Streamlines around a 5-inch quad frame with powered prop disks, 25 m/s](docs/images/streamlines.jpg)

- **Drag & drop an STL** → live 3D preview showing exactly how it will sit in the tunnel
- **Real CFD**: automatic meshing (snappyHexMesh) + steady RANS (simpleFoam, k-ω SST)
- **Compressible and supersonic**: pick a flow model and go past Mach 1 —
  rhoSimpleFoam for transonic, shock-capturing rhoCentralFoam for supersonic,
  with a shock-wave view. Shock angles validate within 3.5% of the
  exact analytical solution; see [docs/VALIDATION.md](docs/VALIDATION.md)
- **Results that matter**: drag & lift coefficients and forces, frontal area,
  pressure-vs-viscous drag breakdown, convergence quality
- **See the flow**: surface pressure maps, movable flow slices on all three axes
  (with sweep animation), velocity-colored streamlines
- **Go further**: yaw/pitch sweeps with angle charts, two-run comparison, and — for
  aircraft — propeller actuator disks for powered flow plus an auto-**trim solver**
  that finds the forward-flight attitude and per-motor thrust for weight and speed.
  Prop disks are placed on the motors automatically
- Runs **auto-stop when converged**, saving 30–40% of solve time, and the mesh is
  built in parallel
- **Re-solve on an existing mesh**: change wind speed or prop thrust and skip meshing
- **Bring your own mesh**: import a Gmsh, Fluent or OpenFOAM volume mesh, give each
  boundary a role, and solve on it ([docs/MESH_IMPORT.md](docs/MESH_IMPORT.md))
- **Mesh-independence sweep**: reruns coarse → medium → fine until drag stops
  changing, so you know the answer isn't an artifact of cell size
- **Optional refinement where it matters**: a longer refined wake, and refined
  cylinders along each prop's slipstream, tilted by the wind speed and thrust
- **One-click model repair**: broken CAD exports (holes, overlapping parts, loose
  sheets) are rebuilt as one closed solid and checked against the original
- **Half-model symmetry solves** for mirror-symmetric shapes, and a rolling-road
  ground plane for vehicles
- **Tidy run history**: rename runs, short run IDs, and failed runs free their
  mesh automatically (logs and convergence charts stay)

| Flow slice: prop downwash and wake | Shock waves: an F/A-18 at Mach 1.4 |
|---|---|
| ![Side flow slice showing prop downwash](docs/images/flow-slice.jpg) | ![Shock waves around an F/A-18 at Mach 1.4, shown as a density isosurface](docs/images/shock-f18.jpg) |

## Why

Commercial CFD tools are either too expensive or take far too long to learn.
Open-source solvers like OpenFOAM are just as accurate, but they give you text
dictionaries and a terminal, not the smooth workflow of enterprise software. As a
college student I have neither the budget for licenses nor the time to hand-build
meshes for every design change. Slipstream keeps OpenFOAM's solver and handles all
the setup around it, so a full 3D velocity and pressure analysis starts with
dropping in an STL.

## Getting started (3 steps)

1. **Install OpenFOAM** (one-time):
   ```sh
   brew install --cask gerlero/openfoam/openfoam
   ```
2. **Install Slipstream**: download `Slipstream-<version>-macos-arm64.zip` from the
   latest [release](../../releases/latest) (Apple Silicon Macs), unzip it, move
   `Slipstream.app` to `/Applications`, and read the first-launch note below.
   On an Intel Mac, [build from source](#building-from-source) instead.
3. **Run your first analysis**: open Slipstream, drop an STL onto the target,
   check the unit (mm for 3D-print exports), set a wind speed, pick **coarse**
   quality, and hit **Run analysis**. A few minutes later you'll have a drag
   coefficient and a flow field to explore. Tip: coarse is great for comparing
   design variants; medium/fine for final numbers.

## "macOS says the app is from an unidentified developer"

Slipstream is free and unsigned — an Apple Developer certificate costs $99/year,
which this project doesn't have (yet). The app is open source, and you can read or
build every line of it. To open it the first time:
**System Settings → Privacy & Security → "Open Anyway"**.

## How it works

Your STL is scaled, centered, and rotated to the requested attitude, then placed in
an automatically-sized virtual tunnel (blockage-checked). snappyHexMesh builds a
body-fitted hex mesh with boundary layers; simpleFoam solves steady incompressible
RANS in parallel (or rhoSimpleFoam / rhoCentralFoam when you pick a compressible
flow model); force coefficients, residuals, slices, and streamlines are
extracted and streamed to the UI live. Everything runs on **your** machine —
no uploads, no accounts, no queue behind strangers.

Propellers are modeled as actuator disks (momentum sources) — enough physics to
show real downwash, inflow, and airframe download without blade-resolved meshing.

## Building from source

```sh
# backend (Python 3.12+)
cd backend && python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
# optional (~170 MB): smaller repaired models via topology-preserving decimation
.venv/bin/pip install pymeshlab
# frontend (Node 20+)
cd ../frontend && npm install && npm run build
# desktop app
cd ../backend && .venv/bin/pip install pywebview pyinstaller
.venv/bin/pyinstaller --noconfirm --windowed --name Slipstream \
  --icon ../assets/Slipstream.icns \
  --add-data "../frontend/dist:ui" \
  --add-data "app/foam_template:app/foam_template" \
  --add-data "app/foam_template_compressible:app/foam_template_compressible" \
  --add-data "app/foam_template_supersonic:app/foam_template_supersonic" \
  --collect-submodules app \
  --hidden-import uvicorn.logging --hidden-import uvicorn.loops.auto \
  --hidden-import uvicorn.protocols.http.auto \
  --hidden-import uvicorn.protocols.websockets.auto \
  --hidden-import uvicorn.lifespan.on \
  desktop_app.py
open dist/Slipstream.app
```

For development, run the backend (`uvicorn app.main:app --port 8000`) and frontend
(`npm run dev`) separately; see [docs/CONTRACT.md](docs/CONTRACT.md) for the full
architecture and API.

## Run with Docker

With Docker Desktop installed, run the complete app (frontend, API, and OpenFOAM)
from the repository root:

```sh
docker compose up --build
```

Then open [http://localhost:8000](http://localhost:8000). The first start downloads
the OpenFOAM base image and installs the application dependencies, so it can take a
few minutes. Analyses are stored in the named `slipstream-data` Docker volume and
are retained across `docker compose down` / subsequent starts. To remove the app
and its saved analyses, use `docker compose down --volumes`.

Slipstream launches six OpenFOAM MPI ranks per analysis. In Docker Desktop, assign
at least six CPUs to Docker for normal performance. On a smaller machine, start it
with `SLIPSTREAM_SERIAL_MESH=1 docker compose up --build` to mesh serially (the
solver still benefits from the CPUs Docker makes available).

### Running the tests

```sh
cd backend && .venv/bin/pip install pytest httpx && .venv/bin/python -m pytest -q tests
cd ../frontend && npx tsc --noEmit && npm test
```

The backend tests don't need OpenFOAM. `backend/tests/e2e_smoke.py` runs a real
coarse analysis against a backend on `:8000` and does.

## Fair warnings

- CFD accuracy depends on mesh resolution: **coarse** answers "is A better than B",
  **fine** answers "what's the number". Trust trends more than the third decimal.
- How close it gets to real wind tunnel data, and where it doesn't, is measured in
  [docs/VALIDATION.md](docs/VALIDATION.md) (sphere, Ahmed body, and supersonic
  wedge and cone shock angles against the exact solutions).
- Supersonic runs are the newest and least forgiving: very sharp noses can diverge
  on medium/fine meshes. If one fails, try coarse, or a slightly rounded tip.
- Runs are CPU-hungry by design — every run uses 6 cores; a coarse one takes a few minutes.
- Run data lives in `~/.slipstream` (OpenFOAM can't handle spaces in paths, so not
  `~/Library/Application Support`).

## License

MIT for everything in this repository. OpenFOAM is a separate GPL-licensed program
invoked as an external process — it is not bundled; install it from
[openfoam.app](https://github.com/gerlero/openfoam-app) or openfoam.com.

This offering is not approved or endorsed by OpenCFD Limited, producer and
distributor of the OpenFOAM software via www.openfoam.com, and owner of the
OPENFOAM® and OpenCFD® trade marks.
