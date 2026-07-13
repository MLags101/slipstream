"""Generate the bundled sample STLs (mm units): a bluff car body and a wing."""
from pathlib import Path

import numpy as np
import trimesh


def make_car() -> trimesh.Trimesh:
    """Simple notchback car ~180 mm long (1:24-ish scale)."""
    parts = []
    body = trimesh.creation.box(extents=[180, 70, 34])
    body.apply_translation([0, 0, 27])
    parts.append(body)
    from shapely.geometry import Polygon as ShapelyPolygon
    cabin = trimesh.creation.extrude_polygon(
        ShapelyPolygon([(-62, 0), (-30, 30), (38, 30), (62, 0)]), height=58)
    # extrude along z then rotate: polygon was in x/z plane meaning
    cabin.apply_translation([0, 0, -29])
    cabin.apply_transform(trimesh.transformations.rotation_matrix(
        np.radians(90), [1, 0, 0]))
    cabin.apply_translation([-6, 0, 44 + 15])
    parts.append(cabin)
    for x in (-58, 58):
        for y in (-36, 36):
            wheel = trimesh.creation.cylinder(radius=15, height=12, sections=32)
            wheel.apply_transform(trimesh.transformations.rotation_matrix(
                np.radians(90), [1, 0, 0]))
            wheel.apply_translation([x, y, 15])
            parts.append(wheel)
    return trimesh.util.concatenate(parts)


def make_wing() -> trimesh.Trimesh:
    """Straight wing, ~240 mm span, simple symmetric airfoil, 60 mm chord."""
    # NACA-0012-ish outline
    xs = np.linspace(0, 1, 40)
    yt = 0.12 / 0.2 * (0.2969 * np.sqrt(xs) - 0.126 * xs - 0.3516 * xs**2
                       + 0.2843 * xs**3 - 0.1036 * xs**4)
    upper = np.column_stack([xs, yt])
    lower = np.column_stack([xs[::-1], -yt[::-1]])
    outline = np.vstack([upper, lower[1:-1]]) * 60.0  # 60 mm chord
    from shapely.geometry import Polygon as ShapelyPolygon
    wing = trimesh.creation.extrude_polygon(ShapelyPolygon(outline), height=240)
    # extrusion axis (z) -> span along y; chord x; thickness z
    wing.apply_transform(trimesh.transformations.rotation_matrix(
        np.radians(-90), [1, 0, 0]))
    wing.apply_translation([-30, 120, 0])
    # small angle of attack so it makes lift out of the box
    wing.apply_transform(trimesh.transformations.rotation_matrix(
        np.radians(-5), [0, 1, 0]))
    return wing


if __name__ == "__main__":
    out = Path(__file__).parent
    for name, mesh in (("sample_car.stl", make_car()),
                       ("sample_wing.stl", make_wing())):
        mesh.export(out / name)
        print(name, len(mesh.faces), "tris, extents", mesh.extents.round(1))
