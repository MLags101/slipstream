"""Generate a simple 5-inch-class quad frame STL (mm units) for demo/testing.

Overlapping closed primitive shells (no CSG union) — fine for snappyHexMesh
and for frontal-area rasterization.
"""

from pathlib import Path

import numpy as np
import trimesh


def rot_z(mesh: trimesh.Trimesh, deg: float) -> trimesh.Trimesh:
    m = mesh.copy()
    m.apply_transform(trimesh.transformations.rotation_matrix(np.radians(deg), [0, 0, 1]))
    return m


def make_quad() -> trimesh.Trimesh:
    parts = []

    # Center stack: bottom plate + FC stack + battery on top
    parts.append(trimesh.creation.box(extents=[95, 55, 6]))
    stack = trimesh.creation.box(extents=[40, 40, 22])
    stack.apply_translation([0, 0, 14])
    parts.append(stack)
    battery = trimesh.creation.box(extents=[75, 36, 28])
    battery.apply_translation([0, 0, 39])
    parts.append(battery)

    # Four arms in X configuration, motor pods at the tips
    for ang in (45, 135, 225, 315):
        arm = trimesh.creation.box(extents=[110, 12, 6])
        arm.apply_translation([80, 0, 0])
        parts.append(rot_z(arm, ang))

        motor = trimesh.creation.cylinder(radius=14, height=22, sections=32)
        motor.apply_translation([125, 0, 11])
        parts.append(rot_z(motor, ang))

    # Camera pod tilted at the front
    cam = trimesh.creation.box(extents=[20, 30, 20])
    cam.apply_transform(trimesh.transformations.rotation_matrix(np.radians(-25), [0, 1, 0]))
    cam.apply_translation([52, 0, 16])
    parts.append(cam)

    return trimesh.util.concatenate(parts)


if __name__ == "__main__":
    mesh = make_quad()
    out = Path(__file__).parent / "quad_frame.stl"
    mesh.export(out)
    print(f"wrote {out}: {len(mesh.faces)} tris, extents {mesh.extents} mm")
