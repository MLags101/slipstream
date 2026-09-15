"""Submit the validation cases to a running WindTunnel backend as mesh-
independence sweeps, wait for them, and save the results.

    backend/.venv/bin/python examples/validation/make_models.py
    backend/.venv/bin/python examples/validation/run_validation.py [--api URL] [--only NAME]

Results land in examples/validation/results.json (one entry per case with the
mesh history and the reference value), which VALIDATION.md is written from.
"""
from __future__ import annotations

import argparse
import json
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent

CASES = [
    {
        "name": "sphere",
        "stl": "sphere_100mm.stl",
        "config": {"name": "Validation: sphere, Re 1e5", "unit": "mm",
                   "wind_speed": 15, "quality": "coarse", "symmetry": True,
                   "mesh_sweep": {"tol_pct": 2}},
        "reference": {"cd": 0.47, "source": "Achenbach (1972), J. Fluid Mech. 54; "
                      "subcritical sphere drag at Re = 1e5"},
    },
    {
        # Same STL read in cm: a 1 m sphere. At Re = 4e6 the real boundary layer
        # is turbulent before separation, which is what k-omega SST assumes
        # everywhere, so this is the regime the solver is built for.
        "name": "sphere_transcritical",
        "stl": "sphere_100mm.stl",
        "config": {"name": "Validation: 1 m sphere, Re 4e6", "unit": "cm",
                   "wind_speed": 60, "quality": "coarse", "symmetry": True,
                   "mesh_sweep": {"tol_pct": 2}},
        "reference": {"cd": 0.18, "source": "Achenbach (1972), J. Fluid Mech. 54; "
                      "transcritical sphere drag, Re = 4e6"},
    },
    {
        "name": "ahmed_25",
        "stl": "ahmed_25.stl",
        "config": {"name": "Validation: Ahmed body 25°, 60 m/s", "unit": "mm",
                   "wind_speed": 60, "quality": "coarse", "symmetry": True,
                   "ground_plane": True, "ground": "static",
                   "mesh_sweep": {"tol_pct": 2}},
        "reference": {"cd": 0.285, "source": "Ahmed, Ramm & Faltin (1984), SAE 840300; "
                      "25° slant at 60 m/s"},
    },
]


def post_run(api: str, stl: Path, config: dict) -> str:
    boundary = "wtvalidation"
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"config\"\r\n\r\n"
            f"{json.dumps(config)}\r\n--{boundary}\r\nContent-Disposition: form-data; "
            f"name=\"stl\"; filename=\"{stl.name}\"\r\nContent-Type: model/stl\r\n\r\n"
            ).encode() + stl.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(f"{api}/runs", data=body, headers={
        "Content-Type": f"multipart/form-data; boundary={boundary}"})
    return json.load(urllib.request.urlopen(req))["id"]


def find_existing(api: str, name: str) -> str | None:
    """Reattach to a sweep already submitted under this name (the backend
    keeps refining on its own if this script stops)."""
    for r in get(api, "/runs"):
        if r["name"] == f"{name} @ coarse mesh" and r["status"] != "cancelled":
            return r["id"]
    return None


def get(api: str, path: str) -> dict:
    return json.load(urllib.request.urlopen(f"{api}{path}"))


def wait_for_group(api: str, first_id: str) -> dict:
    group_id = get(api, f"/runs/{first_id}")["group_id"]
    last = None
    while True:
        group = get(api, f"/groups/{group_id}")
        mesh = group.get("mesh") or {}
        line = " | ".join(f"{m.get('quality')}:{m['status']}" for m in group["runs"])
        if line != last:
            print(time.strftime("%H:%M:%S"), line, flush=True)
            last = line
        if mesh.get("status"):
            return group
        time.sleep(30)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://127.0.0.1:8000/api")
    ap.add_argument("--only", help="run just this case name")
    args = ap.parse_args()

    out_path = HERE / "results.json"
    results = json.loads(out_path.read_text()) if out_path.exists() else {}
    for case in CASES:
        if args.only and case["name"] != args.only:
            continue
        print(f"== {case['name']}", flush=True)
        first = find_existing(args.api, case["config"]["name"]) or post_run(
            args.api, HERE / case["stl"], case["config"])
        group = wait_for_group(args.api, first)
        members = []
        for m in group["runs"]:
            detail = get(args.api, f"/runs/{m['id']}")
            res = detail.get("result") or {}
            members.append({
                "id": m["id"], "quality": m.get("quality"), "status": m["status"],
                "mesh_cells": detail.get("mesh_cells"), "cd": res.get("cd"),
                "cl": res.get("cl"), "drag_N": res.get("drag_N"),
                "converged": res.get("converged"), "iterations": res.get("iterations"),
                "reynolds": res.get("reynolds"), "runtime_s": res.get("runtime_s"),
                "frontal_area_m2": res.get("frontal_area_m2"),
                "cd_pressure": res.get("cd_pressure"), "cd_viscous": res.get("cd_viscous"),
                "error": detail.get("error"),
            })
        results[case["name"]] = {"config": case["config"], "reference": case["reference"],
                                 "mesh": group["mesh"], "members": members}
        out_path.write_text(json.dumps(results, indent=1))
        print(json.dumps(results[case["name"]]["mesh"], indent=1), flush=True)


if __name__ == "__main__":
    main()
