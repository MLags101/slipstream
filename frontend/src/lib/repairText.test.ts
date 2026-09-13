import { describe, expect, it } from "vitest";
import type { RepairReport, StlInspection } from "../api";
import { formatSize, inspectionProblem, repairSummary } from "./repairText";

const ins = (o: Partial<StlInspection>): StlInspection => ({
  triangles: 73339,
  watertight: false,
  open_edges: 0,
  non_manifold_edges: 0,
  bodies: 1,
  ...o,
});

describe("inspectionProblem", () => {
  it("is null for a closed surface", () => {
    expect(inspectionProblem(ins({ watertight: true }))).toBeNull();
  });

  it("names open and shared edges with counts", () => {
    expect(inspectionProblem(ins({ open_edges: 131, non_manifold_edges: 1569 }))).toBe(
      "131 open edges, 1,569 edges shared by 3+ faces",
    );
    expect(inspectionProblem(ins({ open_edges: 1 }))).toBe("1 open edge");
  });

  it("still explains a non-closed surface with no edge counts", () => {
    expect(inspectionProblem(ins({}))).toBe("surface isn't closed");
  });
});

describe("repairSummary", () => {
  const report: RepairReport = {
    pitch: 0.249,
    triangles_in: 73339,
    triangles_out: 400000,
    open_edges_in: 131,
    non_manifold_edges_in: 1569,
    watertight: true,
    bodies: 1,
    decimator: "pymeshlab",
    alignment_shift: [0, 0, 0.08],
    shift_median: 0.061,
    deviation_p95: 0.26,
    deviation_max: 0.404,
    runtime_s: 58.2,
  };

  it("summarizes the repaired surface in the model's unit", () => {
    expect(repairSummary(report, "mm")).toBe(
      "closed surface · 1 body · 400,000 triangles · avg shift +0.061 mm · max 0.4 mm",
    );
  });

  it("does not hide a failure to close", () => {
    expect(repairSummary({ ...report, watertight: false, bodies: 3 }, "in")).toMatch(
      /^surface still open · 3 bodies/,
    );
  });
});

describe("formatSize", () => {
  it("keeps small values readable", () => {
    expect(formatSize(0)).toBe("0");
    expect(formatSize(-0.0856)).toBe("-0.086");
    expect(formatSize(12.34)).toBe("12");
    expect(formatSize(250.4)).toBe("250");
  });
});
