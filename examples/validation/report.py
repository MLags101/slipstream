"""Print the Markdown results tables for VALIDATION.md from results.json.

    backend/.venv/bin/python examples/validation/report.py
"""
from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).parent
TITLES = {
    "sphere": "Sphere, Re = 1×10⁵ (100 mm at 15 m/s)",
    "sphere_transcritical": "Sphere, Re = 4×10⁶ (1 m at 60 m/s)",
    "ahmed_25": "Ahmed body, 25° slant, 60 m/s",
}


def fmt_cells(n: int | None) -> str:
    return f"{n / 1e6:.2f}M" if n else "—"


def case_table(name: str, case: dict) -> str:
    ref = case["reference"]["cd"]
    mesh = case["mesh"] or {}
    lines = [f"### {TITLES.get(name, name)}", "",
             "| Mesh | Cells | Cd | vs. measured | Change from previous mesh | Pressure drag | Converged | Solve time |",
             "|---|---|---|---|---|---|---|---|"]
    prev = None
    for m in case["members"]:
        cd = m.get("cd")
        if cd is None:
            lines.append(f"| {m['quality']} | {fmt_cells(m.get('mesh_cells'))} | — | — | — | — | "
                         f"{m['status']} | — |")
            continue
        vs = f"{(cd - ref) / ref * 100:+.0f}%"
        change = "—" if prev is None else f"{abs(cd - prev) / abs(cd) * 100:.1f}%"
        runtime = f"{m['runtime_s'] / 60:.0f} min" if m.get("runtime_s") else "—"
        dp, dv = m.get("drag_pressure_N"), m.get("drag_viscous_N")
        share = f"{dp / (dp + dv) * 100:.0f}%" if dp is not None and dv and dp + dv else "—"
        lines.append(f"| {m['quality']} | {fmt_cells(m.get('mesh_cells'))} | {cd:.3f} | {vs} | "
                     f"{change} | {share} | {'yes' if m.get('converged') else 'no'} | {runtime} |")
        prev = cd
    verdict = {
        "independent": f"mesh independent at **{mesh.get('independent_at')}** "
                       f"(≤ {mesh.get('tol_pct', 2):g}% change on refinement)",
        "not_independent": f"**not** mesh independent by fine (> {mesh.get('tol_pct', 2):g}% change)",
        "failed": f"sweep failed: {mesh.get('error')}",
    }.get(mesh.get("status"), "still running")
    lines += ["", f"Measured Cd: **{ref}** ({case['reference']['source']}). Sweep: {verdict}.", ""]
    return "\n".join(lines)


def main() -> None:
    results = json.loads((HERE / "results.json").read_text())
    for name in ("sphere", "sphere_transcritical", "ahmed_25"):
        if name in results:
            print(case_table(name, results[name]))


if __name__ == "__main__":
    main()
