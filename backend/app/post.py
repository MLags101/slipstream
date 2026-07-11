"""Post-processing: OpenFOAM .dat parsing, result computation, viz JSON building."""
from __future__ import annotations

import re
from pathlib import Path

import numpy as np

# --------------------------------------------------------------------------
# .dat parsing (forceCoeffs coefficient.dat, solverInfo.dat)
# --------------------------------------------------------------------------

def parse_dat(path: str | Path) -> dict[str, np.ndarray]:
    """Parse an OpenFOAM function-object .dat file. Header lines start with '#';
    the last header line holds column names. Returns {column_name: array}."""
    path = Path(path)
    if not path.exists():
        return {}
    header: list[str] = []
    rows: list[list[float]] = []
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                if line.startswith("#"):
                    cols = line.lstrip("#").split()
                    if cols:
                        header = cols
                    continue
                parts = line.split()
                if not header or len(parts) != len(header):
                    # tolerate partial last line while solver is writing
                    continue
                row = []
                for x in parts:
                    try:
                        row.append(float(x))
                    except ValueError:
                        # non-numeric columns (e.g. solverInfo's "GAMG", "true")
                        row.append(float("nan"))
                rows.append(row)
    except OSError:
        return {}
    if not header or not rows:
        return {}
    data = np.asarray(rows, dtype=np.float64)
    return {name: data[:, i] for i, name in enumerate(header)}


def read_history(case_dir: str | Path) -> dict:
    """Build the /history payload from coefficient.dat + solverInfo.dat."""
    case_dir = Path(case_dir)
    coeffs = parse_dat(_latest_dat(case_dir, "forceCoeffs1", "coefficient.dat"))
    solver = parse_dat(_latest_dat(case_dir, "solverInfo1", "solverInfo.dat"))

    out = {
        "iters": [], "cd": [], "cl": [],
        "residuals": {"iters": [], "p": [], "Ux": [], "k": [], "omega": []},
    }
    if coeffs and "Time" in coeffs and "Cd" in coeffs:
        out["iters"] = _tolist(coeffs["Time"])
        out["cd"] = _tolist(coeffs["Cd"])
        out["cl"] = _tolist(coeffs.get("Cl", np.zeros(len(coeffs["Time"]))))
    if solver and "Time" in solver:
        out["residuals"]["iters"] = _tolist(solver["Time"])
        for key, col in (("p", "p_initial"), ("Ux", "Ux_initial"),
                         ("k", "k_initial"), ("omega", "omega_initial")):
            if col in solver:
                out["residuals"][key] = _tolist(solver[col])
    return out


def _latest_dat(case_dir: Path, fo_name: str, fname: str) -> Path:
    """Function objects write under postProcessing/<fo>/<startTime>/<fname>."""
    base = case_dir / "postProcessing" / fo_name
    candidates = sorted(base.glob(f"*/{fname}")) if base.exists() else []
    return candidates[-1] if candidates else base / "0" / fname


def _tolist(a: np.ndarray) -> list:
    return [float(x) for x in np.nan_to_num(a, nan=0.0, posinf=0.0, neginf=0.0)]


def compute_result(case_dir: str | Path, config: dict, model: dict,
                   mesh_cells: int | None, runtime_s: float) -> dict:
    """Averages over last 20% of iterations -> /result payload."""
    coeffs = parse_dat(_latest_dat(Path(case_dir), "forceCoeffs1", "coefficient.dat"))
    if not coeffs or "Cd" not in coeffs:
        raise RuntimeError("coefficient.dat missing or unparsable")
    n = len(coeffs["Cd"])
    w = max(1, int(round(n * 0.2)))
    win = slice(n - w, n)

    def avg(col: str) -> float:
        return float(np.mean(coeffs[col][win])) if col in coeffs else 0.0

    cd, cl, cs = avg("Cd"), avg("Cl"), avg("Cs")
    rho = float(config.get("rho") or 1.225)
    u = float(config["wind_speed"])
    area = float(model["frontal_area_m2"])
    qdyn = 0.5 * rho * u * u * area
    return {
        "cd": cd, "cl": cl, "cs": cs,
        "drag_N": cd * qdyn, "lift_N": cl * qdyn, "side_N": cs * qdyn,
        "frontal_area_m2": area, "wind_speed": u, "rho": rho,
        "iterations": int(coeffs["Time"][-1]),
        "mesh_cells": mesh_cells,
        "runtime_s": round(runtime_s, 1),
        "cd_std_last20pct": float(np.std(coeffs["Cd"][win])),
    }


# --------------------------------------------------------------------------
# Viz: sampled VTK surfaces -> flat-array JSON
# --------------------------------------------------------------------------

def _find_sampled(case_dir: Path, name: str) -> Path | None:
    """Locate postProcessing/surfaces1/<latestTime>/<name>.vt* file."""
    base = case_dir / "postProcessing" / "surfaces1"
    if not base.exists():
        return None
    hits = sorted(base.glob(f"*/{name}.vt*"),
                  key=lambda p: _time_key(p.parent.name))
    return hits[-1] if hits else None


def _time_key(s: str) -> float:
    try:
        return float(s)
    except ValueError:
        return -1.0


def _read_numbers(lines: list[str], i: int, count: int, conv=float) -> tuple[list, int]:
    out: list = []
    while len(out) < count and i < len(lines):
        out.extend(conv(t) for t in lines[i].split())
        i += 1
    if len(out) < count:
        raise RuntimeError("truncated VTK file")
    return out[:count], i


def _load_legacy_polydata(path: Path) -> tuple[np.ndarray, np.ndarray, dict]:
    """Parse an ASCII legacy VTK POLYDATA file (what OpenFOAM's sampled-surface
    vtk writer emits with legacy=true). Returns (points, triangles, point_fields);
    cell fields are averaged to points."""
    lines = path.read_text().splitlines()
    points: np.ndarray | None = None
    polys: list[list[int]] = []
    point_fields: dict[str, np.ndarray] = {}
    cell_fields: dict[str, np.ndarray] = {}
    mode: str | None = None
    i = 0
    while i < len(lines):
        parts = lines[i].split()
        i += 1
        if not parts:
            continue
        kw = parts[0]
        if kw == "POINTS":
            n = int(parts[1])
            vals, i = _read_numbers(lines, i, 3 * n)
            points = np.asarray(vals, dtype=np.float64).reshape(n, 3)
        elif kw == "POLYGONS":
            ncells, ntot = int(parts[1]), int(parts[2])
            vals, i = _read_numbers(lines, i, ntot, conv=int)
            j = 0
            for _ in range(ncells):
                c = vals[j]
                polys.append(vals[j + 1:j + 1 + c])
                j += c + 1
        elif kw == "POINT_DATA":
            mode = "point"
        elif kw == "CELL_DATA":
            mode = "cell"
        elif kw == "FIELD":
            nfields = int(parts[2])
            for _ in range(nfields):
                while i < len(lines) and not lines[i].split():
                    i += 1
                name, ncomp, n, _typ = lines[i].split()
                i += 1
                ncomp, n = int(ncomp), int(n)
                vals, i = _read_numbers(lines, i, ncomp * n)
                arr = np.asarray(vals, dtype=np.float64)
                if ncomp > 1:
                    arr = arr.reshape(n, ncomp)
                if mode == "point":
                    point_fields[name] = arr
                elif mode == "cell":
                    cell_fields[name] = arr
                # mode None: header FieldData (TimeValue) - ignore
    if points is None or not polys:
        raise RuntimeError(f"no polydata in {path.name}")

    # Fan-triangulate polygons; remember originating cell for cell-data mapping.
    tris: list[list[int]] = []
    for poly in polys:
        for j in range(1, len(poly) - 1):
            tris.append([poly[0], poly[j], poly[j + 1]])
    triangles = np.asarray(tris, dtype=np.int64)

    # Average any cell fields to points.
    for name, vals in cell_fields.items():
        if name in point_fields:
            continue
        shape = (len(points),) + (vals.shape[1:] if vals.ndim > 1 else ())
        acc = np.zeros(shape)
        cnt = np.zeros(len(points))
        for ci, poly in enumerate(polys):
            for pt in poly:
                acc[pt] += vals[ci]
                cnt[pt] += 1
        cnt[cnt == 0] = 1
        point_fields[name] = (acc.T / cnt).T
    return points, triangles, point_fields


def _load_tri_mesh(path: Path) -> tuple[np.ndarray, np.ndarray, dict]:
    """Read a sampled surface; triangulate; return per-point fields.
    Returns (points (n,3), triangles (m,3), point_fields {name: (n,) or (n,3)})."""
    if path.suffix == ".vtk":
        try:
            return _load_legacy_polydata(path)
        except RuntimeError:
            pass  # fall through to meshio
    import meshio

    m = meshio.read(str(path))
    points = np.asarray(m.points, dtype=np.float64)

    tris: list[np.ndarray] = []
    cell_owner: list[tuple[int, np.ndarray]] = []  # (block index, per-tri original cell idx)
    for bi, block in enumerate(m.cells):
        data = np.asarray(block.data)
        if block.type == "triangle":
            tris.append(data)
            cell_owner.append((bi, np.arange(len(data))))
        elif block.type == "quad":
            tris.append(data[:, [0, 1, 2]])
            tris.append(data[:, [0, 2, 3]])
            idx = np.arange(len(data))
            cell_owner.append((bi, idx))
            cell_owner.append((bi, idx))
        elif block.type == "polygon":
            # fan triangulation
            fan_t, fan_i = [], []
            for ci, poly in enumerate(data):
                for j in range(1, len(poly) - 1):
                    fan_t.append([poly[0], poly[j], poly[j + 1]])
                    fan_i.append(ci)
            if fan_t:
                tris.append(np.asarray(fan_t))
                cell_owner.append((bi, np.asarray(fan_i)))
    if not tris:
        raise RuntimeError(f"no polygonal cells in {path.name}")
    triangles = np.vstack(tris).astype(np.int64)

    fields: dict[str, np.ndarray] = {}
    for name, arr in (m.point_data or {}).items():
        fields[name] = np.asarray(arr, dtype=np.float64)

    # If any field only exists as cell data, average cells to points.
    for name in (m.cell_data or {}):
        if name in fields:
            continue
        acc = np.zeros((len(points),) + np.asarray(m.cell_data[name][0]).shape[1:])
        cnt = np.zeros(len(points))
        for bi, block in enumerate(m.cells):
            vals = np.asarray(m.cell_data[name][bi], dtype=np.float64)
            if block.type == "polygon":
                for ci, poly in enumerate(block.data):
                    for pt in poly:
                        acc[pt] += vals[ci]
                        cnt[pt] += 1
            else:
                for k in range(np.asarray(block.data).shape[1]):
                    col = np.asarray(block.data)[:, k]
                    np.add.at(acc, col, vals)
                    np.add.at(cnt, col, 1)
        cnt[cnt == 0] = 1
        fields[name] = (acc.T / cnt).T if acc.ndim > 1 else acc / cnt

    return points, triangles, fields


def _clean(a: np.ndarray) -> np.ndarray:
    return np.nan_to_num(np.asarray(a, dtype=np.float64), nan=0.0, posinf=0.0, neginf=0.0)


def _rng(a: np.ndarray) -> list[float]:
    return [float(a.min()), float(a.max())] if a.size else [0.0, 0.0]


def build_surface_viz(case_dir: str | Path, rho: float, u_inf: float) -> dict:
    """Model surface with pressure (Pa) and Cp, flat arrays for three.js."""
    path = _find_sampled(Path(case_dir), "modelSurface")
    if path is None:
        raise RuntimeError("sampled model surface not found under postProcessing/surfaces1")
    points, tris, fields = _load_tri_mesh(path)
    if "p" not in fields:
        raise RuntimeError("field 'p' missing on sampled model surface")
    p_kin = _clean(fields["p"]).reshape(-1)
    p_pa = p_kin * rho
    qdyn = 0.5 * rho * u_inf * u_inf
    cp = p_pa / qdyn if qdyn > 0 else np.zeros_like(p_pa)
    return {
        "positions": [round(float(x), 6) for x in points.ravel()],
        "indices": [int(i) for i in tris.ravel()],
        "fields": {"p": _tolist(p_pa), "cp": _tolist(cp)},
        "ranges": {"p": _rng(p_pa), "cp": _rng(cp)},
    }


def plane_payload(points: np.ndarray, tris: np.ndarray, fields: dict, rho: float) -> dict:
    """Flat-array JSON for a sampled plane carrying U and p."""
    if "U" not in fields or "p" not in fields:
        raise RuntimeError("fields U/p missing on sampled plane")
    u = _clean(fields["U"]).reshape(len(points), -1)
    u_mag = np.linalg.norm(u, axis=1)
    p_pa = _clean(fields["p"]).reshape(-1) * rho
    return {
        "positions": [round(float(x), 6) for x in points.ravel()],
        "indices": [int(i) for i in tris.ravel()],
        "fields": {"u_mag": _tolist(u_mag), "p": _tolist(p_pa)},
        "ranges": {"u_mag": _rng(u_mag), "p": _rng(p_pa)},
    }


def build_slice_viz(case_dir: str | Path, axis: str, rho: float) -> dict:
    """Center cutting plane (y or z normal) with u_mag (m/s) and p (Pa)."""
    name = "sliceY" if axis == "y" else "sliceZ"
    path = _find_sampled(Path(case_dir), name)
    if path is None:
        raise RuntimeError(f"sampled {name} not found under postProcessing/surfaces1")
    points, tris, fields = _load_tri_mesh(path)
    return plane_payload(points, tris, fields, rho)


def load_legacy_polylines(path: Path) -> tuple[np.ndarray, list[list[int]], dict]:
    """Parse an ASCII legacy VTK POLYDATA file containing LINES (streamline
    tracks). Returns (points, polylines as point-index lists, point_fields)."""
    lines = path.read_text().splitlines()
    points: np.ndarray | None = None
    tracks: list[list[int]] = []
    point_fields: dict[str, np.ndarray] = {}
    mode: str | None = None
    i = 0
    while i < len(lines):
        parts = lines[i].split()
        i += 1
        if not parts:
            continue
        kw = parts[0]
        if kw == "POINTS":
            n = int(parts[1])
            vals, i = _read_numbers(lines, i, 3 * n)
            points = np.asarray(vals, dtype=np.float64).reshape(n, 3)
        elif kw == "LINES":
            ncells, ntot = int(parts[1]), int(parts[2])
            vals, i = _read_numbers(lines, i, ntot, conv=int)
            j = 0
            for _ in range(ncells):
                c = vals[j]
                tracks.append(vals[j + 1:j + 1 + c])
                j += c + 1
        elif kw == "POINT_DATA":
            mode = "point"
        elif kw == "CELL_DATA":
            mode = "cell"
        elif kw == "FIELD":
            nfields = int(parts[2])
            for _ in range(nfields):
                while i < len(lines) and not lines[i].split():
                    i += 1
                name, ncomp, n, _typ = lines[i].split()
                i += 1
                ncomp, n = int(ncomp), int(n)
                vals, i = _read_numbers(lines, i, ncomp * n)
                arr = np.asarray(vals, dtype=np.float64)
                if ncomp > 1:
                    arr = arr.reshape(n, ncomp)
                if mode == "point":
                    point_fields[name] = arr
    if points is None or not tracks:
        raise RuntimeError(f"no line tracks in {path.name}")
    return points, tracks, point_fields


# --------------------------------------------------------------------------
# Misc log parsing
# --------------------------------------------------------------------------

_CELLS_RE = re.compile(r"^\s*cells:\s*(\d+)", re.MULTILINE)


def parse_cell_count(check_mesh_log: str | Path) -> int | None:
    try:
        text = Path(check_mesh_log).read_text(errors="replace")
    except OSError:
        return None
    m = _CELLS_RE.search(text)
    return int(m.group(1)) if m else None
