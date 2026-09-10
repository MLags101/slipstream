import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { api, type Quality, type RunConfig, type StlUnit } from "../api";
import { createViewer, buildSceneHelpers, type Viewer } from "../viewer/scene";
import { nameFromFilename, formatInt } from "../lib/format";
import { defaultPropPlacements } from "../lib/geometry";

/** Keep a nudged angle in (-180, 180] so the inputs stay readable. */
function wrapDeg(v: number): number {
  const w = ((((v + 180) % 360) + 360) % 360) - 180;
  return Math.round((w === -180 ? 180 : w) * 10) / 10;
}

/**
 * Functional updater for a nudge button. Must read the previous value from
 * setState rather than the render closure, or two quick clicks both apply to
 * the same stale angle and the second silently replaces the first.
 */
function nudgeDeg(delta: number): (prev: string) => string {
  return (prev) => String(wrapDeg((parseFloat(prev) || 0) + delta));
}

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
  const [dims, setDims] = useState<[number, number, number] | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  // Config form — explicit "configure, then Run". Number inputs, no sliders,
  // nothing here re-runs anything live.
  const [name, setName] = useState("");
  const [unit, setUnit] = useState<StlUnit>("mm");
  const [windSpeed, setWindSpeed] = useState("15");
  const [yawDeg, setYawDeg] = useState("0");
  const [pitchDeg, setPitchDeg] = useState("0");
  const [rollDeg, setRollDeg] = useState("0");
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
  const [refArea, setRefArea] = useState(""); // cm², blank = auto (frontal)
  const [groundPlane, setGroundPlane] = useState(false);
  const [symmetry, setSymmetry] = useState(false);
  const [quality, setQuality] = useState<Quality>("medium");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const geometryRef = useRef<THREE.BufferGeometry | null>(null);
  const stlCenterRef = useRef<THREE.Vector3>(new THREE.Vector3());
  const framedRef = useRef(false);
  const modelGroupRef = useRef<THREE.Group | null>(null);
  const modelMeshRef = useRef<THREE.Mesh | null>(null);
  const propGroupsRef = useRef<THREE.Group[]>([]);
  // Slicer-style selection: click the model to select it, then rotate it with
  // the explicit per-axis controls. Dragging never changes the attitude.
  const [selected, setSelected] = useState(false);
  // Latest values for the (once-attached) pointer handlers.
  const latestRef = useRef<{ propsEnabled: boolean }>({ propsEnabled: false });

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
  const previewRoll = parseFloat(rollDeg) || 0;

  // Half-model symmetry is only valid at 0° yaw and without props/trim/yaw-sweep
  // (pitch is fine — the mirror plane is Y=0). trimOn implies propsEnabled.
  const symmetryAllowed =
    parseFloat(yawDeg) === 0 &&
    previewRoll === 0 &&
    !propsEnabled &&
    !(sweepEnabled && sweepParam === "yaw");

  // Force the symmetry checkbox off whenever it becomes disallowed (nonzero
  // yaw typed, props/trim enabled, or a yaw sweep queued).
  useEffect(() => {
    if (!symmetryAllowed && symmetry) setSymmetry(false);
  }, [symmetryAllowed, symmetry]);

  latestRef.current = { propsEnabled };

  const yawLocked = sweepEnabled && sweepParam === "yaw";
  const pitchLocked = trimOn || (sweepEnabled && sweepParam === "pitch");

  // The three model axes, in the order the backend applies them. Roll is never
  // swept or solved, so it is always editable.
  const axisRows = [
    {
      axis: "X",
      name: "roll",
      value: rollDeg,
      set: setRollDeg,
      locked: false,
      lockNote: "",
      nudge: (d: number) => setRollDeg(nudgeDeg(d)),
    },
    {
      axis: "Y",
      name: "pitch",
      value: pitchDeg,
      set: setPitchDeg,
      locked: pitchLocked,
      lockNote: trimOn ? "solved by trim" : "swept",
      nudge: (d: number) => setPitchDeg(nudgeDeg(d)),
    },
    {
      axis: "Z",
      name: "yaw",
      value: yawDeg,
      set: setYawDeg,
      locked: yawLocked,
      lockNote: "swept",
      nudge: (d: number) => setYawDeg(nudgeDeg(d)),
    },
  ];

  // New rotor disks land on the frame's corners rather than stacked at its
  // centre; extra ones go to the next free slot of a wider layout.
  const seedPropRows = (count: number) => {
    const c = stlCenterRef.current;
    const size = dims ?? [1, 1, 1];
    const placements = defaultPropPlacements([c.x, c.y, c.z], size, count);

    // Drop each disk onto whatever is directly under it rather than onto the
    // bounding-box lid — on most frames the tallest thing is the battery or
    // camera in the middle, nowhere near where the rotors sit.
    const geo = geometryRef.current;
    const probe = geo ? new THREE.Mesh(geo) : null;
    const ray = new THREE.Raycaster();
    const down = new THREE.Vector3(0, 0, -1);
    const clearance = Math.abs(size[2]) * 0.02;
    const surfaceZ = (x: number, y: number): number | null => {
      if (!probe) return null;
      // Geometry is centred on the origin; prop coords are STL-absolute.
      ray.set(new THREE.Vector3(x - c.x, y - c.y, Math.abs(size[2])), down);
      const hit = ray.intersectObject(probe, false)[0];
      return hit ? hit.point.z + c.z : null;
    };

    return placements.map((p) => {
      const top = surfaceZ(p.x, p.y);
      const z = top === null ? p.z : Math.round((top + clearance) * 10) / 10;
      return {
        x: String(p.x),
        y: String(p.y),
        z: String(z),
        d: String(p.d),
        t: "300",
      };
    });
  };

  useEffect(() => {
    const viewer = viewerRef.current;
    const geometry = geometryRef.current;
    if (!viewer || !geometry || !file) return;
    geometry.computeBoundingSphere();
    const sphere = geometry.boundingSphere ?? new THREE.Sphere();
    const r = Math.max(sphere.radius, 1e-6);

    const propGroups: THREE.Group[] = [];
    const modelGroup = new THREE.Group();
    const modelMesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({
        color: 0x9fa8b3,
        roughness: 0.6,
        metalness: 0.15,
      }),
    );
    modelGroup.add(modelMesh);
    modelMeshRef.current = modelMesh;

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
        const holder = new THREE.Group();
        holder.add(disk);
        holder.add(
          new THREE.ArrowHelper(
            new THREE.Vector3(0, 0, 1),
            new THREE.Vector3(0, 0, 0),
            d * 0.45,
            0x35c5dd,
            d * 0.14,
            d * 0.07,
          ),
        );
        holder.position.set(x - c.x, y - c.y, z - c.z);
        holder.userData.rowIndex = propRows.indexOf(row);
        modelGroup.add(holder);
        propGroups.push(holder);
      }
    }
    propGroupsRef.current = propGroups;
    modelGroupRef.current = modelGroup;

    // Selection outline, inside the model group so it tilts with the model —
    // the same cue a slicer gives you for "this is the object you're editing".
    if (selected) {
      geometry.computeBoundingBox();
      const box = new THREE.Box3Helper(
        geometry.boundingBox!.clone(),
        new THREE.Color(0x35c5dd),
      );
      (box.material as THREE.LineBasicMaterial).depthTest = false;
      modelGroup.add(box);
    }

    // Backend prep order: R = Rz(-yaw) · Ry(pitch) · Rx(roll). Euler "ZYX"
    // composes exactly Rz(z)·Ry(y)·Rx(x).
    modelGroup.rotation.order = "ZYX";
    modelGroup.rotation.x = THREE.MathUtils.degToRad(previewRoll);
    modelGroup.rotation.y = THREE.MathUtils.degToRad(previewPitch);
    modelGroup.rotation.z = -THREE.MathUtils.degToRad(previewYaw);

    const group = new THREE.Group();
    group.add(modelGroup);
    group.add(buildSceneHelpers(r, new THREE.Vector3(0, 0, 0)));

    // Ground plane (road): a slab at the model's underside, drawn in world
    // space so it stays flat while the model can pitch/yaw above it.
    if (groundPlane) {
      geometry.computeBoundingBox();
      const zmin = geometry.boundingBox!.min.z; // model centered at origin
      const road = new THREE.Mesh(
        new THREE.PlaneGeometry(r * 5, r * 5),
        new THREE.MeshStandardMaterial({
          color: 0x2a2f36,
          roughness: 0.95,
          transparent: true,
          opacity: 0.85,
          side: THREE.DoubleSide,
        }),
      );
      road.position.z = zmin;
      group.add(road);
      const roadGrid = new THREE.GridHelper(r * 5, 20, 0x3987e5, 0x2e3238);
      roadGrid.rotation.x = Math.PI / 2;
      roadGrid.position.z = zmin + r * 0.002;
      group.add(roadGrid);
    }

    // Symmetry plane: the X-Z plane at Y=0 (normal along Y). Drawn in world
    // space — the backend solves only the +Y half, mirroring across this plane.
    if (symmetry) {
      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(r * 3, r * 3),
        new THREE.MeshStandardMaterial({
          color: 0x35c5dd,
          roughness: 0.9,
          transparent: true,
          opacity: 0.18,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      plane.rotation.x = Math.PI / 2; // XY plane -> X-Z plane, normal along Y
      group.add(plane);
    }

    viewer.setContent(group);
    if (!framedRef.current) {
      viewer.frame(new THREE.Vector3(0, 0, 0), r);
      framedRef.current = true;
    }
  }, [
    file,
    propsEnabled,
    propRows,
    previewYaw,
    previewPitch,
    previewRoll,
    groundPlane,
    symmetry,
    selected,
  ]);

  // Direct manipulation: drag a disk to slide it on its rotor plane (hold
  // Shift for height). The model itself is never rotated by dragging — click
  // it to select, then use the axis controls, like a 3D printer slicer.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !file) return;
    const el = viewer.renderer.domElement;
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let drag:
      | { kind: "disk"; holder: THREE.Group; plane: THREE.Plane; shift: boolean }
      | null = null;
    // A press that neither drags a disk nor moves far is a selection click.
    let press: { x: number; y: number; onModel: boolean } | null = null;

    const toNdc = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      ndc.set(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -((e.clientY - r.top) / r.height) * 2 + 1,
      );
    };

    const pickDisk = (e: PointerEvent): THREE.Group | null => {
      if (!latestRef.current.propsEnabled) return null;
      toNdc(e);
      ray.setFromCamera(ndc, viewer.camera);
      const hits = ray.intersectObjects(propGroupsRef.current, true);
      for (const h of hits) {
        let n: THREE.Object3D | null = h.object;
        while (n && n.userData.rowIndex === undefined) n = n.parent;
        if (n) return n as THREE.Group;
      }
      return null;
    };

    const overModel = (e: PointerEvent): boolean => {
      const mesh = modelMeshRef.current;
      if (!mesh) return false;
      toNdc(e);
      ray.setFromCamera(ndc, viewer.camera);
      return ray.intersectObject(mesh, false).length > 0;
    };

    const localZWorld = () => {
      const mg = modelGroupRef.current!;
      return new THREE.Vector3(0, 0, 1).applyQuaternion(mg.quaternion).normalize();
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const mg = modelGroupRef.current;
      if (!mg) return;
      const holder = pickDisk(e);
      if (!holder) {
        // Remember the press so pointerup can tell a click (select) from an
        // orbit drag. OrbitControls keeps handling the camera either way.
        press = { x: e.clientX, y: e.clientY, onModel: overModel(e) };
        return;
      }
      const zAxis = localZWorld();
      const wp = holder.getWorldPosition(new THREE.Vector3());
      let plane: THREE.Plane;
      if (e.shiftKey) {
        // Height drag: plane containing the local Z axis, facing the camera.
        const camDir = viewer.camera
          .getWorldDirection(new THREE.Vector3())
          .negate();
        const n = camDir.addScaledVector(zAxis, -camDir.dot(zAxis)).normalize();
        plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, wp);
      } else {
        plane = new THREE.Plane().setFromNormalAndCoplanarPoint(zAxis, wp);
      }
      drag = { kind: "disk", holder, plane, shift: e.shiftKey };
      viewer.controls.enabled = false;
      e.stopPropagation();
      try { el.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    };

    const onMove = (e: PointerEvent) => {
      if (!drag) {
        el.style.cursor = pickDisk(e) ? "grab" : overModel(e) ? "pointer" : "";
        return;
      }
      toNdc(e);
      ray.setFromCamera(ndc, viewer.camera);
      const hit = ray.ray.intersectPlane(drag.plane, new THREE.Vector3());
      if (!hit) return;
      const mg = modelGroupRef.current!;
      const local = mg.worldToLocal(hit.clone());
      const snap = (v: number) => Math.round(v * 2) / 2; // 0.5 units
      if (drag.shift) {
        drag.holder.position.z = snap(local.z);
      } else {
        drag.holder.position.x = snap(local.x);
        drag.holder.position.y = snap(local.y);
      }
    };

    const onUp = (e: PointerEvent) => {
      if (!drag) {
        // Click without meaningful movement: select the model, or deselect by
        // clicking empty space.
        if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 5) {
          setSelected(press.onModel);
        }
        press = null;
        return;
      }
      viewer.controls.enabled = true;
      try { el.releasePointerCapture(e.pointerId); } catch { /* synthetic */ }
      const c = stlCenterRef.current;
      const i = drag.holder.userData.rowIndex as number;
      const p = drag.holder.position;
      const fmt = (v: number) => String(Math.round(v * 10) / 10);
      setPropRows((rows) =>
        rows.map((row, j) =>
          j === i
            ? { ...row, x: fmt(p.x + c.x), y: fmt(p.y + c.y), z: fmt(p.z + c.z) }
            : row,
        ),
      );
      drag = null;
      press = null;
    };

    el.addEventListener("pointerdown", onDown, { capture: true });
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    return () => {
      el.removeEventListener("pointerdown", onDown, { capture: true });
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file !== null]);

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
      const size = geometry.boundingBox!.getSize(new THREE.Vector3());
      geometry.translate(-c.x, -c.y, -c.z);
      stlCenterRef.current = c;
      framedRef.current = false;
      geometryRef.current = geometry;
      setDims([size.x, size.y, size.z]);
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
    const roll = parseFloat(rollDeg || "0");
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch) || !Number.isFinite(roll)) {
      setSubmitError("Roll, pitch and yaw must be numbers");
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
    let refAreaCm2: number | undefined;
    if (refArea.trim() !== "") {
      const ra = parseFloat(refArea);
      if (!Number.isFinite(ra) || ra <= 0) {
        setSubmitError("Reference area must be a positive number (cm²)");
        return;
      }
      refAreaCm2 = ra;
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
      ...(refAreaCm2 ? { ref_area_cm2: refAreaCm2 } : {}),
      ...(roll ? { roll_deg: roll } : {}),
      ...(groundPlane ? { ground_plane: true } : {}),
      ...(symmetry ? { symmetry: true } : {}),
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
                  setDims(null);
                  setSelected(false);
                  geometryRef.current = null;
                }}
              >
                replace
              </button>
            </div>
            {dims && (
              <div className="viewer-dims mono" title="model bounding box in the selected unit — check this looks right">
                {dims.map((d) => (d < 100 ? d.toFixed(1) : Math.round(d)).toString()).join(" × ")} {unit}
              </div>
            )}
            <div className="viewer-hint">
              {selected
                ? "rotate with the axis controls \u00b7 click empty space to deselect"
                : propsEnabled
                  ? "click the model to rotate it \u00b7 drag disks to move (\u21e7 = height) \u00b7 wind flows along +X"
                  : "click the model to rotate it \u00b7 drag to orbit \u00b7 wind flows along +X"}
            </div>
            {selected && (
              <div className="rotate-panel">
                <div className="rotate-panel-head">
                  <span>Rotate</span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={axisRows.every((a) => a.locked)}
                    onClick={() => {
                      for (const a of axisRows) if (!a.locked) a.set("0");
                    }}
                  >
                    reset
                  </button>
                </div>
                {axisRows.map((a) => (
                  <div className="rotate-axis" key={a.axis}>
                    <span className={`axis-tag axis-${a.axis.toLowerCase()}`}>
                      {a.axis}
                    </span>
                    <span className="axis-name">{a.name}</span>
                    {a.locked ? (
                      <span className="config-note axis-locked">{a.lockNote}</span>
                    ) : (
                      <>
                        {[-90, -15].map((d) => (
                          <button
                            key={d}
                            type="button"
                            className="chip"
                            onClick={() => a.nudge(d)}
                          >
                            {d}&deg;
                          </button>
                        ))}
                        <input
                          type="number"
                          className="mono axis-input"
                          step="any"
                          value={a.value}
                          onChange={(e) => a.set(e.target.value)}
                          aria-label={`${a.name} degrees`}
                        />
                        {[15, 90].map((d) => (
                          <button
                            key={d}
                            type="button"
                            className="chip"
                            onClick={() => a.nudge(d)}
                          >
                            +{d}&deg;
                          </button>
                        ))}
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
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
              or click to browse · try a sample:{" "}
              {(
                [
                  ["quad", "/quad_frame.stl"],
                  ["car", "/sample_car.stl"],
                  ["wing", "/sample_wing.stl"],
                ] as [string, string][]
              ).map(([label, url], i) => (
                <span key={label}>
                  {i > 0 && " · "}
                  <button
                    type="button"
                    className="dropzone-sample"
                    onClick={async (e) => {
                      e.stopPropagation();
                      const buf = await (await fetch(url)).blob();
                      void acceptFile(
                        new File([buf], url.slice(1), {
                          type: "application/octet-stream",
                        }),
                      );
                    }}
                  >
                    {label}
                  </button>
                </span>
              ))}
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
                    min={-180}
                    max={180}
                    step="any"
                    disabled={!file || trimOn}
                    title="positive pitch = nose-down forward-flight tilt"
                  />
                  {trimOn && <span className="config-note">solved by trim</span>}
                </>
              )}
            </label>
            <label className="field">
              <span className="field-label">Roll (deg)</span>
              <input
                type="number"
                value={rollDeg}
                onChange={(e) => setRollDeg(e.target.value)}
                min={-180}
                max={180}
                step="any"
                disabled={!file}
                title="roll about the model's X axis, applied before pitch and yaw"
              />
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
              onChange={(e) => {
                setPropsEnabled(e.target.checked);
                // Seed a four-rotor layout on the frame the first time, so the
                // disks appear where rotors are instead of inside the model.
                if (e.target.checked) setPropRows(seedPropRows(4));
              }}
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
                      // Next free slot of a layout one rotor wider, so the new
                      // disk never lands on top of an existing one.
                      seedPropRows(rows.length + 1)[rows.length],
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
            <span className="field-label">
              Reference area (cm²) — optional
            </span>
            <input
              type="number"
              className="mono"
              value={refArea}
              min={0}
              step="any"
              placeholder="auto (frontal area)"
              disabled={!file}
              onChange={(e) => setRefArea(e.target.value)}
              title="Coefficient reference area. Leave blank to use frontal area; set planform area for a wing's lift coefficient."
            />
          </label>
          <label className="check-field">
            <input
              type="checkbox"
              checked={groundPlane}
              onChange={(e) => setGroundPlane(e.target.checked)}
              disabled={!file}
            />
            <span>Ground plane (rolling road) — for cars &amp; vehicles</span>
          </label>
          <label className="check-field">
            <input
              type="checkbox"
              checked={symmetry}
              onChange={(e) => setSymmetry(e.target.checked)}
              disabled={!file || !symmetryAllowed}
            />
            <span>
              Half-model symmetry (≈2× faster) — symmetric models, 0° yaw only
            </span>
            {file && !symmetryAllowed && (
              <span className="config-note">
                disabled: needs 0° yaw, no props/trim
              </span>
            )}
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
