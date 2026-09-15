"""Half-model symmetry detection on large meshes."""
import numpy as np
import trimesh

from app.geometry import symmetry_error_y


def test_large_symmetric_mesh_scores_zero():
    # 40k+ vertices: more than the query sample, so a subsampled reference set
    # would miss exact mirror partners.
    mesh = trimesh.creation.icosphere(subdivisions=6, radius=50.0)
    assert len(mesh.vertices) > 20000
    assert symmetry_error_y(mesh) < 1e-9


def test_large_mesh_with_sparse_flat_faces_scores_zero():
    # Dense rounded end + a few huge flat triangles: the shape of a decimated
    # car body, which scored ~0.018 against a subsample.
    cap = trimesh.creation.icosphere(subdivisions=6, radius=100.0)
    box = trimesh.creation.box(extents=[1000.0, 200.0, 200.0])
    box.apply_translation([500.0, 0.0, 0.0])
    mesh = trimesh.util.concatenate([cap, box])
    assert symmetry_error_y(mesh) < 1e-9


def test_asymmetric_mesh_scores_high():
    mesh = trimesh.creation.icosphere(subdivisions=6, radius=50.0)
    keep = mesh.vertices[:, 1] > -10.0
    faces = mesh.faces[keep[mesh.faces].all(axis=1)]
    lopsided = trimesh.Trimesh(mesh.vertices, faces, process=True)
    lopsided.apply_translation(-lopsided.bounds.mean(axis=0))
    assert symmetry_error_y(lopsided) > 0.05


def test_degenerate_width_is_inf():
    flat = trimesh.Trimesh(np.array([[0, 0, 0], [1, 0, 0], [0, 0, 1.0]]), [[0, 1, 2]])
    assert symmetry_error_y(flat) == float("inf")
