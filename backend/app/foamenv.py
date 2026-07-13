"""Locate the OpenFOAM wrapper across install styles (brew, openfoam.app)."""
from __future__ import annotations

import glob
import os
import shutil

_CANDIDATES = [
    os.environ.get("WINDTUNNEL_OPENFOAM", ""),
    "/opt/homebrew/bin/openfoam",
    "/usr/local/bin/openfoam",
]


def find_openfoam() -> str | None:
    """Absolute path to the `openfoam` wrapper, or None if not installed."""
    for c in _CANDIDATES:
        if c and os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    hit = shutil.which("openfoam")
    if hit:
        return hit
    apps = sorted(glob.glob(
        "/Applications/OpenFOAM-v*.app/Contents/Resources/etc/openfoam"))
    return apps[-1] if apps else None


OPENFOAM = find_openfoam() or "openfoam"
