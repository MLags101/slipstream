<p align="center"><img src="assets/icon-1024.png" width="128" alt="WindTunnel icon"></p>

# WindTunnel

[![Tests](https://github.com/OwenTWebb/windtunnel/actions/workflows/tests.yml/badge.svg)](https://github.com/OwenTWebb/windtunnel/actions/workflows/tests.yml)

**Drop in an STL. Get a wind tunnel analysis. Free, local, yours.**

WindTunnel is a desktop virtual wind tunnel for anyone with a shape and a question:
RC planes and multirotors, model cars, bike and motorcycle fairings, spoilers and
cowlings, pinewood derby racers, boat hulls, architectural models — anything you can
export as an STL. It wraps [OpenFOAM](https://www.openfoam.com)
(the industry-standard open-source CFD solver) in a one-window app: no dictionaries,
no meshing tutorials, no cloud fees.

![Streamlines around a 5-inch quad frame with spinning prop disks, 25 m/s](docs/images/streamlines.jpg)

- **Drag & drop an STL** → live 3D preview showing exactly how it will sit in the tunnel
- **Real CFD**: automatic meshing (snappyHexMesh) + steady RANS (simpleFoam, k-ω SST)
- **Results that matter**: drag & lift coefficients and forces, frontal area,
  pressure-vs-viscous drag breakdown, convergence quality
- **See the flow**: surface pressure maps, movable flow slices on all three axes
  (with sweep animation), velocity-colored streamlines
- **Go further**: yaw/pitch sweeps with angle charts, two-run comparison, and — for
  aircraft — propeller actuator disks for powered flow plus an auto-**trim solver**
  that finds the forward-flight attitude and per-motor thrust for weight and speed.
  Prop disks are placed on the motors automatically
- Runs **auto-stop when converged**, saving 30–40% of solve time, and the mesh is
  built on all cores
- **Re-solve on an existing mesh**: change wind speed or prop thrust and skip meshing
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

| Flow slice: prop downwash and wake | Setup: drop an STL, configure, run |
|---|---|
| ![Side flow slice showing prop downwash](docs/images/flow-slice.jpg) | ![Analysis setup with a sample quad frame](docs/images/setup.jpg) |

## Why

Commercial CFD tools are either too expensive or take far too long to learn.
Open-source solvers like OpenFOAM are just as accurate, but they give you text
dictionaries and a terminal, not the smooth workflow of enterprise software. As a
college student I have neither the budget for licenses nor the time to hand-build
meshes for every design change. WindTunnel keeps OpenFOAM's solver and handles all
the setup around it, so a full 3D velocity and pressure analysis starts with
dropping in an STL.

## Getting started (3 steps)

1. **Install OpenFOAM** (one-time):
   ```sh
   brew install --cask gerlero/openfoam/openfoam
   ```
2. **Install WindTunnel**: download `WindTunnel-<version>-macos-arm64.zip` from the
   latest [release](../../releases/latest) (Apple Silicon Macs), unzip it, move
   `WindTunnel.app` to `/Applications`, and read the first-launch note below.
   On an Intel Mac, [build from source](#building-from-source) instead.
3. **Run your first analysis**: open WindTunnel, drop an STL onto the target,
   check the unit (mm for 3D-print exports), set a wind speed, pick **coarse**
   quality, and hit **Run analysis**. A few minutes later you'll have a drag
   coefficient and a flow field to explore. Tip: coarse is great for comparing
   design variants; medium/fine for final numbers.

## "macOS says the app is from an unidentified developer"

WindTunnel is free and unsigned — an Apple Developer certificate costs $99/year,
which this project doesn't have (yet). The app is open source, and you can read or
build every line of it. To open it the first time:
**System Settings → Privacy & Security → "Open Anyway"**.

## How it works

Your STL is scaled, centered, and rotated to the requested attitude, then placed in
an automatically-sized virtual tunnel (blockage-checked). snappyHexMesh builds a
body-fitted hex mesh with boundary layers; simpleFoam solves steady incompressible
RANS on all cores; force coefficients, residuals, slices, and streamlines are
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
.venv/bin/pyinstaller --noconfirm --windowed --name WindTunnel \
  --icon ../assets/WindTunnel.icns \
  --add-data "../frontend/dist:ui" \
  --add-data "app/foam_template:app/foam_template" \
  --collect-submodules app \
  --hidden-import uvicorn.logging --hidden-import uvicorn.loops.auto \
  --hidden-import uvicorn.protocols.http.auto \
  --hidden-import uvicorn.protocols.websockets.auto \
  --hidden-import uvicorn.lifespan.on \
  desktop_app.py
open dist/WindTunnel.app
```

For development, run the backend (`uvicorn app.main:app --port 8000`) and frontend
(`npm run dev`) separately; see [docs/CONTRACT.md](docs/CONTRACT.md) for the full
architecture and API.

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
- Runs are CPU-hungry by design — a coarse run uses ~6 cores for a few minutes.
- Run data lives in `~/.windtunnel` (OpenFOAM can't handle spaces in paths, so not
  `~/Library/Application Support`).

## License

MIT for everything in this repository. OpenFOAM is a separate GPL-licensed program
invoked as an external process — it is not bundled; install it from
[openfoam.app](https://github.com/gerlero/openfoam-app) or openfoam.com.

This offering is not approved or endorsed by OpenCFD Limited, producer and
distributor of the OpenFOAM software via www.openfoam.com, and owner of the
OPENFOAM® and OpenCFD® trade marks.
