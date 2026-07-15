import type { RunResult } from "../api";
import {
  formatArea,
  formatCoeff,
  formatDuration,
  formatForce,
  formatInt,
} from "../lib/format";
import { downloadText, resultToCsv, slugify } from "../lib/download";

// Split-bar segment colors (match the chart palette).
const C_PRESSURE = "#3987e5";
const C_VISCOUS = "#199e70";

/** Results summary once a run is done: hero Cd + stat grid. */
export function ResultsPanel({ result, name }: { result: RunResult; name: string }) {
  // Reference area differs from frontal only when the user overrode it.
  const refDiffers =
    result.ref_area_m2 != null &&
    Math.abs(result.ref_area_m2 - result.frontal_area_m2) > 1e-9;

  const stats: { label: string; value: string }[] = [
    { label: "Lift coefficient Cl", value: formatCoeff(result.cl) },
    { label: "Drag force", value: formatForce(result.drag_N) },
    { label: "Lift force", value: formatForce(result.lift_N) },
    { label: "Frontal area", value: formatArea(result.frontal_area_m2) },
    ...(refDiffers
      ? [{ label: "Reference area", value: formatArea(result.ref_area_m2!) }]
      : []),
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

  const exportCsv = () =>
    downloadText(`${slugify(name)}_results.csv`, resultToCsv(name, result));
  const copyCsv = () =>
    void navigator.clipboard?.writeText(resultToCsv(name, result));

  // v2 drag breakdown — null (or absent) for runs solved before the feature.
  const dragP = result.drag_pressure_N;
  const dragV = result.drag_viscous_N;
  const hasSplit = dragP != null && dragV != null && dragP + dragV > 0;
  const pctP = hasSplit ? (dragP / (dragP + dragV)) * 100 : 0;

  return (
    <section className="panel results-panel">
      <div className="panel-head results-head">
        <span>Results</span>
        <div className="results-export">
          <button className="seg" onClick={copyCsv} title="Copy results as CSV">
            copy
          </button>
          <button className="seg" onClick={exportCsv} title="Download results CSV">
            export csv
          </button>
        </div>
      </div>
      <div className="results-body">
        <div className="hero-stat">
          <div className="hero-label">Drag coefficient</div>
          <div className="hero-value mono">{formatCoeff(result.cd)}</div>
          <div className="hero-sub">
            averaged over final 20% of {formatInt(result.iterations)} iterations
            {result.stopped_early && (
              <span className="converged-note"> · stopped early (converged)</span>
            )}
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
        {hasSplit && (
          <div className="drag-split">
            <div className="stat-label">Drag breakdown — pressure vs viscous</div>
            <div
              className="drag-split-bar"
              title={`pressure ${formatForce(dragP)} / viscous ${formatForce(dragV)}`}
            >
              <div
                className="drag-split-pressure"
                style={{ width: `${pctP}%` }}
              />
              <div className="drag-split-viscous" />
            </div>
            <div className="drag-split-legend">
              <span className="legend-item">
                <span className="legend-swatch" style={{ background: C_PRESSURE }} />
                pressure <span className="mono">{formatForce(dragP)}</span> ·{" "}
                {pctP.toFixed(0)}%
              </span>
              <span className="legend-item">
                <span className="legend-swatch" style={{ background: C_VISCOUS }} />
                viscous <span className="mono">{formatForce(dragV)}</span> ·{" "}
                {(100 - pctP).toFixed(0)}%
              </span>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
