import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { api, type Quality, type RunConfig, type StlUnit } from "../api";
import { createViewer, buildSceneHelpers, type Viewer } from "../viewer/scene";
import { nameFromFilename, formatInt } from "../lib/format";

interface Props {
  onCreated: (id: string) => void;
}

const QUALITY_HINTS: Record<Quality, string> = {
  coarse: "~2–4 min",
  medium: "~8–15 min",
  fine: "~30+ min",
};

export function NewRunView({ onCreated }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [triangles, setTriangles] = useState<number | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  // Config form — explicit "configure, then Run". Number inputs, no sliders,
  // nothing here re-runs anything live.
  const [name, setName] = useState("");
  const [unit, setUnit] = useState<StlUnit>("mm");
  const [windSpeed, setWindSpeed] = useState("15");
  const [yawDeg, setYawDeg] = useState("0");
  const [sweepEnabled, setSweepEnabled] = useState(false);
  const [sweepAngles, setSweepAngles] = useState("0, 15, 30, 45");
  const [quality, setQuality] = useState<Quality>("medium");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const geometryRef = useRef<THREE.BufferGeometry | null>(null);

  // Viewer lifecycle — created once the preview host exists.
  useEffect(() => {
    if (!file) return;
    const host = canvasHostRef.current;
    if (!host) return;
    const viewer = createViewer(host);
    viewerRef.current = viewer;
    if (geometryRef.current) showGeometry(viewer, geometryRef.current);
    return () => {
      viewer.dispose();
      viewerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file !== null]);

  const showGeometry = (viewer: Viewer, geometry: THREE.BufferGeometry) => {
    geometry.computeBoundingSphere();
    const sphere = geometry.boundingSphere ?? new THREE.Sphere();
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({ color: 0x9fa8b3, roughness: 0.6, metalness: 0.15 }),
    );
    group.add(mesh);
    group.add(buildSceneHelpers(sphere.radius, sphere.center));
    viewer.setContent(group);
    viewer.frame(sphere.center, sphere.radius);
  };

  const acceptFile = useCallback(async (f: File) => {
    setParseError(null);
    if (!/\.stl$/i.test(f.name)) {
      setParseError(`"${f.name}" is not an .stl file`);
      return;
    }
    try {
      const buf = await f.arrayBuffer();
      const geometry = new STLLoader().parse(buf);
      geometry.computeVertexNormals();
      geometryRef.current = geometry;
      setTriangles(geometry.getAttribute("position").count / 3);
      setFile(f);
      setName(nameFromFilename(f.name));
      setSubmitError(null);
      if (viewerRef.current) showGeometry(viewerRef.current, geometry);
    } catch (e) {
      setParseError(`Could not parse STL: ${(e as Error).message}`);
    }
  }, []);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void acceptFile(f);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file || submitting) return;
    const ws = parseFloat(windSpeed);
    if (!Number.isFinite(ws) || ws <= 0) {
      setSubmitError("Wind speed must be a positive number");
      return;
    }
    let yaw = 0;
    let yawSweep: number[] | undefined;
    if (sweepEnabled) {
      const angles = sweepAngles
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "")
        .map((s) => Number(s));
      if (
        angles.length < 2 ||
        angles.length > 8 ||
        angles.some((a) => !Number.isFinite(a))
      ) {
        setSubmitError(
          "Yaw sweep needs 2–8 comma-separated angles, e.g. 0, 15, 30, 45",
        );
        return;
      }
      yawSweep = angles;
    } else {
      yaw = parseFloat(yawDeg);
      if (!Number.isFinite(yaw)) {
        setSubmitError("Yaw must be a number");
        return;
      }
    }
    const config: RunConfig = {
      name: name.trim() || nameFromFilename(file.name),
      unit,
      wind_speed: ws,
      // Ignored by the backend when yaw_sweep is present.
      yaw_deg: yaw,
      quality,
      ...(yawSweep ? { yaw_sweep: yawSweep } : {}),
    };
    setSubmitting(true);
    setSubmitError(null);
    try {
      // For sweeps the response `id` is the first member run.
      const { id } = await api.createRun(file, config);
      onCreated(id);
    } catch (err) {
      setSubmitError(
        err instanceof Error && err.name === "BackendUnreachableError"
          ? "Backend unreachable — is the server running on :8000?"
          : `Failed to start run: ${(err as Error).message}`,
      );
      setSubmitting(false);
    }
  };

  return (
    <div className="new-run">
      <div className="new-run-viewer">
        {file ? (
          <>
            <div className="viewer-canvas" ref={canvasHostRef} />
            <div className="viewer-overlay-info mono">
              {file.name}
              {triangles !== null && ` · ${formatInt(triangles)} tris`}
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setFile(null);
                  setTriangles(null);
                  geometryRef.current = null;
                }}
              >
                replace
              </button>
            </div>
            <div className="viewer-hint">wind flows along +X (blue arrows)</div>
          </>
        ) : (
          <div
            className={`dropzone${dragOver ? " dropzone-over" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={() => fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === "Enter" && fileInputRef.current?.click()}
          >
            <div className="dropzone-glyph">▲</div>
            <div className="dropzone-title">Drop an STL here</div>
            <div className="dropzone-sub">or click to browse</div>
            {parseError && <div className="form-error">{parseError}</div>}
            <input
              ref={fileInputRef}
              type="file"
              accept=".stl"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void acceptFile(f);
                e.target.value = "";
              }}
            />
          </div>
        )}
      </div>

      <form className="panel config-panel" onSubmit={submit}>
        <div className="panel-head">Analysis setup</div>
        <div className="config-fields">
          <label className="field">
            <span className="field-label">Run name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. quad frame v2"
              disabled={!file}
            />
          </label>
          <label className="field">
            <span className="field-label">STL unit</span>
            <select
              value={unit}
              onChange={(e) => setUnit(e.target.value as StlUnit)}
              disabled={!file}
            >
              <option value="mm">millimeters (mm)</option>
              <option value="cm">centimeters (cm)</option>
              <option value="m">meters (m)</option>
              <option value="in">inches (in)</option>
            </select>
          </label>
          <div className="field-row">
            <label className="field">
              <span className="field-label">Wind speed (m/s)</span>
              <input
                type="number"
                value={windSpeed}
                onChange={(e) => setWindSpeed(e.target.value)}
                min={0.1}
                step="any"
                disabled={!file}
              />
            </label>
            <label className="field">
              <span className="field-label">
                {sweepEnabled ? "Yaw angles (deg)" : "Yaw (deg)"}
              </span>
              {sweepEnabled ? (
                <input
                  type="text"
                  className="mono"
                  value={sweepAngles}
                  onChange={(e) => setSweepAngles(e.target.value)}
                  placeholder="0, 15, 30, 45"
                  spellCheck={false}
                  disabled={!file}
                  title="2–8 comma-separated yaw angles in degrees"
                />
              ) : (
                <input
                  type="number"
                  value={yawDeg}
                  onChange={(e) => setYawDeg(e.target.value)}
                  min={-180}
                  max={180}
                  step="any"
                  disabled={!file}
                />
              )}
            </label>
          </div>
          <label className="check-field">
            <input
              type="checkbox"
              checked={sweepEnabled}
              onChange={(e) => setSweepEnabled(e.target.checked)}
              disabled={!file}
            />
            <span>Yaw sweep — queue one run per angle</span>
          </label>
          <label className="field">
            <span className="field-label">Mesh quality</span>
            <select
              value={quality}
              onChange={(e) => setQuality(e.target.value as Quality)}
              disabled={!file}
            >
              {(Object.keys(QUALITY_HINTS) as Quality[]).map((q) => (
                <option key={q} value={q}>
                  {q} ({QUALITY_HINTS[q]})
                </option>
              ))}
            </select>
          </label>
        </div>
        {submitError && <div className="form-error">{submitError}</div>}
        <button
          type="submit"
          className="btn btn-primary btn-block btn-run"
          disabled={!file || submitting}
        >
          {submitting ? "Starting…" : sweepEnabled ? "Run yaw sweep" : "Run analysis"}
        </button>
        <div className="config-note">
          Runs execute one at a time — a new run queues behind any active one.
        </div>
      </form>
    </div>
  );
}
