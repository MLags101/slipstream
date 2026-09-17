"""Locate the OpenFOAM wrapper across install styles (brew, openfoam.app)."""
from __future__ import annotations

import glob
import os
import shutil

def env(name: str) -> str | None:
    """SLIPSTREAM_<name>, or the pre-rename WINDTUNNEL_<name> (still honored)."""
    return os.environ.get(f"SLIPSTREAM_{name}") or os.environ.get(f"WINDTUNNEL_{name}")


_CANDIDATES = [
    env("OPENFOAM") or "",
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
