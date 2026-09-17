"""Mesh import: format detection, zip handling, polyMesh parsing, roles."""
import gzip
import io
import zipfile
from pathlib import Path

import pytest

from app import foamcase, meshimport as mi

HEADER = """/*--------------------------------*- C++ -*----------------------------------*\\
| =========                 |                                                 |
\\*---------------------------------------------------------------------------*/
FoamFile
{{
    version     2.0;
    format      {fmt};
    class       {cls};
    location    "constant/polyMesh";
    object      {obj};
}}
// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //

"""

BOUNDARY = HEADER.format(fmt="ascii", cls="polyBoundaryMesh", obj="boundary") + """
4
(
    inlet
    {
        type            patch;
        nFaces          1;
        startFace       0;
    }
    outlet
    {
        type            patch;
        nFaces          1;
        startFace       1;
    }
    farfield
    {
        type            patch;
        physicalType    patch;
        nFaces          1;
        startFace       2;
    }
    hull
    {
        type            wall;
        inGroups        1(wall);
        nFaces          2;
        startFace       3;
    }
)

// ************************************************************************* //
"""

# Five points; faces 0-4 start at points 0, 1, 2, 3 and 4 respectively.
POINTS = HEADER.format(fmt="ascii", cls="vectorField", obj="points") + """
5
(
(-1 0 0)
(2 0 0)
(0 5 0)
(0 0 1)
(0 0 3)
)
"""

FACES_COMPACT = HEADER.format(fmt="ascii", cls="faceCompactList", obj="faces") + """
6
(
0
3
6
9
12
15
)


15
(
0 1 2
1 2 3
2 3 4
3 4 0
4 0 1
)
"""

FACES_LIST = HEADER.format(fmt="ascii", cls="faceList", obj="faces") + """
5
(
3(0 1 2)
3(1 2 3)
3(2 3 4)
3(3 4 0)
3(4 0 1)
)
"""

CHECKMESH_LOG = """Mesh stats
    points:           310757
    cells:            256439
Overall domain bounding box (-0.92 -0.61 -0.168) (1.94 0.61 0.4)
Checking geometry...
Mesh OK.
"""


def write(path: Path, data: bytes | str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data if isinstance(data, bytes) else data.encode())
    return path


def make_zip(tmp_path: Path, files: dict[str, bytes | str]) -> Path:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data in files.items():
            zf.writestr(name, data)
    return write(tmp_path / "mesh.zip", buf.getvalue())


def polymesh_files(prefix: str = "") -> dict[str, str]:
    return {f"{prefix}{name}": text for name, text in {
        "boundary": BOUNDARY, "points": POINTS, "faces": FACES_COMPACT,
        "owner": "owner", "neighbour": "neighbour"}.items()}


PATCHES = mi.parse_boundary(BOUNDARY)
ROLES = {"inlet": "inlet", "outlet": "outlet", "farfield": "slip", "hull": "model"}


# -- format detection ---------------------------------------------------------

def test_detects_formats(tmp_path):
    assert mi.detect_format(write(tmp_path / "a.msh", "$MeshFormat\n2.2 0 8\n$EndMeshFormat\n")) == "gmsh"
    assert mi.detect_format(write(tmp_path / "b.msh", '(0 "Fluent mesh")\n(2 3)\n')) == "fluent"
    assert mi.detect_format(make_zip(tmp_path, polymesh_files())) == "polymesh_zip"


@pytest.mark.parametrize("text, fragment", [
    ("$MeshFormat\n4.1 0 8\n$EndMeshFormat\n", "Version 2 ASCII"),
    ("$MeshFormat\n2.2 1 8\n", "binary Gmsh"),
    ("solid cube\nfacet normal 0 0 1\n", "unrecognized mesh file"),
])
def test_rejects_unsupported_files(tmp_path, text, fragment):
    with pytest.raises(mi.MeshImportError, match=fragment):
        mi.detect_format(write(tmp_path / "x.msh", text))


# -- zipped polyMesh ------------------------------------------------------------

def test_zip_polymesh_is_found_in_a_subfolder_and_gunzipped(tmp_path):
    files = polymesh_files("case/constant/polyMesh/")
    files["case/constant/polyMesh/faces.gz"] = gzip.compress(files.pop(
        "case/constant/polyMesh/faces").encode())
    files["case/constant/polyMesh/sets/region1"] = "ignored"
    files["case/system/controlDict"] = "ignored"
    dest = tmp_path / "poly"
    mi.extract_polymesh_zip(make_zip(tmp_path, files), dest)
    assert sorted(p.name for p in dest.iterdir()) == sorted(mi.POLYMESH_FILES)
    assert "faceCompactList" in (dest / "faces").read_text()


def test_zip_with_unsafe_paths_is_refused(tmp_path):
    files = polymesh_files()
    files["../../evil.sh"] = "rm -rf ~"
    with pytest.raises(mi.MeshImportError, match="unsafe path"):
        mi.extract_polymesh_zip(make_zip(tmp_path, files), tmp_path / "poly")
    assert not (tmp_path.parent / "evil.sh").exists()


@pytest.mark.parametrize("drop, fragment", [("boundary", "no polyMesh/boundary"),
                                             ("owner", "missing: owner")])
def test_zip_missing_files(tmp_path, drop, fragment):
    files = polymesh_files()
    files.pop(drop)
    with pytest.raises(mi.MeshImportError, match=fragment):
        mi.extract_polymesh_zip(make_zip(tmp_path, files), tmp_path / "poly")


# -- parsing ------------------------------------------------------------------

def test_parse_boundary():
    assert PATCHES == [
        {"name": "inlet", "type": "patch", "faces": 1, "start_face": 0},
        {"name": "outlet", "type": "patch", "faces": 1, "start_face": 1},
        {"name": "farfield", "type": "patch", "faces": 1, "start_face": 2},
        {"name": "hull", "type": "wall", "faces": 2, "start_face": 3},
    ]


@pytest.mark.parametrize("faces", [FACES_COMPACT, FACES_LIST])
def test_patch_centers_from_ascii_polymesh(tmp_path, faces):
    poly = tmp_path / "poly"
    write(poly / "points", POINTS)
    write(poly / "faces", faces)
    centers = mi.patch_centers(poly, PATCHES)
    assert centers["inlet"] == [-1.0, 0.0, 0.0]
    assert centers["outlet"] == [2.0, 0.0, 0.0]
    assert centers["hull"] == [0.0, 0.0, 2.0]  # faces 3 and 4 start at points 3 and 4


def test_patch_centers_skip_binary_files(tmp_path):
    poly = tmp_path / "poly"
    write(poly / "points", POINTS.replace("format      ascii", "format      binary"))
    write(poly / "faces", FACES_COMPACT)
    assert mi.patch_centers(poly, PATCHES) is None


def test_parse_checkmesh():
    assert mi.parse_checkmesh(CHECKMESH_LOG) == {
        "cells": 256439, "bounds_m": [[-0.92, -0.61, -0.168], [1.94, 0.61, 0.4]],
        "ok": True, "failed_checks": 0}
    failed = mi.parse_checkmesh("cells: 10\nFailed 2 mesh checks.\n")
    assert failed["ok"] is False and failed["failed_checks"] == 2


# -- roles ------------------------------------------------------------------------

def test_guess_roles_from_names():
    patches = [{"name": n, "type": "patch", "faces": 1, "start_face": 0} for n in (
        "velocity-inlet-5", "pressure_outlet", "symmetryPlane", "farfield", "defaultFaces",
        "hull", "rudder")]
    assert mi.guess_roles(patches) == {
        "velocity-inlet-5": "inlet", "pressure_outlet": "outlet", "symmetryPlane": "symmetry",
        "farfield": "slip", "defaultFaces": "slip", "hull": "model", "rudder": "model"}


CENTERS = {"inlet": [-1.0, 0, 0], "outlet": [2.0, 0, 0], "farfield": [0, 5, 0], "hull": [0, 0, 2]}


@pytest.mark.parametrize("roles, fragment", [
    ({"inlet": "inlet", "outlet": "outlet", "farfield": "slip"}, "missing: hull"),
    (dict(ROLES, extra="slip"), "unknown: extra"),
    (dict(ROLES, farfield="sky"), "unknown role for farfield"),
    (dict(ROLES, hull="wall"), "at least one patch the model role"),
    ({"inlet": "outlet", "outlet": "inlet", "farfield": "slip", "hull": "model"}, None),
])
def test_validate_roles_errors(roles, fragment):
    if fragment is None:  # swapped inlet/outlet: caught by the +X check
        fragment = "reserved"
    with pytest.raises(mi.MeshImportError, match=fragment):
        mi.validate_roles(PATCHES, roles, CENTERS)


def test_validate_roles_accepts_a_good_mapping():
    mi.validate_roles(PATCHES, ROLES, CENTERS)
    mi.validate_roles(PATCHES, ROLES, None)  # binary mesh: no position check


def test_inlet_must_be_upstream():
    patches = [dict(p, name=n) for p, n in zip(PATCHES, ("front", "back", "farfield", "hull"))]
    roles = {"front": "outlet", "back": "inlet", "farfield": "slip", "hull": "model"}
    centers = {"front": [-1.0, 0, 0], "back": [2.0, 0, 0]}
    with pytest.raises(mi.MeshImportError, match="upstream"):
        mi.validate_roles(patches, roles, centers)


def test_2d_meshes_are_refused():
    patches = PATCHES + [{"name": "frontAndBack", "type": "empty", "faces": 4, "start_face": 5}]
    with pytest.raises(mi.MeshImportError, match="2D"):
        mi.validate_roles(patches, dict(ROLES, frontAndBack="slip"), CENTERS)


# -- case files -----------------------------------------------------------------

def test_rewrite_boundary_sets_types_and_groups():
    roles = {"inlet": "inlet", "outlet": "outlet", "farfield": "symmetry", "hull": "wall"}
    text = mi.rewrite_boundary(BOUNDARY, roles)
    patches = {p["name"]: p for p in mi.parse_boundary(text)}
    assert [patches[n]["type"] for n in roles] == ["patch", "patch", "symmetryPlane", "wall"]
    assert [patches[n]["faces"] for n in roles] == [1, 1, 1, 2]
    assert "physicalType" not in text
    assert "inGroups        1(inlet);" in text
    assert "inGroups        1(symmetry);" in text
    assert "inGroups        2(noSlipWalls wall);" in text
    assert text.startswith(BOUNDARY[:BOUNDARY.index("FoamFile")])


def model_case(tmp_path):
    model = {"bbox_m": [[-0.1, -0.1, -0.1], [0.1, 0.1, 0.1]], "frontal_area_m2": 0.04,
             "centroid": [0, 0, 0]}
    params = foamcase.compute_params(model, {"wind_speed": 10, "quality": "coarse"})
    case = tmp_path / "case"
    foamcase.generate_case(case, params)
    return case


def test_role_fields_only_added_for_roles_in_use(tmp_path):
    case = model_case(tmp_path)
    before = {f: (case / "0" / f).read_text() for f in ("U", "p", "k", "omega", "nut")}
    mi.add_role_fields(case, ROLES)
    assert all((case / "0" / f).read_text() == t for f, t in before.items())


def test_role_fields_for_noslip_walls_and_symmetry(tmp_path):
    case = model_case(tmp_path)
    mi.add_role_fields(case, dict(ROLES, farfield="wall", hull="model", extra="symmetry"))
    u = (case / "0" / "U").read_text()
    assert u.index("noSlipWalls") < u.index("    model\n") and "noSlip;" in u
    assert "symmetryPlane" in u
    assert "nutkWallFunction" in (case / "0" / "nut").read_text().split("noSlipWalls")[1]
    for field in ("p", "k", "omega"):
        text = (case / "0" / field).read_text()
        assert text.count("noSlipWalls") == 1 and text.count("symmetryPlane") == 1


def test_install_mesh_copies_and_retypes_without_translation(tmp_path):
    src = tmp_path / "src"
    for name, text in polymesh_files().items():
        write(src / name, text)
    write(src / "sets" / "region1", "x")
    case = tmp_path / "case"
    write(case / "constant" / "polyMesh" / "blockMeshLeftover", "old")
    mi.install_mesh(src, case, ROLES, [0.0, 0.0, 0.0])
    dst = case / "constant" / "polyMesh"
    assert sorted(p.name for p in dst.iterdir()) == sorted(mi.POLYMESH_FILES)
    types = {p["name"]: p["type"] for p in mi.parse_boundary((dst / "boundary").read_text())}
    assert types == {"inlet": "patch", "outlet": "patch", "farfield": "patch", "hull": "wall"}
