/** Small client-side download + CSV helpers (no backend round-trip). */
import type { RunResult, GroupMember } from "../api";

function triggerDownload(url: string, filename: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function downloadText(filename: string, text: string, mime = "text/csv"): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  triggerDownload(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadDataUrl(filename: string, dataUrl: string): void {
  triggerDownload(dataUrl, filename);
}

const num = (v: number | null | undefined, d = 4) =>
  v == null ? "" : Number(v).toFixed(d);

/**
 * Lift-to-drag ratio, or null when it would be meaningless (missing data, or
 * a Cd of zero). Exported for the sweep table, which shows the same column.
 */
export function liftToDrag(
  cl: number | null | undefined,
  cd: number | null | undefined,
): number | null {
  if (cl == null || cd == null || cd === 0) return null;
  return cl / cd;
}

/** A run's results as a two-column key,value CSV. */
export function resultToCsv(name: string, r: RunResult): string {
  const rows: [string, string][] = [
    ["name", name],
    ["cd", num(r.cd)],
    ["cl", num(r.cl)],
    ["cs", num(r.cs)],
    ["drag_N", num(r.drag_N)],
    ["lift_N", num(r.lift_N)],
    ["side_N", num(r.side_N)],
    ["drag_pressure_N", num(r.drag_pressure_N)],
    ["drag_viscous_N", num(r.drag_viscous_N)],
    ["frontal_area_m2", num(r.frontal_area_m2, 6)],
    ["ref_area_m2", num(r.ref_area_m2, 6)],
    ["wind_speed_m_s", num(r.wind_speed, 2)],
    ["rho_kg_m3", num(r.rho, 3)],
    ["iterations", String(r.iterations)],
    ["mesh_cells", String(r.mesh_cells)],
    ["runtime_s", num(r.runtime_s, 1)],
    ["cd_std_last20pct", num(r.cd_std_last20pct)],
    ["stopped_early", String(r.stopped_early)],
  ];
  return rows.map(([k, v]) => `${k},${v}`).join("\n") + "\n";
}

/** A sweep group's members as an angle table CSV. */
export function sweepToCsv(
  param: string,
  members: (GroupMember & { angle?: number })[],
): string {
  const header = `${param}_deg,cd,cl,l_over_d,drag_N,lift_N`;
  const body = members
    .map((m) =>
      [
        m.angle ?? m.yaw_deg,
        num(m.cd),
        num(m.cl),
        num(liftToDrag(m.cl, m.cd)),
        num(m.drag_N),
        num(m.lift_N),
      ].join(","),
    )
    .join("\n");
  return `${header}\n${body}\n`;
}

export function slugify(s: string): string {
  return s.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "run";
}
