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
  const [pitchDeg, setPitchDeg] = useState("0");
  const [sweepEnabled, setSweepEnabled] = useState(false);
  const [sweepParam, setSweepParam] = useState<"yaw" | "pitch">("yaw");
  const [sweepAngles, setSweepAngles] = useState("0, 15, 30, 45");
  const [propsEnabled, setPropsEnabled] = useState(false);
  const [propRows, setPropRows] = useState<
    { x: string; y: string; z: string; d: string; t: string }[]
  >([{ x: "0", y: "0", z: "0", d: "127", t: "300" }]);
  const [trimEnabled, setTrimEnabled] = useState(false);
  const [trimWeight, setTrimWeight] = useState("650");
  // Trim solves pitch + per-prop thrust itself; only live with prop disks.
  const trimOn = propsEnabled && trimEnabled;
  const [quality, setQuality] = useState<Quality>("medium");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const geometryRef = useRef<THREE.BufferGeometry | null>(null);
  const stlCenterRef = useRef<THREE.Vector3>(new THREE.Vector3());
  const framedRef = useRef(false);

  // Viewer lifecycle — created once the preview host exists.
  useEffect(() => {
    if (!file) return;
    const host = canvasHostRef.current;
    if (!host) return;
    const viewer = createViewer(host);
    viewerRef.current = viewer;
    framedRef.current = false;
    return () => {
      viewer.dispose();
      viewerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file !== null]);

  // Live setup preview: the model (and its prop disks) rotate exactly as the
  // backend will prepare them — pitch about Y, then -yaw about Z — while the
  // wind arrows stay fixed along +X, like the real tunnel.
  const previewYaw =
    sweepEnabled && sweepParam === "yaw" ? 0 : parseFloat(yawDeg) || 0;
  const previewPitch =
    trimOn || (sweepEnabled && sweepParam === "pitch")
      ? 0
      : parseFloat(pitchDeg) || 0;

  useEffect(() => {
    const viewer = viewerRef.current;
    const geometry = geometryRef.current;
    if (!viewer || !geometry || !file) return;
    geometry.computeBoundingSphere();
    const sphere = geometry.boundingSphere ?? new THREE.Sphere();
    const r = Math.max(sphere.radius, 1e-6);

    const modelGroup = new THREE.Group();
    modelGroup.add(
      new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({
          color: 0x9fa8b3,
          roughness: 0.6,
          metalness: 0.15,
        }),
      ),
    );

    // Propeller disks, in the model frame so they rotate with it.
    if (propsEnabled) {
      const c = stlCenterRef.current;
      for (const row of propRows) {
        const [x, y, z, d] = [row.x, row.y, row.z, row.d].map((v) =>
          parseFloat(v),
        );
        if (![x, y, z, d].every(Number.isFinite) || d <= 0) continue;
        const disk = new THREE.Mesh(
          new THREE.CylinderGeometry(d / 2, d / 2, Math.max(d * 0.05, r * 0.008), 32),
          new THREE.MeshBasicMaterial({
            color: 0x35c5dd,
            transparent: true,
            opacity: 0.28,
            side: THREE.DoubleSide,
            depthWrite: false,
          }),
        );
        disk.rotation.x = Math.PI / 2; // cylinder axis Y -> model +Z
        disk.position.set(x - c.x, y - c.y, z - c.z);
        modelGroup.add(disk);
        const thrust = new THREE.ArrowHelper(
          new THREE.Vector3(0, 0, 1),
          disk.position,
          d * 0.45,
          0x35c5dd,
          d * 0.14,
          d * 0.07,
        );
        modelGroup.add(thrust);
      }
    }

    // Backend prep order: R = Rz(-yaw) · Ry(pitch). Euler "ZYX" composes
    // exactly Rz(z)·Ry(y)·Rx(x).
    modelGroup.rotation.order = "ZYX";
    modelGroup.rotation.y = THREE.MathUtils.degToRad(previewPitch);
    modelGroup.rotation.z = -THREE.MathUtils.degToRad(previewYaw);

    const group = new THREE.Group();
    group.add(modelGroup);
    group.add(buildSceneHelpers(r, new THREE.Vector3(0, 0, 0)));
    viewer.setContent(group);
    if (!framedRef.current) {
      viewer.frame(new THREE.Vector3(0, 0, 0), r);
      framedRef.current = true;
    }
  }, [file, propsEnabled, propRows, previewYaw, previewPitch]);

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
      geometry.computeBoundingBox();
      const c = geometry.boundingBox!.getCenter(new THREE.Vector3());
      geometry.translate(-c.x, -c.y, -c.z);
      stlCenterRef.current = c;
      framedRef.current = false;
      geometryRef.current = geometry;
      setTriangles(geometry.getAttribute("position").count / 3);
      setFile(f);
      setName(nameFromFilename(f.name));
      setSubmitError(null);
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
    let sweep: number[] | undefined;
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
          "A sweep needs 2–8 comma-separated angles, e.g. 0, 15, 30, 45",
        );
        return;
      }
      sweep = angles;
    }
    let trimCfg: RunConfig["trim"];
    if (trimOn) {
      const w = parseFloat(trimWeight);
      if (!Number.isFinite(w) || w <= 0) {
        setSubmitError("Craft weight must be a positive number of grams");
        return;
      }
      trimCfg = { weight_g: w };
    }
    const yawSwept = sweepEnabled && sweepParam === "yaw";
    const pitchSwept = sweepEnabled && sweepParam === "pitch";
    const yaw = yawSwept ? 0 : parseFloat(yawDeg);
    // The trim solver owns pitch; the value sent is ignored/overridden.
    const pitch = pitchSwept || trimOn ? 0 : parseFloat(pitchDeg);
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) {
      setSubmitError("Yaw and pitch must be numbers");
      return;
    }
    let props: RunConfig["props"];
    if (propsEnabled) {
      props = [];
      for (const r of propRows) {
        const vals = [r.x, r.y, r.z, r.d, r.t].map((v) => parseFloat(v));
        if (vals.some((v) => !Number.isFinite(v)) || vals[3] <= 0 || vals[4] < 0) {
          setSubmitError(
            "Each propeller needs finite X/Y/Z, a positive diameter and thrust ≥ 0",
          );
          return;
        }
        props.push({
          center: [vals[0], vals[1], vals[2]],
          diameter: vals[3],
          thrust_g: vals[4],
        });
      }
    }
    const config: RunConfig = {
      name: name.trim() || nameFromFilename(file.name),
      unit,
      wind_speed: ws,
      // The swept angle is ignored by the backend when its sweep is present.
      yaw_deg: yaw,
      pitch_deg: pitch,
      quality,
      ...(yawSwept ? { yaw_sweep: sweep } : {}),
      ...(pitchSwept ? { pitch_sweep: sweep } : {}),
      ...(props && props.length ? { props } : {}),
      ...(trimCfg ? { trim: trimCfg } : {}),
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
            <div className="dropzone-sub">
              or click to browse ·{" "}
              <button
                type="button"
                className="dropzone-sample"
                onClick={async (e) => {
                  e.stopPropagation();
                  const buf = await (await fetch("/quad_frame.stl")).blob();
                  void acceptFile(
                    new File([buf], "quad_frame.stl", {
                      type: "application/octet-stream",
                    }),
                  );
                }}
              >
                try the sample quad
              </button>
            </div>
            <div className="dropzone-steps">
              <span><i>1</i> drop your STL</span>
              <span><i>2</i> set wind speed &amp; quality</span>
              <span><i>3</i> run — get drag, lift &amp; flow</span>
            </div>
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
              <div className="chips">
                {[10, 15, 25, 40].map((v) => (
                  <button
                    key={v}
                    type="button"
                    className="chip"
                    disabled={!file}
                    onClick={() => setWindSpeed(String(v))}
                  >
                    {v}
                  </button>
                ))}
              </div>
            </label>
            <label className="field">
              <span className="field-label">
                {sweepEnabled && sweepParam === "yaw" ? "Yaw angles (deg)" : "Yaw (deg)"}
              </span>
              {sweepEnabled && sweepParam === "yaw" ? (
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
            <label className="field">
              <span className="field-label">
                {sweepEnabled && sweepParam === "pitch"
                  ? "Pitch angles (deg)"
                  : "Pitch (deg)"}
              </span>
              {sweepEnabled && sweepParam === "pitch" ? (
                <input
                  type="text"
                  className="mono"
                  value={sweepAngles}
                  onChange={(e) => setSweepAngles(e.target.value)}
                  placeholder="0, 15, 30, 45"
                  spellCheck={false}
                  disabled={!file}
                  title="2–8 comma-separated pitch angles in degrees"
                />
              ) : (
                <>
                  <input
                    type="number"
                    value={pitchDeg}
                    onChange={(e) => setPitchDeg(e.target.value)}
                    min={-90}
                    max={90}
                    step="any"
                    disabled={!file || trimOn}
                    title="positive pitch = nose-down forward-flight tilt"
                  />
                  {trimOn && <span className="config-note">solved by trim</span>}
                </>
              )}
            </label>
          </div>
          <label className="check-field">
            <input
              type="checkbox"
              checked={sweepEnabled}
              onChange={(e) => setSweepEnabled(e.target.checked)}
              disabled={!file || trimOn}
              title={trimOn ? "unavailable while solving trim" : undefined}
            />
            <span>Sweep — queue one run per angle of</span>
            <select
              className="sweep-param"
              value={sweepParam}
              onChange={(e) => setSweepParam(e.target.value as "yaw" | "pitch")}
              disabled={!file || !sweepEnabled}
            >
              <option value="yaw">yaw</option>
              <option value="pitch">pitch</option>
            </select>
          </label>
          <label className="check-field">
            <input
              type="checkbox"
              checked={propsEnabled}
              onChange={(e) => setPropsEnabled(e.target.checked)}
              disabled={!file}
            />
            <span>Propeller disks — powered flow</span>
          </label>
          {propsEnabled && (
            <div className="prop-editor">
              <div className="prop-row prop-row-head">
                <span>x</span><span>y</span><span>z</span>
                <span>ø</span><span>thrust g</span><span />
              </div>
              {propRows.map((r, i) => (
                <div className="prop-row" key={i}>
                  {(["x", "y", "z", "d", "t"] as const).map((k) => (
                    <input
                      key={k}
                      type="number"
                      step="any"
                      disabled={k === "t" && trimOn}
                      title={
                        k === "t" && trimOn ? "solved by trim" : undefined
                      }
                      value={r[k]}
                      onChange={(e) =>
                        setPropRows((rows) =>
                          rows.map((row, j) =>
                            j === i ? { ...row, [k]: e.target.value } : row,
                          ),
                        )
                      }
                    />
                  ))}
                  <button
                    type="button"
                    className="icon-btn"
                    title="remove propeller"
                    onClick={() =>
                      setPropRows((rows) => rows.filter((_, j) => j !== i))
                    }
                  >
                    ✕
                  </button>
                </div>
              ))}
              <div className="prop-editor-foot">
                <button
                  type="button"
                  className="chip"
                  disabled={propRows.length >= 8}
                  onClick={() =>
                    setPropRows((rows) => [
                      ...rows,
                      { x: "0", y: "0", z: "0", d: "127", t: "300" },
                    ])
                  }
                >
                  + add propeller
                </button>
                <span className="config-note">
                  positions/ø in STL units · thrust axis = model +Z
                  {trimOn && " · thrust solved by trim"}
                </span>
              </div>
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={trimEnabled}
                  onChange={(e) => {
                    setTrimEnabled(e.target.checked);
                    if (e.target.checked) setSweepEnabled(false);
                  }}
                />
                <span>Solve trim attitude</span>
              </label>
              {trimEnabled && (
                <label className="field">
                  <span className="field-label">Craft weight (g)</span>
                  <input
                    type="number"
                    className="mono"
                    value={trimWeight}
                    onChange={(e) => setTrimWeight(e.target.value)}
                    min={1}
                    step="any"
                  />
                  <span className="config-note">
                    iterates pitch + per-prop thrust until thrust balances
                    drag and weight
                  </span>
                </label>
              )}
            </div>
          )}
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
          {submitting
            ? "Starting…"
            : trimOn
              ? "Run trim solve"
              : sweepEnabled
                ? `Run ${sweepParam} sweep`
                : "Run analysis"}
        </button>
        <div className="config-note">
          Runs execute one at a time — a new run queues behind any active one.
        </div>
      </form>
    </div>
  );
}
