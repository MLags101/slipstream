"""End-to-end smoke test: POST a 100 mm sphere at 15 m/s (coarse), poll to done,
validate /history, /result and /viz payloads. Requires the server on :8000."""
from __future__ import annotations

import json
import math
import sys
import time
import urllib.request
from pathlib import Path

BASE = "http://localhost:8000"
FIXTURE = Path(__file__).parent / "fixtures" / "sphere_100mm.stl"


def api(path: str, method: str = "GET", data=None, headers=None):
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers=headers or {})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


def post_run() -> str:
    if not FIXTURE.exists():
        import trimesh
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        trimesh.creation.icosphere(subdivisions=3, radius=50.0).export(FIXTURE)
    boundary = "e2eboundary123"
    config = json.dumps({"name": "e2e sphere", "unit": "mm", "wind_speed": 15.0,
                         "yaw_deg": 0, "quality": "coarse"})
    body = b""
    body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"config\"\r\n\r\n"
             f"{config}\r\n").encode()
    body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"stl\"; "
             f"filename=\"sphere_100mm.stl\"\r\n"
             f"Content-Type: application/octet-stream\r\n\r\n").encode()
    body += FIXTURE.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
    resp = api("/api/runs", "POST", body,
               {"Content-Type": f"multipart/form-data; boundary={boundary}"})
    return resp["id"]


def main() -> int:
    run_id = post_run()
    print("run id:", run_id)

    seen_statuses = []
    history_grew = False
    last_hist = 0
    t0 = time.time()
    while True:
        run = api(f"/api/runs/{run_id}")
        if run["status"] not in seen_statuses:
            seen_statuses.append(run["status"])
            print(f"[{time.time()-t0:6.0f}s] {run['status']:15s} "
                  f"{run['progress']:.2f}  {run['message']}")
        if run["status"] == "solving":
            hist = api(f"/api/runs/{run_id}/history")
            if len(hist["iters"]) > last_hist:
                if last_hist:
                    history_grew = True
                last_hist = len(hist["iters"])
        if run["status"] in ("done", "error"):
            break
        if time.time() - t0 > 3600:
            print("TIMEOUT"); return 1
        time.sleep(2)

    if run["status"] == "error":
        print("RUN FAILED:", run["error"])
        log = api(f"/api/runs/{run_id}/log?tail=40")
        print("\n".join(log["lines"]))
        return 1

    ok = True

    def check(cond, msg):
        nonlocal ok
        print(("PASS" if cond else "FAIL"), msg)
        ok = ok and cond

    check(seen_statuses[0] in ("queued", "preparing"), f"status transitions {seen_statuses}")
    check("solving" in seen_statuses and "done" in seen_statuses, "reached solving and done")
    check(history_grew, f"/history grew during solve ({last_hist} iters seen)")

    result = api(f"/api/runs/{run_id}/result")
    print("result:", json.dumps(result, indent=1))
    check(0.05 < result["cd"] < 2.0, f"Cd plausible: {result['cd']:.3f}")
    check(result["mesh_cells"] and result["mesh_cells"] > 50000,
          f"mesh cells: {result['mesh_cells']}")

    surf = api(f"/api/runs/{run_id}/viz/surface")
    n = len(surf["positions"]) // 3
    check(len(surf["positions"]) % 3 == 0 and n > 100, f"surface: {n} vertices")
    check(len(surf["indices"]) % 3 == 0 and max(surf["indices"]) < n,
          f"surface indices valid ({len(surf['indices'])//3} tris)")
    check(len(surf["fields"]["p"]) == n == len(surf["fields"]["cp"]),
          "surface field lengths match positions")
    check(all(math.isfinite(v) for v in surf["fields"]["p"] + surf["fields"]["cp"]),
          "surface values finite")
    check("p" in surf["ranges"] and "cp" in surf["ranges"], "surface ranges present")

    for axis in ("y", "z"):
        sl = api(f"/api/runs/{run_id}/viz/slice?axis={axis}")
        n = len(sl["positions"]) // 3
        check(n > 100 and len(sl["indices"]) % 3 == 0 and max(sl["indices"]) < n,
              f"slice {axis}: {n} verts, {len(sl['indices'])//3} tris")
        check(len(sl["fields"]["u_mag"]) == n == len(sl["fields"]["p"]),
              f"slice {axis} field lengths match")
        check(all(math.isfinite(v) for v in sl["fields"]["u_mag"] + sl["fields"]["p"]),
              f"slice {axis} values finite")
        umax = sl["ranges"]["u_mag"][1]
        check(15.0 < umax < 60.0, f"slice {axis} peak |U| plausible: {umax:.1f} m/s")

    runs = api("/api/runs")
    check(any(r["id"] == run_id for r in runs), "/api/runs lists the run")
    print("\nOVERALL:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
