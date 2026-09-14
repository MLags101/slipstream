/** Text for the mesh-independence sweep status strip. */
import type { MeshSweepSummary } from "../api";

const ORDER = ["coarse", "medium", "fine"] as const;

/** 1.34 -> "1.3%", 0.04 -> "0.04%", Infinity -> "∞%". */
export function formatPct(pct: number | null | undefined): string {
  if (pct === null || pct === undefined) return "—";
  if (!Number.isFinite(pct)) return "∞%";
  return pct < 0.1 ? `${+pct.toFixed(2)}%` : `${pct.toFixed(1)}%`;
}

/** One-line status: running, independent, not independent, or failed. */
export function meshSweepHeadline(s: MeshSweepSummary | undefined, members: number): string {
  const tol = s?.tol_pct ?? null;
  const tolText = tol !== null ? formatPct(tol) : "the tolerance";
  if (!s || s.status === null || s.status === undefined) {
    const step = Math.min(Math.max(members, 1), ORDER.length);
    return `refining… ${ORDER[step - 1]} mesh (step ${step} of up to 3, stops when Cd changes ≤ ${tolText})`;
  }
  const history = s.history ?? [];
  const last = history.length ? history[history.length - 1].change_pct : null;
  const unconverged = history.some((h) => h.converged === false)
    ? " · some runs didn't fully converge"
    : "";
  if (s.status === "failed") {
    return `MESH SWEEP FAILED — ${s.error ?? "a member run failed"}`;
  }
  const cd = s.best_cd !== null && s.best_cd !== undefined ? s.best_cd.toFixed(3) : "—";
  if (s.status === "independent") {
    return `MESH INDEPENDENT at ${s.independent_at}: Cd ${cd} changed ${formatPct(last)} on refinement (≤ ${tolText})${unconverged}`;
  }
  return `NOT MESH INDEPENDENT by fine: Cd ${cd} still changed ${formatPct(last)} (> ${tolText}) — trust trends over the exact value${unconverged}`;
}
