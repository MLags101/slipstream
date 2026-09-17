import { useState } from "react";
import {
  api,
  type MeshInspection,
  type MeshRole,
  type Quality,
} from "../api";
import { formatInt } from "../lib/format";

interface Props {
  onCreated: (id: string) => void;
  onBack: () => void;
}

const ROLE_LABELS: Record<MeshRole, string> = {
  inlet: "inlet (wind comes in)",
  outlet: "outlet",
  model: "model (forces measured)",
  slip: "tunnel wall (slip)",
  wall: "wall (no-slip, e.g. floor)",
  symmetry: "symmetry plane",
};

const ITERATIONS: Record<Quality, string> = {
  coarse: "250 iterations",
  medium: "500 iterations",
  fine: "800 iterations",
};

/**
 * Solve on a mesh you built yourself: upload, inspect (convert + checkMesh +
 * patch list), assign a role to each patch, run.
 */
export function MeshImportView({ onCreated, onBack }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [unit, setUnit] = useState("m");
  const [inspecting, setInspecting] = useState(false);
  const [info, setInfo] = useState<MeshInspection | null>(null);
  const [roles, setRoles] = useState<Record<string, MeshRole>>({});
  const [name, setName] = useState("");
  const [windSpeed, setWindSpeed] = useState("15");
  const [quality, setQuality] = useState<Quality>("medium");
  const [refArea, setRefArea] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const inspect = async () => {
    if (!file) return;
    setInspecting(true);
    setError(null);
    setInfo(null);
    try {
      const result = await api.inspectMesh(file, unit);
      setInfo(result);
      setRoles(result.suggested_roles);
      setName(file.name.replace(/\.[^.]+$/, ""));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setInspecting(false);
    }
  };

  const counts = Object.values(roles).reduce<Record<string, number>>((acc, r) => {
    acc[r] = (acc[r] ?? 0) + 1;
    return acc;
  }, {});
  const missing = (["inlet", "outlet", "model"] as MeshRole[]).filter((r) => !counts[r]);

  const run = async () => {
    if (!info) return;
    const ws = parseFloat(windSpeed);
    if (!Number.isFinite(ws) || ws <= 0 || ws >= 200) {
      setError("Wind speed must be between 0 and 200 m/s");
      return;
    }
    let ref: number | undefined;
    if (refArea.trim() !== "") {
      ref = parseFloat(refArea);
      if (!Number.isFinite(ref) || ref <= 0) {
        setError("Reference area must be a positive number (cm²)");
        return;
      }
    }
    setSubmitting(true);
    setError(null);
    try {
      const { id } = await api.importRun({
        import_id: info.id,
        roles,
        wind_speed: ws,
        quality,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(ref ? { ref_area_cm2: ref } : {}),
      });
      onCreated(id);
    } catch (err) {
      setError(`Failed to start run: ${(err as Error).message}`);
      setSubmitting(false);
    }
  };

  return (
    <div className="mesh-import">
      <header className="mesh-import-head">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onBack}>
          ← back to STL setup
        </button>
        <h1>Import a mesh</h1>
        <p className="config-note">
          Skip Slipstream's meshing and solve on your own volume mesh: a Gmsh
          .msh (version 2 ASCII), an ASCII Fluent .msh or .cas, or a .zip of an
          OpenFOAM constant/polyMesh folder. The wind blows along +X, so the
          inlet must be at the low-x end.
        </p>
      </header>

      <section className="panel">
        <div className="panel-head">1 · Mesh file</div>
        <div className="mesh-import-body">
          <div className="mesh-import-row">
            <label className="field">
              <span className="field-label">File</span>
              <input
                type="file"
                accept=".msh,.cas,.zip"
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  setInfo(null);
                }}
              />
            </label>
            <label className="field">
              <span className="field-label">Mesh units</span>
              <select value={unit} onChange={(e) => setUnit(e.target.value)}>
                <option value="m">meters (m)</option>
                <option value="mm">millimeters (mm)</option>
                <option value="cm">centimeters (cm)</option>
                <option value="in">inches (in)</option>
              </select>
            </label>
          </div>
          <div>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!file || inspecting}
              onClick={() => void inspect()}
            >
              {inspecting ? "Converting and checking…" : "Inspect mesh"}
            </button>
          </div>
        </div>
      </section>

      {info && (
        <section className="panel">
          <div className="panel-head">2 · Patches</div>
          <div className="mesh-import-body">
            <div className="mono config-note">
              {info.format} · {formatInt(info.cells)} cells ·{" "}
              {info.mesh_ok
                ? "checkMesh OK"
                : `checkMesh reported ${info.failed_checks} failed check${
                    info.failed_checks === 1 ? "" : "s"
                  } (it may still solve)`}
              {info.bounds_m &&
                ` · domain x ${info.bounds_m[0][0].toFixed(3)} to ${info.bounds_m[1][0].toFixed(3)} m`}
            </div>
            <div className="mesh-import-table">
              <table>
                <thead>
                  <tr>
                    <th>Patch</th>
                    <th>Faces</th>
                    <th>Center x (m)</th>
                    <th>Role</th>
                  </tr>
                </thead>
                <tbody>
                  {info.patches.map((p) => (
                    <tr key={p.name}>
                      <td className="mono">{p.name}</td>
                      <td className="mono">{formatInt(p.faces)}</td>
                      <td className="mono">
                        {p.center_m ? p.center_m[0].toFixed(3) : "—"}
                      </td>
                      <td>
                        <select
                          aria-label={`Role for ${p.name}`}
                          value={roles[p.name]}
                          onChange={(e) =>
                            setRoles((r) => ({ ...r, [p.name]: e.target.value as MeshRole }))
                          }
                        >
                          {(Object.keys(ROLE_LABELS) as MeshRole[]).map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABELS[r]}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {missing.length > 0 && (
              <div className="form-error">
                Give at least one patch each of these roles: {missing.join(", ")}
              </div>
            )}
          </div>
        </section>
      )}

      {info && (
        <section className="panel">
          <div className="panel-head">3 · Conditions</div>
          <div className="mesh-import-body">
            <div className="mesh-import-row">
              <label className="field">
                <span className="field-label">Run name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} />
              </label>
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
              <label className="field">
                <span className="field-label">Solver budget</span>
                <select
                  value={quality}
                  onChange={(e) => setQuality(e.target.value as Quality)}
                >
                  {(Object.keys(ITERATIONS) as Quality[]).map((q) => (
                    <option key={q} value={q}>
                      {ITERATIONS[q]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="field-label">Reference area (cm²) — optional</span>
                <input
                  type="number"
                  className="mono"
                  value={refArea}
                  min={0}
                  step="any"
                  placeholder="auto (frontal area)"
                  onChange={(e) => setRefArea(e.target.value)}
                />
              </label>
            </div>
            <div>
              <button
                type="button"
                className="btn btn-primary"
                disabled={submitting || missing.length > 0}
                onClick={() => void run()}
              >
                {submitting ? "Starting…" : "Run on this mesh"}
              </button>
            </div>
          </div>
        </section>
      )}

      {error && <div className="form-error mesh-import-error">{error}</div>}
    </div>
  );
}
