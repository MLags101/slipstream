import type { RunResult } from "../api";
import {
  formatArea,
  formatCoeff,
  formatDuration,
  formatForce,
  formatInt,
} from "../lib/format";

/** Results summary once a run is done: hero Cd + stat grid. */
export function ResultsPanel({ result }: { result: RunResult }) {
  const stats: { label: string; value: string }[] = [
    { label: "Lift coefficient Cl", value: formatCoeff(result.cl) },
    { label: "Drag force", value: formatForce(result.drag_N) },
    { label: "Lift force", value: formatForce(result.lift_N) },
    { label: "Frontal area", value: formatArea(result.frontal_area_m2) },
    { label: "Mesh cells", value: formatInt(result.mesh_cells) },
    { label: "Runtime", value: formatDuration(result.runtime_s) },
    {
      label: "Cd std (last 20%)",
      value: `±${formatCoeff(result.cd_std_last20pct, 4)}`,
    },
    {
      label: "Conditions",
      value: `${result.wind_speed} m/s · ρ ${result.rho}`,
    },
  ];

  return (
    <section className="panel results-panel">
      <div className="panel-head">Results</div>
      <div className="results-body">
        <div className="hero-stat">
          <div className="hero-label">Drag coefficient</div>
          <div className="hero-value mono">{formatCoeff(result.cd)}</div>
          <div className="hero-sub">
            averaged over final 20% of {formatInt(result.iterations)} iterations
          </div>
        </div>
        <div className="stat-grid">
          {stats.map((s) => (
            <div key={s.label} className="stat-tile">
              <div className="stat-label">{s.label}</div>
              <div className="stat-value mono">{s.value}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
