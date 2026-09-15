import { useState } from "react";
import { api, type RunDetail } from "../api";

interface Props {
  run: RunDetail;
  onCreated: (id: string) => void;
  onClose: () => void;
}

/**
 * Re-solve on the run's existing mesh: only wind speed and prop thrust can
 * change, so meshing is skipped and the new run goes straight to the solver.
 */
export function ResolvePanel({ run, onCreated, onClose }: Props) {
  const props = run.config.props ?? [];
  const [windSpeed, setWindSpeed] = useState(String(run.config.wind_speed));
  const [thrust, setThrust] = useState(props.length ? String(props[0].thrust_g) : "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mixedThrust = props.some((p) => p.thrust_g !== props[0].thrust_g);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const ws = parseFloat(windSpeed);
    if (!Number.isFinite(ws) || ws <= 0 || ws >= 200) {
      setError("Wind speed must be between 0 and 200 m/s");
      return;
    }
    let thrustG: number | undefined;
    if (props.length) {
      thrustG = parseFloat(thrust);
      if (!Number.isFinite(thrustG) || thrustG < 0) {
        setError("Thrust must be a number ≥ 0 (grams per prop)");
        return;
      }
    }
    setSubmitting(true);
    setError(null);
    try {
      const { id } = await api.resolveRun(run.id, {
        wind_speed: ws,
        ...(thrustG !== undefined ? { thrust_g: thrustG } : {}),
      });
      onCreated(id);
    } catch (err) {
      setError(`Failed to start re-solve: ${(err as Error).message}`);
      setSubmitting(false);
    }
  };

  return (
    <form className="panel resolve-panel" onSubmit={submit}>
      <div className="panel-head">Re-solve on this mesh</div>
      <div className="resolve-body">
        <div className="resolve-fields">
          <label className="field">
            <span className="field-label">Wind speed (m/s)</span>
            <input
              type="number"
              className="mono"
              value={windSpeed}
              min={0}
              step="any"
              onChange={(e) => setWindSpeed(e.target.value)}
            />
          </label>
          {props.length > 0 && (
            <label className="field">
              <span className="field-label">Thrust per prop (g)</span>
              <input
                type="number"
                className="mono"
                value={thrust}
                min={0}
                step="any"
                onChange={(e) => setThrust(e.target.value)}
              />
            </label>
          )}
        </div>
        <div className="config-note">
          Skips meshing and reuses this run's {run.mesh_cells?.toLocaleString("en-US")}{" "}
          cells, so it starts solving right away. Attitude, mesh quality and
          refinement stay the same.
          {mixedThrust && " The thrust you enter applies to every prop."}
          {run.config.refinement?.prop_slipstream &&
            " The slipstream zones stay aimed for the original speed and thrust."}
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="resolve-actions">
          <button type="submit" className="btn btn-primary btn-sm" disabled={submitting}>
            {submitting ? "Starting…" : "Start re-solve"}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </form>
  );
}
