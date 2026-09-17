"""Bring your own volume mesh: convert Gmsh / Fluent / zipped OpenFOAM meshes
into a WindTunnel case.

Import has two steps. `inspect_mesh` converts the upload to an OpenFOAM
polyMesh (in meters), runs checkMesh and lists the boundary patches with a
suggested role for each. The run then copies that polyMesh into its case.

Roles map onto OpenFOAM patch *groups* named like the patches WindTunnel's own
meshes have (inlet, outlet, walls, model), so the field files, force function
objects and surface sampling work unchanged: OpenFOAM matches boundaryField
and `patches (...)` entries against group names. Only no-slip walls and
symmetry planes need extra field entries.

Flow is always along +X, so the inlet must be upstream of the outlet.
"""
from __future__ import annotations

import gzip
import re
import shutil
import subprocess
import zipfile
from pathlib import Path

import numpy as np

from .foamenv import OPENFOAM, find_openfoam
from .geometry import UNIT_SCALE

ROLES = ("inlet", "outlet", "model", "slip", "wall", "symmetry")

# role -> (patch group used in the case files, OpenFOAM patch type)
ROLE_GROUP = {
    "inlet": ("inlet", "patch"),
    "outlet": ("outlet", "patch"),
    "model": ("model", "wall"),
    "slip": ("walls", "patch"),
    "wall": ("noSlipWalls", "wall"),
    "symmetry": ("symmetry", "symmetryPlane"),
}

POLYMESH_FILES = ("boundary", "faces", "neighbour", "owner", "points")
MAX_UNZIPPED_BYTES = 8 * 1024 ** 3

_CONTROL_DICT = """FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      controlDict;
}
application     simpleFoam;
startFrom       latestTime;
startTime       0;
stopAt          endTime;
endTime         1;
deltaT          1;
writeControl    timeStep;
writeInterval   1;
writeFormat     ascii;
writePrecision  10;
writeCompression off;
timeFormat      general;
runTimeModifiable false;
"""


# checkMesh and surfaceMeshExtract refuse to start without these.
_FV_SCHEMES = """FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      fvSchemes;
}
ddtSchemes { default steadyState; }
gradSchemes { default Gauss linear; }
divSchemes { default none; }
laplacianSchemes { default Gauss linear corrected; }
interpolationSchemes { default linear; }
snGradSchemes { default corrected; }
wallDist { method meshWave; }
"""

_FV_SOLUTION = """FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      fvSolution;
}
solvers {}
"""


class MeshImportError(ValueError):
    """A user-facing problem with the uploaded mesh (reported as a 422)."""


# ---------------------------------------------------------------------------
# Format detection and conversion
# ---------------------------------------------------------------------------

def detect_format(path: Path) -> str:
    """"gmsh", "fluent" or "polymesh_zip" from the file's contents."""
    if zipfile.is_zipfile(path):
        return "polymesh_zip"
    with open(path, "rb") as fh:
        head = fh.read(4096)
    if head.lstrip().startswith(b"$MeshFormat"):
        lines = head.lstrip().splitlines()
        parts = lines[1].split() if len(lines) > 1 else []
        version = parts[0].decode(errors="replace") if parts else "?"
        if not version.startswith("2"):
            raise MeshImportError(
                f"Gmsh format {version} isn't supported: export the mesh as "
                "\"Version 2 ASCII\" (File > Export > .msh, format version 2)")
        if len(parts) > 1 and parts[1] != b"0":
            raise MeshImportError("binary Gmsh files aren't supported: export as ASCII")
        return "gmsh"
    if re.match(rb"\s*\(\s*\d+\s", head):
        return "fluent"
    raise MeshImportError(
        "unrecognized mesh file: upload a Gmsh .msh (version 2 ASCII), an ASCII "
        "Fluent .msh/.cas, or a .zip of an OpenFOAM constant/polyMesh folder")


def extract_polymesh_zip(zip_path: Path, dest: Path) -> None:
    """Unpack the polyMesh folder from a zip into dest (flattened). Finds the
    folder that holds `boundary`, refuses unsafe paths, and gunzips .gz files."""
    with zipfile.ZipFile(zip_path) as zf:
        infos = [i for i in zf.infolist() if not i.is_dir()]
        if sum(i.file_size for i in infos) > MAX_UNZIPPED_BYTES:
            raise MeshImportError("zip unpacks to more than 8 GB")
        for i in infos:
            name = i.filename.replace("\\", "/")
            if name.startswith("/") or ".." in name.split("/"):
                raise MeshImportError(f"unsafe path in zip: {i.filename}")
        by_name = {i.filename.replace("\\", "/"): i for i in infos}
        bounds = [n for n in by_name if n.rsplit("/", 1)[-1] in ("boundary", "boundary.gz")]
        if not bounds:
            raise MeshImportError("zip has no polyMesh/boundary file")
        prefix = min(bounds, key=len).rsplit("/", 1)[0] + "/" if "/" in min(bounds, key=len) else ""
        dest.mkdir(parents=True, exist_ok=True)
        for name, info in by_name.items():
            if not name.startswith(prefix):
                continue
            rel = name[len(prefix):]
            if "/" in rel:  # sets/ and other subfolders aren't needed
                continue
            data = zf.read(info)
            if rel.endswith(".gz"):
                data, rel = gzip.decompress(data), rel[:-3]
            (dest / rel).write_bytes(data)
    missing = [f for f in POLYMESH_FILES if not (dest / f).exists()]
    if missing:
        raise MeshImportError(f"polyMesh in zip is missing: {', '.join(missing)}")


def run_foam(case: Path, cmd: str, log_name: str, timeout: float = 3600) -> int:
    foam = find_openfoam() or OPENFOAM
    log = case / log_name
    shell = f"cd '{case}' && {cmd} > '{log}' 2>&1"
    try:
        return subprocess.run([foam, "-c", shell], timeout=timeout).returncode
    except FileNotFoundError:
        raise RuntimeError("OpenFOAM not found") from None


def _log_tail(path: Path, n: int = 15) -> str:
    try:
        return "\n".join(path.read_text(errors="replace").splitlines()[-n:])
    except OSError:
        return "(no log)"


def convert(upload: Path, fmt: str, case: Path, unit: str) -> None:
    """Build case/constant/polyMesh (meters) from the upload."""
    write_minimal_case(case)
    (case / "constant").mkdir(parents=True, exist_ok=True)
    if fmt == "polymesh_zip":
        extract_polymesh_zip(upload, case / "constant" / "polyMesh")
    else:
        tool = "gmshToFoam" if fmt == "gmsh" else "fluent3DMeshToFoam"
        if run_foam(case, f"{tool} '{upload}'", "log.convert") != 0 or \
                not (case / "constant" / "polyMesh" / "owner").exists():
            raise MeshImportError(
                f"{tool} couldn't convert this mesh:\n{_log_tail(case / 'log.convert')}")
    # Rewrite the mesh as ASCII (controlDict above) so it can be read here.
    if run_foam(case, "foamFormatConvert -constant", "log.formatConvert") != 0:
        raise MeshImportError(
            f"couldn't read the mesh:\n{_log_tail(case / 'log.formatConvert')}")
    scale = UNIT_SCALE[unit]
    if scale != 1.0:
        s = f"{scale:.10g}"
        if run_foam(case, f"transformPoints -scale '({s} {s} {s})'", "log.scale") != 0:
            raise MeshImportError(f"scaling failed:\n{_log_tail(case / 'log.scale')}")


# ---------------------------------------------------------------------------
# polyMesh parsing (ASCII)
# ---------------------------------------------------------------------------

_ENTRY = re.compile(r"^[ \t]*([^\s{}()/;]+)\s*\{(.*?)\}", re.S | re.M)


def _body(text: str) -> str:
    """The list body of a FoamFile: everything after the header's closing
    brace, with // and /* */ comments removed."""
    header = re.search(r"FoamFile\s*\{.*?\}", text, re.S)
    body = text[header.end():] if header else text
    return re.sub(r"//[^\n]*|/\*.*?\*/", " ", body, flags=re.S)


def parse_boundary(text: str) -> list[dict]:
    patches = []
    for m in _ENTRY.finditer(_body(text)):
        body = m.group(2)
        def field(key: str) -> str | None:
            f = re.search(rf"\b{key}\s+([^;]+);", body)
            return f.group(1).strip() if f else None
        patches.append({"name": m.group(1), "type": field("type") or "patch",
                        "faces": int(field("nFaces") or 0),
                        "start_face": int(field("startFace") or 0)})
    return patches


def rewrite_boundary(text: str, roles: dict[str, str]) -> str:
    """Set each patch's type and group for its role (other keys untouched)."""
    def repl(m: re.Match) -> str:
        name, body = m.group(1), m.group(2)
        role = roles.get(name)
        if role is None:
            return m.group(0)
        group, ptype = ROLE_GROUP[role]
        groups = [group] + (["wall"] if ptype == "wall" else [])
        body = re.sub(r"\n[ \t]*(type|inGroups|physicalType)\s+[^;]*;", "", body)
        indent = "        "
        lines = (f"\n{indent}type            {ptype};"
                 f"\n{indent}inGroups        {len(groups)}({' '.join(groups)});")
        return f"{m.group(0)[:m.start(2) - m.start(0)]}{lines}{body}}}"
    head = re.search(r"FoamFile\s*\{.*?\}", text, re.S)
    cut = head.end() if head else 0
    return text[:cut] + _ENTRY.sub(repl, text[cut:])


def _numbers(text: str) -> np.ndarray:
    return np.array(re.sub(r"[()]", " ", _body(text)).split(), dtype=float)


def _first_vertices(faces_text: str) -> np.ndarray:
    """First vertex index of every face, from an ASCII `faces` file in either
    faceCompactList (offsets list + flat indices) or faceList (`4(a b c d)`)."""
    body = _body(faces_text)
    if re.search(r"class\s+faceCompactList", faces_text[:2000]):
        nums = np.array(re.sub(r"[()]", " ", body).split(), dtype=np.int64)
        n = int(nums[0])
        offsets = nums[1:1 + n]
        indices = nums[2 + n:2 + n + int(nums[1 + n])]
        return indices[offsets[:-1]]
    return np.array(re.findall(r"\d+\((\d+)", body), dtype=np.int64)


def patch_centers(poly: Path, patches: list[dict]) -> dict[str, list[float]] | None:
    """Mean position of each patch's faces (first vertex per face), from ASCII
    points/faces. None when the files can't be read as ASCII."""
    try:
        pts_text = (poly / "points").read_text()
        faces_text = (poly / "faces").read_text()
    except (OSError, UnicodeDecodeError):
        return None
    if any(re.search(r"format\s+binary", t[:2000]) for t in (pts_text, faces_text)):
        return None
    try:
        nums = _numbers(pts_text)
        n = int(nums[0])
        points = nums[1:1 + 3 * n].reshape(n, 3)
        firsts = _first_vertices(faces_text)
    except (ValueError, IndexError):
        return None
    out = {}
    for p in patches:
        idx = firsts[p["start_face"]:p["start_face"] + p["faces"]]
        if len(idx):
            out[p["name"]] = [round(float(v), 6) for v in points[idx].mean(axis=0)]
    return out


def parse_checkmesh(log_text: str) -> dict:
    cells = re.search(r"cells:\s+(\d+)", log_text)
    bbox = re.search(r"Overall domain bounding box\s*\(([^)]*)\)\s*\(([^)]*)\)", log_text)
    failed = re.search(r"Failed (\d+) mesh checks", log_text)
    return {
        "cells": int(cells.group(1)) if cells else None,
        "bounds_m": ([[float(v) for v in bbox.group(1).split()],
                      [float(v) for v in bbox.group(2).split()]] if bbox else None),
        "ok": "Mesh OK." in log_text,
        "failed_checks": int(failed.group(1)) if failed else 0,
    }


# ---------------------------------------------------------------------------
# Roles
# ---------------------------------------------------------------------------

_ROLE_HINTS = [
    ("inlet", r"inlet|inflow|^in$|velocity[-_]?inlet|upstream"),
    ("outlet", r"outlet|outflow|^out$|pressure[-_]?outlet|downstream"),
    ("symmetry", r"sym"),
    ("slip", r"^walls?$|farfield|far[-_]?field|tunnel|domain|top|bottom|side|lateral|"
             r"boundar|defaultfaces|frontandback"),
]


def guess_roles(patches: list[dict]) -> dict[str, str]:
    roles = {}
    for p in patches:
        name = p["name"].lower()
        role = next((r for r, pat in _ROLE_HINTS if re.search(pat, name)), None)
        # Anything unrecognized is most likely part of the body being tested.
        roles[p["name"]] = role or "model"
    return roles


def validate_roles(patches: list[dict], roles: dict,
                   centers: dict[str, list[float]] | None) -> None:
    names = {p["name"] for p in patches}
    if not isinstance(roles, dict) or set(roles) != names:
        missing = sorted(names - set(roles or {}))
        extra = sorted(set(roles or {}) - names)
        raise MeshImportError(
            "roles must name every patch exactly once"
            + (f"; missing: {', '.join(missing)}" if missing else "")
            + (f"; unknown: {', '.join(extra)}" if extra else ""))
    bad = sorted(n for n, r in roles.items() if r not in ROLES)
    if bad:
        raise MeshImportError(f"unknown role for {', '.join(bad)} (use one of {', '.join(ROLES)})")
    for need in ("inlet", "outlet", "model"):
        if need not in roles.values():
            raise MeshImportError(f"assign at least one patch the {need} role")
    # A patch literally named like a role group matches its field entry by
    # name, which would override the group entry for a different role.
    groups = {g: r for r, (g, _) in ROLE_GROUP.items()}
    for name, role in roles.items():
        if name in groups and groups[name] != role:
            raise MeshImportError(
                f"patch \"{name}\" must have the {groups[name]} role (its name is "
                f"reserved), or rename it in your mesher")
    if any(p["type"] == "empty" for p in patches):
        raise MeshImportError("2D meshes (empty patches) aren't supported; import a 3D mesh")
    if centers:
        xin = [centers[n][0] for n, r in roles.items() if r == "inlet" and n in centers]
        xout = [centers[n][0] for n, r in roles.items() if r == "outlet" and n in centers]
        if xin and xout and max(xin) >= min(xout):
            raise MeshImportError(
                "the wind blows along +X, so the inlet must be upstream (smaller x) of "
                "the outlet; rotate the mesh in your mesher or swap the roles")


# ---------------------------------------------------------------------------
# Case files
# ---------------------------------------------------------------------------

_NOSLIP_BC = {
    "U": "        type            noSlip;\n",
    "p": "        type            zeroGradient;\n",
    "k": "        type            kqRWallFunction;\n        value           $internalField;\n",
    "omega": "        type            omegaWallFunction;\n        value           $internalField;\n",
    "nut": "        type            nutkWallFunction;\n        value           $internalField;\n",
}


def add_role_fields(case: Path, roles: dict[str, str]) -> None:
    """Field entries for the roles WindTunnel's own template doesn't have."""
    used = set(roles.values())
    for field in ("U", "p", "k", "omega", "nut"):
        f = case / "0" / field
        text = f.read_text()
        marker = "    model\n    {"
        if marker not in text:
            raise RuntimeError(f"0/{field}: model patch not found")
        extra = ""
        if "wall" in used:
            extra += f"    noSlipWalls\n    {{\n{_NOSLIP_BC[field]}    }}\n"
        if "symmetry" in used:
            extra += "    symmetry\n    {\n        type            symmetryPlane;\n    }\n"
        f.write_text(text.replace(marker, extra + marker, 1))


def write_minimal_case(case: Path) -> None:
    """Just enough of a case for OpenFOAM utilities to open the mesh."""
    (case / "system").mkdir(parents=True, exist_ok=True)
    (case / "system" / "controlDict").write_text(_CONTROL_DICT)
    (case / "system" / "fvSchemes").write_text(_FV_SCHEMES)
    (case / "system" / "fvSolution").write_text(_FV_SOLUTION)


def install_mesh(src_poly: Path, case: Path, roles: dict[str, str],
                 translate: list[float]) -> None:
    """Copy an imported polyMesh into a generated case, move it into the model
    frame and give every patch the type and group of its role."""
    dst = case / "constant" / "polyMesh"
    shutil.rmtree(dst, ignore_errors=True)
    shutil.copytree(src_poly, dst, ignore=shutil.ignore_patterns("sets", "*.gz"))
    boundary = dst / "boundary"
    boundary.write_text(rewrite_boundary(boundary.read_text(), roles))
    if any(abs(v) > 0 for v in translate):
        t = " ".join(f"{v:.10g}" for v in translate)
        if run_foam(case, f"transformPoints -translate '({t})'", "log.transformPoints") != 0:
            raise RuntimeError(f"transformPoints failed:\n{_log_tail(case / 'log.transformPoints')}")


def inspect_mesh(upload: Path, case: Path, unit: str, filename: str) -> dict:
    """Convert an uploaded mesh and describe it for the role picker."""
    fmt = detect_format(upload)
    convert(upload, fmt, case, unit)
    poly = case / "constant" / "polyMesh"
    patches = parse_boundary((poly / "boundary").read_text())
    if not patches:
        raise MeshImportError("the mesh has no boundary patches")
    run_foam(case, "checkMesh -constant", "log.checkMesh")
    check = parse_checkmesh((case / "log.checkMesh").read_text(errors="replace")
                            if (case / "log.checkMesh").exists() else "")
    if not check["cells"]:
        raise MeshImportError(
            f"checkMesh couldn't read the converted mesh:\n{_log_tail(case / 'log.checkMesh')}")
    centers = patch_centers(poly, patches) or {}
    return {
        "filename": filename,
        "format": fmt,
        "unit": unit,
        "cells": check["cells"],
        "bounds_m": check["bounds_m"],
        "mesh_ok": check["ok"],
        "failed_checks": check["failed_checks"],
        "patches": [{"name": p["name"], "type": p["type"], "faces": p["faces"],
                     "center_m": centers.get(p["name"])} for p in patches],
        "suggested_roles": guess_roles(patches),
    }
