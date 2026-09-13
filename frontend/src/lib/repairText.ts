/** Human-readable text for STL health checks and model repair results. */
import type { RepairReport, StlInspection } from "../api";

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** Short length: 0.06, 0.4, 12, 250 — enough precision for a sanity check. */
export function formatSize(v: number): string {
  const a = Math.abs(v);
  if (a === 0) return "0";
  if (a >= 100) return v.toFixed(0);
  return String(+v.toPrecision(2));
}

/** What is wrong with a surface, or null when it is closed. */
export function inspectionProblem(ins: StlInspection): string | null {
  if (ins.watertight) return null;
  const parts: string[] = [];
  if (ins.open_edges > 0) {
    parts.push(`${ins.open_edges.toLocaleString("en-US")} open ${plural(ins.open_edges, "edge", "edges")}`);
  }
  if (ins.non_manifold_edges > 0) {
    parts.push(
      `${ins.non_manifold_edges.toLocaleString("en-US")} ${plural(ins.non_manifold_edges, "edge", "edges")} shared by 3+ faces`,
    );
  }
  return parts.length ? parts.join(", ") : "surface isn't closed";
}

/** One-line summary of a finished repair, lengths in the STL's unit. */
export function repairSummary(r: RepairReport, unit: string): string {
  const shift = `${r.shift_median > 0 ? "+" : ""}${formatSize(r.shift_median)}`;
  return [
    r.watertight ? "closed surface" : "surface still open",
    `${r.bodies} ${plural(r.bodies, "body", "bodies")}`,
    `${r.triangles_out.toLocaleString("en-US")} triangles`,
    `avg shift ${shift} ${unit}`,
    `max ${formatSize(r.deviation_max)} ${unit}`,
  ].join(" · ");
}
