import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { formatLength, unitHint } from "../lib/unitCheck";
import { inspectionProblem, repairSummary } from "../lib/repairText";
import type { RepairJob, StlInspection } from "../api";
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
  // Model health check + repair. `originalFileRef` keeps the pre-repair file
  // so a repair can be undone; `fileRef` lets async work notice a replaced model.
  const [inspection, setInspection] = useState<StlInspection | null>(null);
  const [repairJob, setRepairJob] = useState<RepairJob | null>(null);
  const [repairError, setRepairError] = useState<string | null>(null);
  const originalFileRef = useRef<File | null>(null);
  const fileRef = useRef<File | null>(null);
  const [dragOver, setDragOver] = useState(false);

  // Config form — explicit "configure, then Run". Number inputs, no sliders,
  // nothing here re-runs anything live.
  const [name, setName] = useState("");
  const [unit, setUnit] = useState<StlUnit>("mm");
  const unitWarn = dims ? unitHint(dims, unit) : null;
  const [windSpeed, setWindSpeed] = useState("15");
  const [yawDeg, setYawDeg] = useState("0");
  const [pitchDeg, setPitchDeg] = useState("0");
  const [rollDeg, setRollDeg] = useState("0");
  const [sweepEnabled, setSweepEnabled] = useState(false);
  const [sweepParam, setSweepParam] = useState<"yaw" | "pitch">("yaw");
  const [sweepAngles, setSweepAngles] = useState("0, 15, 30, 45");
  const [propsEnabled, setPropsEnabled] = useState(false);
  const [detectingProps, setDetectingProps] = useState(false);
  const [propNote, setPropNote] = useState<string | null>(null);
  const [propRows, setPropRows] = useState<
    { x: string; y: string; z: string; d: string; t: string }[]
  >([{ x: "0", y: "0", z: "0", d: "127", t: "300" }]);
  const [trimEnabled, setTrimEnabled] = useState(false);
  // No default: trim results scale with weight, so it must be entered.
  const [trimWeight, setTrimWeight] = useState("");
  // Mesh-independence sweep: coarse -> medium -> fine until Cd settles.
  const [meshSweep, setMeshSweep] = useState(false);
  const [meshTol, setMeshTol] = useState("2");
  // Trim solves pitch + per-prop thrust itself; only live with prop disks.
  const trimOn = propsEnabled && trimEnabled;
  const [refArea, setRefArea] = useState(""); // cm², blank = auto (frontal)
  const [groundPlane, setGroundPlane] = useState(false);
  const [symmetry, setSymmetry] = useState(false);
  // Optional extra mesh refinement (off by default: more cells, longer runs).
  const [longWake, setLongWake] = useState(false);
  const [propSlipstream, setPropSlipstream] = useState(false);
  // Slipstream refinement follows the prop disks, so it needs them on.
  const slipstreamOn = propsEnabled && propSlipstream;
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

  // Ask the backend to find the motors (distance-transform pads on the
  // footprint) and put the disks on them; fall back to the frame corners.
  const detectPropRows = async () => {
    if (!file) return;
    setDetectingProps(true);
    try {
      const found = await api.detectProps(file, unit);
      if (found.props.length) {
        setPropRows(
          found.props.map((p) => ({
            x: String(p.center[0]),
            y: String(p.center[1]),
            z: String(p.center[2]),
            d: String(p.diameter),
            t: "300",
          })),
        );
        setPropNote(`found ${found.props.length} motors — disks placed on top of them`);
      } else {
        setPropRows(seedPropRows(4));
        setPropNote(`no motors recognized (${found.reason}) — disks placed at the frame corners`);
      }
    } catch {
      setPropNote("motor detection unavailable — disks placed at the frame corners");
    } finally {
      setDetectingProps(false);
    }
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

  const acceptFile = useCallback(async (f: File, repaired = false) => {
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
      fileRef.current = f;
      setFile(f);
      if (!repaired) {
        // A fresh model: new name, and any earlier repair no longer applies.
        setName(nameFromFilename(f.name));
        originalFileRef.current = null;
        setRepairJob(null);
        setRepairError(null);
      }
      setSubmitError(null);
      setInspection(null);
      api.inspectStl(f).then(
        (ins) => {
          if (fileRef.current === f) setInspection(ins);
        },
        () => {
          // Advisory only — the run itself still validates the STL.
        },
      );
    } catch (e) {
      setParseError(`Could not parse STL: ${(e as Error).message}`);
    }
  }, []);

  const repairModel = async () => {
    const source = fileRef.current;
    if (!source) return;
    setRepairError(null);
    try {
      const { id } = await api.startRepair(source);
      let job: RepairJob = {
        id,
        status: "running",
        progress: 0,
        stage: "queued",
        report: null,
        error: null,
      };
      setRepairJob(job);
      while (job.status === "running") {
        await new Promise((r) => setTimeout(r, 700));
        if (fileRef.current !== source) return; // model replaced mid-repair
        job = await api.getRepair(id);
        setRepairJob(job);
      }
      if (job.status === "error") {
        setRepairJob(null);
        setRepairError(`Repair failed: ${job.error ?? "unknown error"}`);
        return;
      }
      const buf = await api.getRepairStl(id);
      if (fileRef.current !== source) return;
      originalFileRef.current = originalFileRef.current ?? source;
      const base = source.name.replace(/\.stl$/i, "");
      await acceptFile(new File([buf], `${base}_repaired.stl`, { type: "model/stl" }), true);
    } catch (err) {
      setRepairJob(null);
      setRepairError(
        err instanceof Error && err.name === "BackendUnreachableError"
          ? "Backend unreachable — is the server running on :8000?"
          : `Repair failed: ${(err as Error).message}`,
      );
    }
  };

  const restoreOriginal = async () => {
    const original = originalFileRef.current;
    if (!original) return;
    originalFileRef.current = null;
    setRepairJob(null);
    setRepairError(null);
    await acceptFile(original, true);
  };

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
      if (trimWeight.trim() === "") {
        setSubmitError(
          "Enter the craft's weight in grams — the trim attitude and thrust depend on it",
        );
        return;
      }
      if (!Number.isFinite(w) || w <= 0) {
        setSubmitError("Craft weight must be a positive number of grams");
        return;
      }
      trimCfg = { weight_g: w };
    }
    let meshTolPct: number | undefined;
    if (meshSweep) {
      const tol = parseFloat(meshTol);
      if (!Number.isFinite(tol) || tol <= 0 || tol > 50) {
        setSubmitError("Mesh sweep tolerance must be a percentage above 0 and at most 50");
        return;
      }
      meshTolPct = tol;
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
      ...(meshTolPct !== undefined ? { mesh_sweep: { tol_pct: meshTolPct } } : {}),
      ...(refAreaCm2 ? { ref_area_cm2: refAreaCm2 } : {}),
      ...(roll ? { roll_deg: roll } : {}),
      ...(groundPlane ? { ground_plane: true } : {}),
      ...(symmetry ? { symmetry: true } : {}),
      ...(longWake || slipstreamOn
        ? {
            refinement: {
              ...(longWake ? { long_wake: true } : {}),
              ...(slipstreamOn ? { prop_slipstream: true } : {}),
            },
          }
        : {}),
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
                  fileRef.current = null;
                  originalFileRef.current = null;
                  setInspection(null);
                  setRepairJob(null);
                  setRepairError(null);
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
            <div className="viewer-alerts">
            {unitWarn && (
              <div className="viewer-unit-warn" role="alert">
                <span>
                  &#9888; Read as {unit}, this model is {formatLength(unitWarn.sizeM)} across
                  {" — "}the STL was probably exported in a different unit.
                </span>
                {unitWarn.suggest && (
                  <button
                    type="button"
                    className="chip"
                    onClick={() => setUnit(unitWarn.suggest as StlUnit)}
                  >
                    use {unitWarn.suggest}
                  </button>
                )}
              </div>
            )}
            {repairJob?.status === "running" ? (
              <div className="viewer-repair" role="status">
                <span>Repairing model · {repairJob.stage}</span>
                <div className="repair-bar">
                  <span style={{ width: `${Math.round(repairJob.progress * 100)}%` }} />
                </div>
              </div>
            ) : repairError ? (
              <div className="viewer-repair viewer-repair-bad" role="alert">
                <span>&#9888; {repairError}</span>
                <button type="button" className="chip" onClick={() => void repairModel()}>
                  try again
                </button>
              </div>
            ) : originalFileRef.current && repairJob?.report ? (
              <div className="viewer-repair viewer-repair-ok" role="status">
                <span>&#10003; Repaired: {repairSummary(repairJob.report, unit)}</span>
                <button type="button" className="chip" onClick={() => void restoreOriginal()}>
                  restore original
                </button>
              </div>
            ) : inspection && !inspection.watertight ? (
              <div className="viewer-repair" role="alert">
                <span>
                  &#9888; Not a closed surface ({inspectionProblem(inspection)}). It may
                  mesh badly or stall the solver.
                </span>
                <button type="button" className="chip" onClick={() => void repairModel()}>
                  repair model
                </button>
              </div>
            ) : null}
            </div>
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
              onChange={(e) => {
                setSweepEnabled(e.target.checked);
                if (e.target.checked) setMeshSweep(false);
              }}
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
              checked={meshSweep}
              onChange={(e) => {
                setMeshSweep(e.target.checked);
                if (e.target.checked) {
                  setSweepEnabled(false);
                  setTrimEnabled(false);
                }
              }}
              disabled={!file}
              title="Rerun at coarse, medium and fine meshes until Cd stops changing"
            />
            <span>Mesh independence — refine until Cd changes ≤</span>
            <input
              type="number"
              className="mono mesh-tol"
              value={meshTol}
              min={0.1}
              max={50}
              step="any"
              onChange={(e) => setMeshTol(e.target.value)}
              disabled={!file || !meshSweep}
              aria-label="Cd change tolerance (percent)"
            />
            <span>%</span>
          </label>
          <label className="check-field">
            <input
              type="checkbox"
              checked={propsEnabled}
              onChange={(e) => {
                setPropsEnabled(e.target.checked);
                setPropNote(null);
                // Seed a four-rotor layout on the frame at once, then move the
                // disks onto the motors if the backend finds them.
                if (e.target.checked) {
                  setPropRows(seedPropRows(4));
                  void detectPropRows();
                }
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
                <button
                  type="button"
                  className="chip"
                  disabled={detectingProps}
                  onClick={() => void detectPropRows()}
                  title="Find the motors in the model and place one disk on each"
                >
                  {detectingProps ? "finding motors…" : "detect motors"}
                </button>
                <span className="config-note">
                  positions/ø in STL units · thrust axis = model +Z
                  {trimOn && " · thrust solved by trim"}
                </span>
              </div>
              {propNote && <div className="config-note">{propNote}</div>}
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={trimEnabled}
                  onChange={(e) => {
                    setTrimEnabled(e.target.checked);
                    if (e.target.checked) {
                      setSweepEnabled(false);
                      setMeshSweep(false);
                    }
                  }}
                />
                <span>Solve trim attitude</span>
              </label>
              {trimEnabled && (
                <label className="field">
                  <span className="field-label">Craft weight (g) — required</span>
                  <input
                    type="number"
                    className="mono"
                    value={trimWeight}
                    onChange={(e) => setTrimWeight(e.target.value)}
                    min={1}
                    step="any"
                    placeholder="all-up weight, e.g. 650"
                    required
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
          <div className="field">
            <span className="field-label">Extra mesh refinement — optional</span>
            <label className="check-field">
              <input
                type="checkbox"
                checked={longWake}
                onChange={(e) => setLongWake(e.target.checked)}
                disabled={!file}
              />
              <span>Longer wake — refine 4 body lengths behind the model</span>
            </label>
            <label className="check-field">
              <input
                type="checkbox"
                checked={slipstreamOn}
                onChange={(e) => setPropSlipstream(e.target.checked)}
                disabled={!file || !propsEnabled}
              />
              <span>Prop slipstreams — refine the flow through each prop disk</span>
              {file && !propsEnabled && (
                <span className="config-note">needs propeller disks</span>
              )}
            </label>
            {(longWake || slipstreamOn) && (
              <span className="config-note">
                more cells and a longer run; the slipstream zones tilt with the
                wind speed and thrust
              </span>
            )}
          </div>
          <label className="field">
            <span className="field-label">Mesh quality</span>
            <select
              value={quality}
              onChange={(e) => setQuality(e.target.value as Quality)}
              disabled={!file || meshSweep}
            >
              {(Object.keys(QUALITY_HINTS) as Quality[]).map((q) => (
                <option key={q} value={q}>
                  {q} ({QUALITY_HINTS[q]})
                </option>
              ))}
            </select>
            {meshSweep && (
              <span className="config-note">
                set by the mesh sweep: coarse, then medium and fine only if needed
              </span>
            )}
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
            : meshSweep
              ? "Run mesh independence sweep"
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
