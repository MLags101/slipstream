"""Slipstream desktop app entry point.

Boots the FastAPI backend (serving both the API and the built frontend) on a
local port, then opens a native WKWebView window pointing at it. Frozen with
PyInstaller into Slipstream.app; also runnable from source:

    .venv/bin/python desktop_app.py
"""
from __future__ import annotations

import os
import socket
import sys
import threading
import time
import urllib.request
from pathlib import Path

PORT = 8321


def _resource(rel: str) -> Path:
    """Resolve a bundled resource (PyInstaller _MEIPASS) or source-tree path."""
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
    return base / rel


def _wait_for(url: str, timeout: float = 20.0) -> bool:
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            urllib.request.urlopen(url, timeout=1)
            return True
        except OSError:
            time.sleep(0.2)
    return False


def main() -> None:
    # Per-user data dir (never write inside the .app bundle). NOT under
    # ~/Library/Application Support: OpenFOAM cannot handle spaces in paths.
    data_dir = Path.home() / ".slipstream"
    legacy = Path.home() / ".windtunnel"  # before the rename to Slipstream
    if not data_dir.exists() and legacy.is_dir():
        data_dir = legacy  # keep existing runs where they are
    data_dir.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("SLIPSTREAM_DATA_DIR", str(data_dir))

    ui = _resource("ui")
    if not ui.is_dir():  # running from source tree
        ui = Path(__file__).resolve().parent.parent / "frontend" / "dist"
    os.environ.setdefault("SLIPSTREAM_STATIC", str(ui))

    # If the port is taken, assume another Slipstream instance owns it and
    # just open a window onto it.
    with socket.socket() as s:
        port_free = s.connect_ex(("127.0.0.1", PORT)) != 0

    if port_free:
        import uvicorn

        from app.main import app  # noqa: WPS433 (import after env setup)

        server = uvicorn.Server(uvicorn.Config(
            app, host="127.0.0.1", port=PORT, log_level="warning"))
        threading.Thread(target=server.run, daemon=True).start()

    url = f"http://127.0.0.1:{PORT}"
    if not _wait_for(f"{url}/api/health"):
        print("backend failed to start", file=sys.stderr)
        sys.exit(1)

    import webview

    webview.create_window("Slipstream", url, width=1480, height=940,
                          min_size=(1000, 700))
    webview.start()


if __name__ == "__main__":
    main()
