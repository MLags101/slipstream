"""pymeshlab decimation, run in a process that is allowed to die.

pymeshlab's `PluginManager` destructor corrupts the heap while the interpreter
is tearing down: `__cxa_finalize_ranges` -> `~PluginManager()` -> abort inside
libsystem_malloc (`free_tiny`), as SIGABRT or SIGSEGV. It happens after all the
real work is finished, so results are correct — but any process that has
imported pymeshlab can die on the way out, which in the long-lived backend
shows up as a "Python quit unexpectedly" dialog when the desktop app is closed.

So pymeshlab is never imported into the backend: `repair._decimate_pymeshlab`
runs this module as `python -m app.pymeshlab_worker in.npz out.npz target` and
reads the result back from `out.npz`. The child's exit status is ignored; only
a complete output file counts. It also leaves via `os._exit`, which skips the
C++ static teardown entirely, so the crash does not happen here either.
"""
from __future__ import annotations

import os
import sys

import numpy as np


def decimate(vertices: np.ndarray, faces: np.ndarray, target: int):
    """Quadric edge collapse to `target` faces; returns (vertices, faces).

    Raises if pymeshlab is missing or its plugins didn't load (it then imports
    fine but has no filters — seen on headless Linux without libOpenGL). The
    caller treats any failure as "no result" and falls back.
    """
    import pymeshlab

    ms = pymeshlab.MeshSet()
    ms.add_mesh(pymeshlab.Mesh(vertex_matrix=vertices.astype(np.float64),
                               face_matrix=faces.astype(np.int32)))
    ms.meshing_decimation_quadric_edge_collapse(
        targetfacenum=int(target), preservetopology=True,
        preserveboundary=True, preservenormal=True,
        optimalplacement=True, planarquadric=True,
        qualitythr=0.4, autoclean=True)
    m = ms.current_mesh()
    return m.vertex_matrix(), m.face_matrix()


def main(argv: list[str]) -> None:
    src, dst, target = argv[0], argv[1], int(argv[2])
    with np.load(src) as data:
        vertices, faces = decimate(data["vertices"], data["faces"], target)
    # Write, then rename: the parent takes the file's existence as proof that
    # the whole result made it to disk.
    part = dst + ".part.npz"
    np.savez(part, vertices=vertices, faces=faces)
    os.replace(part, dst)


if __name__ == "__main__":
    main(sys.argv[1:])
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0)   # see the module docstring: never run pymeshlab's teardown
