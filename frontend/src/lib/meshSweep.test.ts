import { describe, expect, it } from "vitest";
import type { MeshSweepSummary } from "../api";
import { formatPct, meshSweepHeadline } from "./meshSweep";

const step = (quality: "coarse" | "medium" | "fine", cd: number, change_pct: number | null, converged = true) => ({
  quality, cd, change_pct, converged, mesh_cells: 1e6, drag_N: 1,
});

describe("meshSweepHeadline", () => {
  it("shows progress while refining", () => {
    expect(meshSweepHeadline({ status: null, steps: 2, tol_pct: 2 }, 2)).toBe(
      "refining… medium mesh (step 2 of up to 3, stops when Cd changes ≤ 2.0%)",
    );
    expect(meshSweepHeadline(undefined, 1)).toMatch(/^refining… coarse mesh/);
  });

  it("names the mesh that was good enough", () => {
    const s: MeshSweepSummary = {
      status: "independent", independent_at: "medium", best_cd: 0.736, tol_pct: 2,
      history: [step("coarse", 0.779, null), step("medium", 0.74, 5.27), step("fine", 0.736, 0.543)],
    };
    expect(meshSweepHeadline(s, 3)).toBe(
      "MESH INDEPENDENT at medium: Cd 0.736 changed 0.5% on refinement (≤ 2.0%)",
    );
  });

  it("is honest when fine still moves, and flags unconverged runs", () => {
    const s: MeshSweepSummary = {
      status: "not_independent", best_cd: 0.9, tol_pct: 2,
      history: [step("coarse", 0.7, null), step("medium", 0.8, 12.5), step("fine", 0.9, 11.1, false)],
    };
    expect(meshSweepHeadline(s, 3)).toBe(
      "NOT MESH INDEPENDENT by fine: Cd 0.900 still changed 11.1% (> 2.0%) — trust trends over the exact value · some runs didn't fully converge",
    );
  });

  it("reports failures", () => {
    expect(meshSweepHeadline({ status: "failed", error: "medium run error: boom" }, 2)).toBe(
      "MESH SWEEP FAILED — medium run error: boom",
    );
  });
});

describe("formatPct", () => {
  it("formats small, normal and missing values", () => {
    expect(formatPct(1.342)).toBe("1.3%");
    expect(formatPct(0.04)).toBe("0.04%");
    expect(formatPct(null)).toBe("—");
    expect(formatPct(Infinity)).toBe("∞%");
  });
});
