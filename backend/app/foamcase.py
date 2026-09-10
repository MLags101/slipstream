"""Generate an OpenFOAM case directory from the bundled template."""
from __future__ import annotations

import math
import re
import shutil
from pathlib import Path
from string import Template

TEMPLATE_DIR = Path(__file__).parent / "foam_template"

QUALITY = {
    "coarse": {"surf_min": 4, "surf_max": 5, "iterations": 250, "max_global_cells": 2_000_000},
    "medium": {"surf_min": 5, "surf_max": 6, "iterations": 500, "max_global_cells": 4_000_000},
    "fine":   {"surf_min": 6, "surf_max": 7, "iterations": 800, "max_global_cells": 8_000_000},
}

NPROCS = 6


def domain_bounds(model: dict, ground: bool = False,
                  symmetry: bool = False) -> list[list[float]]:
    """Wind tunnel domain bbox: x in [xmin-4L, xmax+9L], y/z half-extent
    3W / 3H, widened until frontal blockage < 5%. With `ground`, the floor is
    placed just below the model (a road) instead of far below. With
    `symmetry`, only the +Y half is kept (y in [0, +hy]) so a mirror-symmetric
    model can be solved on half the cells."""
    (bx0, by0, bz0), (bx1, by1, bz1) = model["bbox_m"]
    L, W, H = bx1 - bx0, by1 - by0, bz1 - bz0
    dx0, dx1 = bx0 - 4.0 * L, bx1 + 9.0 * L
    hy, hz = 3.0 * W, 3.0 * H
    floor = (bz0 - 0.12 * H) if ground else -hz
    area = model["frontal_area_m2"]
    # Blockage uses the full width 2*hy vs the full frontal area; halving both
    # the domain width and the modelled area (symmetry) leaves the ratio the
    # same, so this check stays valid for the half domain too.
    while area / ((2 * hy) * (hz - floor)) > 0.05:
        hy *= 1.25
        hz *= 1.25
    dy0 = 0.0 if symmetry else -hy
    return [[dx0, dy0, floor], [dx1, hy, hz]]


def compute_params(model: dict, config: dict) -> dict:
    """Derive all template placeholder values from model metadata + run config."""
    bbox = model["bbox_m"]
    (bx0, by0, bz0), (bx1, by1, bz1) = bbox
    L = bx1 - bx0
    W = by1 - by0
    H = bz1 - bz0
    if min(L, W, H) <= 0:
        raise ValueError("degenerate model bounding box")

    U0 = float(config["wind_speed"])
    rho = float(config.get("rho") or 1.225)
    nu = float(config.get("nu") or 1.5e-5)
    q = QUALITY[config["quality"]]

    ground = bool(config.get("ground_plane"))
    symmetry = bool(config.get("symmetry"))
    (dx0, dy0, dz0), (dx1, dy1, dz1) = domain_bounds(
        model, ground=ground, symmetry=symmetry)

    domain_len = dx1 - dx0
    cell = domain_len / 70.0
    if ground:
        # Keep at least ~1.5 base cells between the model and the road so the
        # gap is meshable at coarse resolution.
        dz0 = min(dz0, bz0 - 1.5 * cell)
    nx = max(10, int(math.ceil(domain_len / cell)))
    ny = max(6, int(math.ceil((dy1 - dy0) / cell)))
    nz = max(6, int(math.ceil((dz1 - dz0) / cell)))

    # Refinement box: 0.5L around the model, 1L extra downstream (wake).
    rbx0, rbx1 = bx0 - 0.5 * L, bx1 + 1.5 * L
    rby0, rby1 = by0 - 0.5 * L, by1 + 0.5 * L
    rbz0, rbz1 = bz0 - 0.5 * L, bz1 + 0.5 * L

    # Point near inlet corner, guaranteed outside the model & refinement box.
    # With symmetry, dy0 == 0, so liy = 0.677*cell is a positive point just
    # inside the +Y half domain (far upstream, open fluid — not on the model).
    lix = dx0 + 0.731 * cell
    liy = dy0 + 0.677 * cell
    liz = dz0 + 0.613 * cell

    # Turbulence inlet: I = 1%, mixing length ~ 0.1 * H.
    I = 0.01
    k0 = max(1.5 * (I * U0) ** 2, 1e-8)
    lmix = 0.1 * H
    cmu = 0.09
    omega0 = math.sqrt(k0) / (cmu ** 0.25 * lmix)

    cx, cy, cz = model.get("centroid", [0.0, 0.0, 0.0])

    # Reference area for force coefficients: frontal area by default, or a
    # user override (cm^2 -> m^2) e.g. planform area for a wing's lift.
    ref_cm2 = config.get("ref_area_cm2")
    ref_area = float(ref_cm2) / 1e4 if ref_cm2 else model["frontal_area_m2"]

    return {
        "U0": fmt(U0), "rho": fmt(rho), "nu": fmt(nu),
        "k0": fmt(k0), "omega0": fmt(omega0),
        "endTime": str(q["iterations"]),
        "aref": fmt(ref_area), "lref": fmt(L),
        "cx": fmt(cx), "cy": fmt(cy), "cz": fmt(cz),
        "dx0": fmt(dx0), "dx1": fmt(dx1),
        "dy0": fmt(dy0), "dy1": fmt(dy1),
        "dz0": fmt(dz0), "dz1": fmt(dz1),
        "nx": str(nx), "ny": str(ny), "nz": str(nz),
        "rbx0": fmt(rbx0), "rbx1": fmt(rbx1),
        "rby0": fmt(rby0), "rby1": fmt(rby1),
        "rbz0": fmt(rbz0), "rbz1": fmt(rbz1),
        "lix": fmt(lix), "liy": fmt(liy), "liz": fmt(liz),
        # Center flow-slice sample plane: y=0 normally; with symmetry the
        # domain starts AT y=0, so sample just inside the half domain.
        "sliceY": fmt(0.55 * cell if symmetry else 0.0),
        "surfMin": str(q["surf_min"]), "surfMax": str(q["surf_max"]),
        "featLevel": str(q["surf_min"]),
        "maxGlobalCells": str(q["max_global_cells"]),
        "nprocs": str(NPROCS),
        "doLayers": "true",
        # convenience for the runner (non-string: not template keys)
        "iterations": q["iterations"],
        "base_cell": cell,
    }


def fmt(x: float) -> str:
    return f"{x:.8g}"


def generate_case(case_dir: str | Path, params: dict) -> None:
    """Copy the template into case_dir, substituting ${...} placeholders."""
    case_dir = Path(case_dir)
    if case_dir.exists():
        shutil.rmtree(case_dir)
    subst = {k: v for k, v in params.items() if isinstance(v, str)}
    for src in sorted(TEMPLATE_DIR.rglob("*")):
        rel = src.relative_to(TEMPLATE_DIR)
        dst = case_dir / rel
        if src.is_dir():
            dst.mkdir(parents=True, exist_ok=True)
        else:
            dst.parent.mkdir(parents=True, exist_ok=True)
            text = src.read_text()
            dst.write_text(Template(text).substitute(subst))


def set_add_layers(case_dir: str | Path, enabled: bool) -> None:
    """Toggle addLayers in an already-generated snappyHexMeshDict."""
    p = Path(case_dir) / "system" / "snappyHexMeshDict"
    text = p.read_text()
    old = "addLayers       true;" if not enabled else "addLayers       false;"
    new = "addLayers       false;" if not enabled else "addLayers       true;"
    p.write_text(text.replace(old, new))


# ---------------------------------------------------------------------------
# Propeller actuator disks: cylinder cellZones + momentum sources (fvOptions)
# ---------------------------------------------------------------------------

_FOAM_HEADER = """FoamFile
{{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      {obj};
}}
"""


def write_prop_disks(case_dir: str | Path, props: list[dict], rho: float,
                     base_cell: float) -> None:
    """Write system/topoSetDict.props (cylinder cellZone per disk) and
    constant/fvOptions (semi-implicit momentum source per disk). Props are in
    the prepared model frame (see geometry.transform_props); thrust pushes
    the craft along +axis, so the momentum added to the AIR is along -axis."""
    case_dir = Path(case_dir)
    actions = []
    options = []
    for i, p in enumerate(props, start=1):
        cx, cy, cz = p["center_m"]
        ax, ay, az = p["axis"]
        r = p["diameter_m"] / 2.0
        # Disk thickness: thick enough to contain refined cells near the model.
        t = max(0.15 * p["diameter_m"], 1.5 * base_cell / 4.0)
        p1 = (cx - ax * t / 2, cy - ay * t / 2, cz - az * t / 2)
        p2 = (cx + ax * t / 2, cy + ay * t / 2, cz + az * t / 2)
        actions.append(f"""
    {{
        name    disk{i}Cells;
        type    cellSet;
        action  new;
        source  cylinderToCell;
        p1      ({p1[0]:.6g} {p1[1]:.6g} {p1[2]:.6g});
        p2      ({p2[0]:.6g} {p2[1]:.6g} {p2[2]:.6g});
        radius  {r:.6g};
    }}
    {{
        name    disk{i};
        type    cellZoneSet;
        action  new;
        source  setToCellZone;
        set     disk{i}Cells;
    }}""")
        # simpleFoam is incompressible: source is thrust / rho (m^4/s^2),
        # applied to the air opposite the craft's thrust axis.
        s = p["thrust_N"] / rho
        sx, sy, sz = -ax * s, -ay * s, -az * s
        options.append(f"""
disk{i}
{{
    type            vectorSemiImplicitSource;
    selectionMode   cellZone;
    cellZone        disk{i};
    volumeMode      absolute;
    injectionRateSuSp
    {{
        U           (({sx:.6g} {sy:.6g} {sz:.6g}) 0);
    }}
}}""")

    (case_dir / "system" / "topoSetDict.props").write_text(
        _FOAM_HEADER.format(obj="topoSetDict") +
        "\nactions\n(" + "".join(actions) + "\n);\n")
    (case_dir / "constant" / "fvOptions").write_text(
        _FOAM_HEADER.format(obj="fvOptions") + "".join(options) + "\n")


# ---------------------------------------------------------------------------
# Storage reclamation
# ---------------------------------------------------------------------------

def free_processor_dirs(case_dir: str | Path) -> int:
    """Delete the per-processor decomposition (processorN/) left by the
    parallel solve. Safe once reconstructPar has run. Returns bytes freed."""
    case_dir = Path(case_dir)
    freed = 0
    for p in case_dir.glob("processor*"):
        if p.is_dir():
            freed += _dir_bytes(p)
            shutil.rmtree(p, ignore_errors=True)
    return freed


def compact_case(run_dir: str | Path) -> int:
    """Aggressively reclaim a finished run: delete the whole OpenFOAM case/
    (mesh + solved fields) but keep the cached viz JSON, config, state and the
    STL. Results and already-generated visualizations survive; new on-demand
    slice angles / streamlines can no longer be generated. Returns bytes freed."""
    run_dir = Path(run_dir)
    case = run_dir / "case"
    if not case.exists():
        return 0
    freed = _dir_bytes(case)
    shutil.rmtree(case, ignore_errors=True)
    return freed


def _dir_bytes(path: Path) -> int:
    import os
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += (Path(root) / f).stat().st_size
            except OSError:
                pass
    return total


# ---------------------------------------------------------------------------
# Boundary-patch surgery: carve a face out of the blockMesh `walls` patch
# ---------------------------------------------------------------------------

_WALLS_RE = re.compile(
    r"    walls\n    \{\n        type patch;\n        faces\n        \(\n"
    r"(?P<faces>.*?)\n        \);\n    \}",
    re.DOTALL)


def _split_wall_face(text: str, face: str, patch_name: str,
                     patch_type: str) -> str:
    """Move a single `face` out of the blockMeshDict `walls` patch into a new
    `patch_name` patch of `patch_type`, inserted just before `walls`. Parses
    the current walls faces rather than assuming the original 4-face form, so
    ground + symmetry compose regardless of order (each removes its own face
    from whatever walls block currently exists)."""
    m = _WALLS_RE.search(text)
    if m is None:
        raise RuntimeError("blockMeshDict walls patch not in expected form")
    faces = [ln.strip() for ln in m.group("faces").splitlines() if ln.strip()]
    if face not in faces:
        raise RuntimeError(f"blockMeshDict walls patch missing face {face}")
    remaining = [f for f in faces if f != face]
    new_patch = (
        f"    {patch_name}\n    {{\n        type {patch_type};\n"
        f"        faces\n        (\n            {face}\n        );\n    }}\n")
    walls_block = (
        "    walls\n    {\n        type patch;\n        faces\n        (\n"
        + "".join(f"            {f}\n" for f in remaining)
        + "        );\n    }")
    return text[:m.start()] + new_patch + walls_block + text[m.end():]


# ---------------------------------------------------------------------------
# Ground plane (rolling road) for vehicles
# ---------------------------------------------------------------------------

_GROUND_BC = {
    "U": lambda p, moving: (
        f"    ground\n    {{\n        type            fixedValue;\n"
        f"        value           uniform ({p['U0']} 0 0);\n    }}\n"
        if moving else
        "    ground\n    {\n        type            noSlip;\n    }\n"),
    "p": lambda p, moving: "    ground\n    {\n        type            zeroGradient;\n    }\n",
    "k": lambda p, moving: (
        f"    ground\n    {{\n        type            kqRWallFunction;\n"
        f"        value           uniform {p['k0']};\n    }}\n"),
    "omega": lambda p, moving: (
        f"    ground\n    {{\n        type            omegaWallFunction;\n"
        f"        value           uniform {p['omega0']};\n    }}\n"),
    "nut": lambda p, moving: (
        "    ground\n    {\n        type            nutkWallFunction;\n"
        "        value           uniform 0;\n    }\n"),
}


def add_ground_plane(case_dir: str | Path, params: dict, moving: bool = True) -> None:
    """Turn the domain's bottom face into a `ground` wall patch and add its
    boundary conditions to the 0/ fields. moving=True => rolling road (wall
    velocity = freestream), which avoids a spurious ground boundary layer."""
    case = Path(case_dir)

    # 1. blockMeshDict: split the bottom face (0 3 2 1) out of `walls`.
    bm = case / "system" / "blockMeshDict"
    bm.write_text(_split_wall_face(bm.read_text(), "(0 3 2 1)", "ground", "wall"))

    # 2. 0/ fields: insert a `ground` entry just before the `model` patch.
    for field, bc in _GROUND_BC.items():
        f = case / "0" / field
        t = f.read_text()
        marker = "    model\n    {"
        if marker not in t:
            raise RuntimeError(f"0/{field}: model patch not found")
        f.write_text(t.replace(marker, bc(params, moving) + marker, 1))


# ---------------------------------------------------------------------------
# Symmetry plane (half-model solve) — X-Z plane at Y=0
# ---------------------------------------------------------------------------

_SYMMETRY_BC = (
    "    symmetry\n    {\n        type            symmetryPlane;\n    }\n")


def add_symmetry_plane(case_dir: str | Path) -> None:
    """Turn the domain's y-min face into a `symmetry` patch of type
    symmetryPlane and add its (value-free) boundary entry to the 0/ fields, so
    only the +Y half of the domain is solved. Composes with add_ground_plane:
    it carves its own face (0 1 5 4) out of whatever `walls` block currently
    exists, and symmetryPlane needs no per-field value."""
    case = Path(case_dir)

    # 1. blockMeshDict: split the y-min face (0 1 5 4) out of `walls`.
    bm = case / "system" / "blockMeshDict"
    bm.write_text(_split_wall_face(
        bm.read_text(), "(0 1 5 4)", "symmetry", "symmetryPlane"))

    # 2. 0/ fields: insert a `symmetry` entry just before the `model` patch.
    for field in ("U", "p", "k", "omega", "nut"):
        f = case / "0" / field
        t = f.read_text()
        marker = "    model\n    {"
        if marker not in t:
            raise RuntimeError(f"0/{field}: model patch not found")
        f.write_text(t.replace(marker, _SYMMETRY_BC + marker, 1))
