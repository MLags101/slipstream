# v1.2: compressible and supersonic flow

Slipstream solves incompressible steady RANS (`simpleFoam`). Above roughly Mach 0.3
(~100 m/s) that is wrong, and the results panel says so in a warning. This document
specifies adding compressible flow in two phases, ending with shock-resolving supersonic
runs.

It is written to be executed by someone (or something) that has not seen the conversation
it came from. Every step names real files and has an acceptance test.

---

## Guardrails — read before touching anything

These are not style preferences. Two of them have already caused damage in this project.

1. **Never import `app.main` without `SLIPSTREAM_DATA_DIR` set to a scratch path.**
   Importing it constructs the `Runner` against the real data folder and runs startup
   cleanup. This has already irreversibly deleted 2.80 GB of a user's runs. Always:

   ```
   SLIPSTREAM_DATA_DIR=/tmp/scratch backend/.venv/bin/python -m pytest tests -q
   ```

   The same applies to starting the backend by hand. `backend/tests/test_api.py` sets this
   itself and skips if `app.main` is already imported — do not defeat that guard.

2. **Another session may share this working tree.** Check `git status` before committing
   and stage only your own hunks (`git apply --cached --recount` with a filtered patch).
   Never `git add -A` or `git commit -a`.

3. **Do not start CFD runs without asking the owner first.** They are minutes to hours of
   the user's CPU. Mesh-only checks are cheaper than full solves; prefer them.

4. **Never delete files without asking**, every time, including scratch output that looks
   obviously disposable.

5. **American spelling** in all code, comments, docs and UI text.

6. Run tests with the venv interpreter as a module, or imports fail:
   `backend/.venv/bin/python -m pytest tests -q`.

---

## Where the incompressible assumption is baked in

Find these before changing them. This list is the real scope of Phase 1.

| Place | What it assumes |
| --- | --- |
| `backend/app/foam_template/0/p` | `p` is kinematic (m²/s²), outlet fixed at 0 |
| `backend/app/foam_template/constant/transportProperties` | Newtonian `nu` only, no thermo |
| `backend/app/foam_template/system/controlDict` | `forceCoeffs` with `rho rhoInf; rhoInf <rho>` |
| `backend/app/post.py:528` | `p_pa = p_kin * rho` — converts kinematic p to pascals |
| `backend/app/post.py` `build_surface_viz`, `plane_payload` | Cp from kinematic p and a constant rho |
| `backend/app/runner.py` `_execute` | hard-codes `simpleFoam`, `mpirun -np N simpleFoam -parallel` |
| `backend/app/foamcase.py` `compute_params` | emits `nu`, `rho` as constants; no `T` |
| `backend/app/foam_template/system/fvSchemes`, `fvSolution` | incompressible SIMPLE setup |

With a compressible solver, `p` in the case is **absolute pressure in pascals** and density
is a solved field. `p_pa = p_kin * rho` becomes wrong, and `rho` is no longer a constant the
config supplies.

---

## Config surface

Add one key to `RunConfig`, defaulting to today's behavior:

```
flow_model: "incompressible" | "transonic" | "supersonic"   // default "incompressible"
```

Validation in `backend/app/main.py` beside the existing `layers` block. Reject
`supersonic` combined with `props` (actuator disks are calibrated for incompressible
momentum sources) and with `trim`. When `flow_model` is not `incompressible`, require a
`temperature` (K, default 288.15).

Existing runs and reruns must be byte-identical when `flow_model` is absent. That is the
regression bar for the whole of Phase 1.

---

## Phase 1 — compressible foundation (`rhoSimpleFoam`)

Steady, pressure-based, valid subsonic through about Mach 1.2. Run times stay close to
today's. This phase exists to build the plumbing Phase 2 needs, and it retires the
">100 m/s is indicative" warning on its own.

### 1.1 Thermophysical properties

New template `backend/app/foam_template/constant/thermophysicalProperties`:

- `thermoType`: `hePsiThermo`, `pureMixture`, `perfectGas`, `sensibleEnthalpy`,
  `hConst` specie thermo, `sutherland` transport.
- Substitute `${molWeight}` (28.96 for air), `${Cp}` (1005), and Sutherland `As`/`Ts`.

`transportProperties` stays for the incompressible path. Pick per `flow_model` in
`foamcase.generate_case`.

### 1.2 New fields

Add `backend/app/foam_template/0/T` and `0/alphat`:

- `T`: `fixedValue ${T0}` at inlet, `zeroGradient` outlet and model, `zeroGradient` walls.
- `alphat`: `compressible::alphatWallFunction` on `model` and `ground`, `calculated`
  elsewhere, `value uniform 0`.
- `nut` wall functions stay; they are valid compressible too.

`0/p` for the compressible path becomes absolute: `fixedValue ${pAmb}` (101325) at the
outlet, `zeroGradient` at the inlet.

### 1.3 Pressure handling

This is the part that breaks silently if rushed.

- `post.py` must not multiply by `rho` when the case is compressible. Give
  `build_surface_viz` / `plane_payload` an explicit `compressible: bool` (or a
  `p_is_absolute` flag) and compute:
  - incompressible: `p_pa = p_kin * rho`, `cp = p_pa / (0.5 rho U²)`
  - compressible: `p_pa = p`, `cp = (p - pAmb) / (0.5 rho∞ U²)`
- `forceCoeffs` in `controlDict` drops `rho rhoInf; rhoInf ...` and uses `rho rho;` so the
  solver's own density field is used.
- `compute_result` keeps reporting `rho` as the freestream value used for normalization,
  not a solved field.

**Acceptance:** a compressible run's `cd` on a body at 15 m/s must agree with the
incompressible run's `cd` to within 2%. If it does not, the pressure conversion is wrong.
This is the single most valuable test in the phase — write it first.

### 1.4 Solver selection

In `runner.py` `_execute`, choose the binary from `flow_model`:

- `incompressible` → `simpleFoam` (unchanged)
- `transonic` → `rhoSimpleFoam`

Keep the existing parallel launch, the convergence guard, and the early-stop logic. The
divergence guard's Cd sanity check applies unchanged.

`fvSchemes` / `fvSolution` need compressible variants: solvers for `h`/`e` and `rho`,
`SIMPLE` with `transonic yes;` and sensible relaxation (p 0.3, U 0.7, h 0.7).

### 1.5 Mach number

Add a `MachNo` function object to `controlDict` for the compressible path, and surface
`mach_max` and freestream Mach in the result. Replace the existing ">100 m/s" warning in
`ResultsPanel.tsx` with one that fires only when an **incompressible** run exceeds Mach 0.3,
and add a new advisory when a transonic run exceeds Mach 1.2 (outside `rhoSimpleFoam`'s
comfortable range — use supersonic).

### 1.6 Tests

New `backend/tests/test_compressible.py`:

- absent `flow_model` produces byte-identical case files to today (guard the regression)
- `flow_model: "transonic"` writes `thermophysicalProperties`, `0/T`, `0/alphat`
- `0/p` is absolute for compressible and kinematic for incompressible
- config validation: bad `flow_model`, supersonic + props, supersonic + trim → 422
- `post.py` Cp math for both paths, on synthetic fields (no OpenFOAM needed)

Frontend: extend `src/lib/` with the Mach advisory text and unit-test it, matching how
`layers.ts` / `refinementText.ts` are done.

### 1.7 Validation

Re-run the existing sphere and Ahmed cases at `transonic` and confirm Cd matches the
incompressible results within a few percent at low speed. Add to `docs/VALIDATION.md`.

---

## Phase 2 — supersonic (`rhoCentralFoam`)

Density-based, transient, shock-capturing. This is what produces Mach cones and the
schlieren imagery. **It is a different solver class, not a setting.**

### 2.0 Already checked on this machine

Do not re-derive these; they are measured, not assumed.

- **`rhoCentralFoam` ships with the installed OpenFOAM** (v2606, `/opt/homebrew/bin/openfoam`),
  alongside `rhoSimpleFoam`, `rhoPimpleFoam` and `sonicFoam`.
- **Relevant tutorials exist** under `$FOAM_TUTORIALS/compressible/rhoCentralFoam`:
  `wedge15Ma5` (15 degree wedge at Mach 5), `obliqueShock`, `forwardStep`,
  `biconic25-55Run35` (a cone with published data), `shockTube`.
- **The wedge tutorial runs in 4.9 s** — 2000 time steps on 4800 cells. The cost warning
  below applies to 3D; 2D shock cases are cheap enough to iterate on freely.
- **The validation kit is written and checked**: `examples/validation/supersonic.py`.
  `wedge_shock_angle` reproduces published theta-beta-M values to 0.01 degrees,
  `cone_shock_angle` integrates Taylor-Maccoll and hits the textbook 33.9 degrees for a
  15 degree cone at Mach 2, and `measure_shock_angle` pulls the angle out of a solved
  density field. Against the wedge tutorial it measured **24.54 degrees versus the exact
  24.32** — 0.9% error. Start Phase 2 validation from this, not from scratch.

### 2.1 Expect a different cost model

`rhoCentralFoam` is Courant-limited and explicit in practice. Today's steady runs converge
in a few hundred iterations; a supersonic run needs tens of thousands of small time steps.
For 2D that is seconds (measured above). For a 3D body budget hours, not minutes, and say
so in the UI before the user starts one.

`controlDict` needs `adjustTimeStep yes; maxCo 0.2;` and an `endTime` in seconds derived
from flow-through time (domain length / freestream speed), typically 3–5 flow-throughs.

### 2.2 Boundary conditions

Supersonic flow carries no information upstream, which makes the inlet simple and the
outlet the hard part:

- inlet: `fixedValue` on `U`, `p` and `T` (fully specified)
- outlet: `zeroGradient` — **not** a fixed pressure; fixing it reflects shocks back in
- far-field walls: `slip` is acceptable; if shocks reach them, reflections will corrupt the
  solution, so the domain must be wide enough, or use `waveTransmissive`

`fvSchemes` needs the Kurganov flux scheme and a limited interpolation
(`vanLeer` / `limitedLinear`) on density and velocity. Unlimited schemes oscillate at shocks.

### 2.3 Meshing

Shocks are thin and their position is not known in advance. Options, cheapest first:

1. a uniformly finer refinement box around and behind the body
2. an explicit cone-shaped refinement region at the expected Mach angle
   (`μ = asin(1/M)`) — reuse the machinery in `foamcase.slipstream_regions`, which already
   builds aimed cylindrical refinement zones
3. solution-adaptive refinement (out of scope for v1.2)

### 2.4 Numerical schlieren

The payoff image. Add a `grad(rho)` magnitude field via a `mag(grad(rho))` function object,
and a grayscale colormap in the viewer. This is the classic shock photograph look and is
cheap once density is a solved field.

Add the colormap to `frontend/src/lib/colormaps.ts` and unit-test it alongside the existing
ones.

### 2.5 Validation — wedge first, then the cone

**Do the wedge before the cone.** A wedge's shock angle is algebraic (no ODE), the tutorial
already exists, it runs in seconds, and the whole measurement chain is proven against it
(0.9% error, above). It is the fastest possible proof that the solver is set up right.

Sequence:

1. Reproduce `wedge15Ma5` through Slipstream's own case generation and confirm the measured
   angle still lands within ~1% of `wedge_shock_angle(5, 15)`.
2. Then the cone, which is the one worth showing: `cone_shock_angle` gives the exact answer
   and `biconic25-55Run35` is a ready-made harder case with published data.

#### The cone at Mach 2

Use a sharp cone at zero incidence. The **Taylor–Maccoll** equations give an exact
analytical shock angle for a supersonic cone, so this is a closed-form check, not a
comparison against a digitized chart.

- Half-angle 15°, Mach 2.0, sea-level conditions.
- Theory: `cone_shock_angle(2.0, 15.0)` returns 33.91°, matching the textbook 33.9°.
- Measure with `measure_shock_angle` on a centerline slice.
- Report measured vs analytical in `docs/VALIDATION.md` with the schlieren image.

Add `examples/validation/make_models.py` support for generating the cone STL, and a case
entry in `run_validation.py` following the `single: True` pattern already there.

A caution learned the hard way on the prism layers: `supersonic.py`'s cone values for Mach
numbers other than 2 have not been checked against published tables, only against the
bracket (Mach angle < cone shock < wedge shock). Check one against a table before quoting
it anywhere public.

---

## Out of scope for v1.2

- Hypersonic (Mach > 5): real-gas and chemistry effects the perfect-gas model ignores.
- Transition modeling (γ-Reθ). Separate project; see `docs/VALIDATION.md` for why.
- Rotating propellers / MRF.
- Combining actuator disks with compressible flow.

---

## Suggested delegation

Phase 1 is mechanical and every step has a pass/fail test — it delegates well, provided the
guardrails above are respected and the Cp equivalence test in 1.3 is written first.

Phase 2 involves debugging a solver that can diverge for physical reasons (reflected shocks,
too coarse a mesh at the shock, too large a Courant number). That is open-ended iteration
against slow runs, and is better done by someone who can reason about the physics rather
than try schemes at random. Budget for that, or keep Phase 2 with a stronger model.
