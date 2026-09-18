import type { RunResult } from "../api";
import {
  formatArea,
  formatCoeff,
  formatDuration,
  formatForce,
  formatInt,
  formatSpeed,
} from "../lib/format";
import { downloadText, resultToCsv, slugify } from "../lib/download";
import { layerCoverageWarning, yPlusRows, yPlusText } from "../lib/layers";

// Split-bar segment colors (match the chart palette).
const C_PRESSURE = "#3987e5";
const C_VISCOUS = "#199e70";

/** Results summary once a run is done: hero Cd + stat grid. */
export function ResultsPanel({ result, name }: { result: RunResult; name: string }) {
  // Reference area differs from frontal only when the user overrode it.
  const refDiffers =
    result.ref_area_m2 != null &&
    Math.abs(result.ref_area_m2 - result.frontal_area_m2) > 1e-9;

  const mach = result.mach ?? result.wind_speed / 340.3;
  const flowModel = result.flow_model ?? "incompressible";

  const stats: { label: string; value: string }[] = [
    { label: "Lift coefficient Cl", value: formatCoeff(result.cl) },
    { label: "Drag force", value: formatForce(result.drag_N) },
    { label: "Lift force", value: formatForce(result.lift_N) },
    { label: "Frontal area", value: formatArea(result.frontal_area_m2) },
    ...(refDiffers
      ? [{ label: "Reference area", value: formatArea(result.ref_area_m2!) }]
      : []),
    ...(result.reynolds
      ? [
          {
            label: "Reynolds number",
            value:
              result.reynolds >= 1e6
                ? `${(result.reynolds / 1e6).toFixed(2)}M`
                : formatInt(Math.round(result.reynolds)),
          },
        ]
      : []),
    ...(result.flow_model && result.flow_model !== "incompressible"
      ? [{ label: "Mach number", value: mach.toFixed(2) }]
      : []),
    { label: "Mesh cells", value: formatInt(result.mesh_cells) },
    // One row per wall patch, model first. Absent on runs solved before y+
    // was measured, which is most older runs.
    ...yPlusRows(result).map((r) => ({
      label: `y+ ${r.patch} (avg)`,
      value: `${r.average.toFixed(r.average < 30 ? 1 : 0)} (${r.min.toFixed(
        1,
      )}–${r.max.toFixed(0)})`,
    })),
    { label: "Runtime", value: formatDuration(result.runtime_s) },
    {
      label: "Cd std (last 20%)",
      value: `±${formatCoeff(result.cd_std_last20pct, 4)}`,
    },
    {
      label: "Conditions",
      value: `${formatSpeed(result.wind_speed)} · ρ ${result.rho}`,
    },
  ];

  const exportCsv = () =>
    downloadText(`${slugify(name)}_results.csv`, resultToCsv(name, result));
  const copyCsv = () =>
    void navigator.clipboard?.writeText(resultToCsv(name, result));

  // Advisories that affect how much to trust the numbers.
  const warnings: string[] = [];
  // Compressibility only matters when an INCOMPRESSIBLE solver is being used
  // outside its range. Saying it about a compressible run is simply wrong, and
  // that is what this warning used to do.
  if (flowModel === "incompressible" && mach > 0.3)
    warnings.push(
      `At ${formatSpeed(result.wind_speed)} the flow is compressible (Mach ` +
        `${mach.toFixed(2)}), and this run used the incompressible solver, ` +
        "which ignores density changes — treat the numbers as indicative. " +
        "Re-run with a compressible flow model for a result you can rely on.",
    );
  if (flowModel === "transonic" && mach > 1.2)
    warnings.push(
      `Mach ${mach.toFixed(2)} is past what the steady transonic solver ` +
        "handles well; strong shocks need the supersonic (density-based) " +
        "model to stay sharp.",
    );
  const mq = result.mesh_quality;
  if (mq?.rating === "poor")
    warnings.push(
      "Mesh quality is poor (high skewness / non-orthogonality) — results may be unreliable. A finer quality setting usually helps.",
    );
  // The backend's own verdict wins when present; it decides against the same
  // number that gets averaged. Older runs fall back to the local estimate.
  const unconverged =
    result.converged === false ||
    (result.converged === undefined &&
      result.cd_std_last20pct > 0.02 * Math.max(Math.abs(result.cd), 0.1));
  if (unconverged)
    warnings.push(
      `Cd never settled — it varied by ±${formatCoeff(
        result.cd_std_last20pct,
        3,
      )} over the averaged window, so the value below is an average of a moving ` +
        "number, not a result. This usually means a broken or self-intersecting " +
        "STL rather than too coarse a mesh; repair the geometry into one watertight " +
        "solid and re-run.",
    );

  // y+ outside the wall-function band is the most common reason a result is
  // confidently wrong, so it belongs with the warnings rather than buried in
  // the stat grid. An in-band y+ needs no warning.
  if (result.y_plus_verdict === "low" || result.y_plus_verdict === "high") {
    const t = yPlusText(result);
    if (t) warnings.push(t);
  }
  // Layers that were requested but didn't grow. Worth saying even when y+
  // looks fine, because the average hides the patchiness.
  const coverage = layerCoverageWarning(result);
  if (coverage) warnings.push(coverage);

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
        {warnings.length > 0 && (
          <div className="result-warnings">
            {warnings.map((w, i) => (
              <div key={i} className="result-warning">
                ⚠ {w}
              </div>
            ))}
          </div>
        )}
        <div className={`hero-stat${unconverged ? " hero-stat-untrusted" : ""}`}>
          <div className="hero-label">
            Drag coefficient{unconverged && " — not converged"}
          </div>
          <div className="hero-value mono">{formatCoeff(result.cd)}</div>
          <div className="hero-sub">
            {result.transient
              ? `averaged over the final 20% of ${
                  result.end_time_s?.toPrecision(3) ?? "?"
                } s (${formatInt(result.iterations)} time steps)`
              : `averaged over final 20% of ${formatInt(
                  result.iterations,
                )} iterations`}
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
