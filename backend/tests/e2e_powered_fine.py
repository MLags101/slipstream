"""Regression: a powered case at `fine` quality must stay physical.

Guards the failure investigated on 2026-07-26, where a powered fine run reported
a confident Cd averaged from a +/-260 swing. The cause was NOT the actuator disks
(the pathological cells sat 104-124 mm from every disk axis, outside all four)
but a leaking interior cavity in a non-watertight assembly export, which drove
peak |U| to 2.3e4 m/s against a 25 m/s freestream.

This runs the WATERTIGHT sample quad frame, which is the control that proved
fine + powered is healthy in itself. It asserts the run converges, that peak
speed stays physical, and that peak k stays within a few orders of magnitude of
freestream k — the invariant a disk-side regression was originally asked for.

Slow (fine meshing dominates, ~20-40 min) and needs the server on :8000, so it
is a standalone script rather than part of the pytest run:

    .venv/bin/python3 tests/e2e_powered_fine.py
"""
from __future__ import annotations

import json
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import post  # noqa: E402
from app.runner import Runner  # noqa: E402

BASE = "http://localhost:8000"
FRAME = Path(__file__).resolve().parents[2] / "examples" / "quad_frame.stl"
DATA = Path(__file__).resolve().parents[1] / "data" / "runs"

U0 = 25.0
# Sample frame: motors at radius 125 mm on the 45 deg diagonals, tops at z=22.
HUB = 125.0 / (2 ** 0.5)
PROPS = [{"center": [sx * HUB, sy * HUB, 24.0], "diameter": 127.0,
          "thrust_g": 250.0}
         for sx, sy in ((1, 1), (1, -1), (-1, 1), (-1, -1))]

# Freestream k at the solver's 1% inlet intensity.
K_FREESTREAM = 1.5 * (0.01 * U0) ** 2


def api(path: str, method: str = "GET", data=None, headers=None):
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers=headers or {})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


def post_run() -> str:
    config = json.dumps({
        "name": "regression powered fine", "unit": "mm", "wind_speed": U0,
        "yaw_deg": 0, "pitch_deg": -16.0, "quality": "fine", "props": PROPS,
    })
    b = "regressionboundary"
    body = (f"--{b}\r\nContent-Disposition: form-data; name=\"config\"\r\n\r\n"
            f"{config}\r\n").encode()
    body += (f"--{b}\r\nContent-Disposition: form-data; name=\"stl\"; "
             f"filename=\"quad_frame.stl\"\r\n"
             f"Content-Type: application/octet-stream\r\n\r\n").encode()
    body += FRAME.read_bytes() + f"\r\n--{b}--\r\n".encode()
    return api("/api/runs", "POST", body,
               {"Content-Type": f"multipart/form-data; boundary={b}"})["id"]


def main() -> int:
    if not FRAME.exists():
        print(f"FAIL: missing fixture {FRAME}")
        return 1
    run_id = post_run()
    print(f"run {run_id} — polling (fine meshing is slow)")

    while True:
        s = api(f"/api/runs/{run_id}")
        if s["status"] in ("done", "error", "cancelled"):
            break
        print(f"  {s['status']:14s} {100 * (s.get('progress') or 0):3.0f}%  "
              f"{(s.get('message') or '')[:60]}")
        time.sleep(30)

    case = DATA / run_id / "case"
    umax = post.read_max_speed(case)
    kmax = post.read_max_k(case)
    result = s.get("result") or {}
    print(f"\nstatus={s['status']} cd={result.get('cd')} "
          f"converged={result.get('converged')} "
          f"peak|U|={umax} peak_k={kmax}")

    failures = []
    if s["status"] != "done":
        failures.append(f"run did not finish: {s['status']} — {s.get('error')}")
    if result.get("converged") is not True:
        failures.append(f"Cd never settled (cd_std={result.get('cd_std_last20pct')})")
    if umax is None:
        failures.append("maxU probe produced nothing — the guard cannot fire")
    elif umax > Runner.MAX_SPEED_FACTOR * U0:
        failures.append(f"peak |U| {umax:.4g} m/s exceeds "
                        f"{Runner.MAX_SPEED_FACTOR:g}x freestream")
    if kmax is None:
        failures.append("maxK probe produced nothing")
    elif kmax > 1e4 * K_FREESTREAM:
        failures.append(f"peak k {kmax:.4g} is more than 1e4x freestream k "
                        f"({K_FREESTREAM:.4g})")

    if failures:
        print("\nFAIL:")
        for f in failures:
            print("  -", f)
        return 1
    print("\nPASS: powered fine run stayed physical and converged")
    return 0


if __name__ == "__main__":
    sys.exit(main())
