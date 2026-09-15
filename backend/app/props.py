"""Find a multirotor's motors in its STL, so prop disks start on them.

Seen from above, a frame is a central body with arms ending in round motor
pads. In the footprint's distance transform (distance from each point to the
footprint's edge), a round pad is a local maximum roughly one motor radius
deep, while arms are only half an arm-width deep. So motors are the strongest
distance-transform peaks away from the center, taken if several agree.

Positions are in the STL's own units and frame, like the New run prop rows.
"""
from __future__ import annotations

import math

import numpy as np
import trimesh
from scipy import ndimage

from .geometry import UNIT_SCALE

GRID_CELLS = 400            # footprint raster: cells along the longer side
SAMPLES = 600_000           # surface samples used to rasterize the footprint
OUTER_RADIUS_FRAC = 0.45    # peaks must sit this far out (fraction of max radius)
PEAK_AGREE_FRAC = 0.75      # and be at least this deep relative to the deepest
MIN_MOTORS, MAX_MOTORS = 3, 8
PROP_GAP_FRAC = 0.95        # largest prop that leaves a gap between neighbors
DISK_CLEARANCE_FRAC = 0.02  # disk sits this fraction of model height above the motor

# Common prop diameters (inches).
STANDARD_PROPS_IN = (2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9, 10, 12, 13, 15, 18, 22, 28, 32)


def _footprint(mesh: trimesh.Trimesh, lo: np.ndarray, px: float,
               shape: tuple[int, int]) -> tuple[np.ndarray, np.ndarray]:
    """Top-down occupancy and max surface height per raster cell."""
    pts, _ = trimesh.sample.sample_surface(mesh, SAMPLES, seed=0)
    ix = ((pts[:, 0] - lo[0]) / px).astype(int) + 1
    iy = ((pts[:, 1] - lo[1]) / px).astype(int) + 1
    top = np.full(shape, -np.inf)
    np.maximum.at(top, (ix, iy), pts[:, 2])
    occ = ndimage.binary_fill_holes(ndimage.binary_closing(np.isfinite(top), iterations=2))
    return occ, top


def standard_prop_diameter(max_diameter: float, unit: str) -> float | None:
    """Largest common prop size (in STL units) that fits `max_diameter`."""
    scale_mm = UNIT_SCALE[unit] * 1000.0
    fits = [d * 25.4 / scale_mm for d in STANDARD_PROPS_IN if d * 25.4 / scale_mm <= max_diameter]
    return max(fits) if fits else None


def detect_props(mesh: trimesh.Trimesh, unit: str) -> dict:
    """{"props": [{"center": [x,y,z], "diameter": d}], "motor_radius", "reason"}.
    `props` is empty (with a reason) when the model doesn't look like a
    multirotor, so callers can fall back to a generic placement."""
    lo, hi = mesh.bounds
    ext = hi - lo
    if min(ext[0], ext[1]) <= 0:
        return {"props": [], "reason": "model has no footprint"}
    px = max(ext[0], ext[1]) / GRID_CELLS
    shape = (int(ext[0] / px) + 3, int(ext[1] / px) + 3)
    occ, top = _footprint(mesh, lo, px, shape)

    dt = ndimage.distance_transform_edt(occ) * px
    gx = lo[0] + (np.arange(shape[0]) - 0.5) * px
    gy = lo[1] + (np.arange(shape[1]) - 0.5) * px
    X, Y = np.meshgrid(gx, gy, indexing="ij")
    cx, cy = (lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2
    r = np.hypot(X - cx, Y - cy)
    outer = r > OUTER_RADIUS_FRAC * r[occ].max()
    peaks = (dt == ndimage.maximum_filter(dt, size=5)) & (dt > 2 * px) & outer & occ
    if not peaks.any():
        return {"props": [], "reason": "no motor pads found"}

    # Strongest first; suppress weaker peaks inside an accepted pad.
    order = sorted(zip(*np.nonzero(peaks)), key=lambda ij: -dt[ij])
    best = dt[order[0]]
    pads: list[tuple[float, float, float]] = []
    for i, j in order:
        depth = dt[i, j]
        if depth < PEAK_AGREE_FRAC * best:
            break
        x, y = X[i, j], Y[i, j]
        if all(math.hypot(x - px_, y - py_) > 2 * max(d_, depth) for px_, py_, d_ in pads):
            pads.append((x, y, depth))
    if not MIN_MOTORS <= len(pads) <= MAX_MOTORS:
        return {"props": [], "reason": f"found {len(pads)} motor-like pads, "
                                       f"expected {MIN_MOTORS}-{MAX_MOTORS}"}

    # Order around the center like the form's default placement.
    pads.sort(key=lambda p: math.atan2(p[1] - cy, p[0] - cx) % (2 * math.pi))
    gap = min(math.hypot(a[0] - b[0], a[1] - b[1])
              for k, a in enumerate(pads) for b in pads[k + 1:])
    diameter = standard_prop_diameter(PROP_GAP_FRAC * gap, unit) or round(0.8 * gap, 1)

    props = []
    for x, y, depth in pads:
        pad = (np.hypot(X - x, Y - y) <= depth) & np.isfinite(top)
        z = float(top[pad].max()) + DISK_CLEARANCE_FRAC * float(ext[2])
        props.append({"center": [round(float(x), 1), round(float(y), 1), round(z, 1)],
                      "diameter": round(float(diameter), 1)})
    motor_radius = float(np.median([p[2] for p in pads]))
    return {"props": props, "motor_radius": round(motor_radius, 1), "reason": None}
