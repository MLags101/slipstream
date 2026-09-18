import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import {
  api,
  ApiError,
  type ModelInfo,
  type PropDiskM,
  type RunConfig,
  type SliceAxis,
  type StreamDensity,
  type StreamRegion,
  type VizSlice,
  type VizStreamlines,
  type VizShock,
  type VizSurface,
} from "../api";
import { createViewer, buildSceneHelpers, type Viewer } from "../viewer/scene";
import { toMeshArrays, UNIT_TO_METERS } from "../lib/geometry";
import { commonRange, sweepPositions } from "../lib/sweep";
import {
  divergingBWR,
  viridis,
  fieldToVertexColors,
  sampleStops,
  type RGB,
  symmetricNorm,
  linearNorm,
} from "../lib/colormaps";
import { Colorbar } from "./Colorbar";
import { downloadDataUrl } from "../lib/download";

type Mode = "geometry" | "surface" | "slice" | "streamlines" | "shock";

interface Props {
  runId: string;
  config: RunConfig;
  model?: ModelInfo | null;
  props?: PropDiskM[] | null;
}

const VIEWS: { label: string; dir: [number, number, number] }[] = [
  { label: "Iso", dir: [-1.3, -1.8, 1.0] },
  { label: "Front", dir: [-1, 0, 0] },
  { label: "Side", dir: [0, -1, 0] },
  { label: "Top", dir: [0, -0.12, 1] },
];

const AXIS_LABEL: Record<SliceAxis, string> = {
  x: "front (x)",
  y: "side (y)",
  z: "top (z)",
};

const AXIS_IDX: Record<SliceAxis, number> = { x: 0, y: 1, z: 2 };

/** Slice sweep animation: frame count and playback speed (~2.5 fps). */
const SWEEP_COUNT = 12;
const SWEEP_FRAME_MS = 400;

/** Pre-fetched sweep frames for one axis (raw payloads, cached per run). */
interface SweepFrames {
  positions: number[];
  frames: VizSlice[];
}

/** Camera orientation locked normal to each slice plane (2D-style view). */
const SLICE_VIEW: Record<SliceAxis, { dir: [number, number, number]; up: [number, number, number] }> = {
  x: { dir: [-1, 0, 0], up: [0, 0, 1] },
  y: { dir: [0, -1, 0], up: [0, 0, 1] },
  z: { dir: [0, 0, 1], up: [0, 1, 0] },
};

/** Build a BufferGeometry from the contract's flat-array viz payload. */
function vizToGeometry(positions: number[], indices: number[]): THREE.BufferGeometry {
  const arrays = toMeshArrays(positions, indices);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(arrays.positions, 3));
  g.setIndex(new THREE.BufferAttribute(arrays.indices, 1));
  g.computeVertexNormals();
  return g;
}

/** Streamline polylines -> a single LineSegments geometry with vertex colors. */
function streamlinesToSegments(viz: VizStreamlines): THREE.BufferGeometry {
  const pos = viz.positions;
  const colors = fieldToVertexColors(
    viz.fields.u_mag,
    viridis,
    linearNorm(viz.ranges.u_mag[0], viz.ranges.u_mag[1]),
  );
  const segPos: number[] = [];
  const segCol: number[] = [];
  const segDist: number[] = [];
  for (const track of viz.lines) {
    // Arc length accumulates along the whole track, not per segment: three's
    // own computeLineDistances() restarts at every LineSegments pair, which
    // would make each segment dash identically instead of the dashes running
    // along the streamline.
    let run = 0;
    for (let i = 0; i + 1 < track.length; i++) {
      const a = track[i];
      const b = track[i + 1];
      const step = Math.hypot(
        pos[3 * b] - pos[3 * a],
        pos[3 * b + 1] - pos[3 * a + 1],
        pos[3 * b + 2] - pos[3 * a + 2],
      );
      for (const [idx, d] of [[a, run], [b, run + step]] as [number, number][]) {
        segPos.push(pos[3 * idx], pos[3 * idx + 1], pos[3 * idx + 2]);
        segCol.push(colors[3 * idx], colors[3 * idx + 1], colors[3 * idx + 2]);
        segDist.push(d);
      }
      run += step;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(segPos), 3));
  g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(segCol), 3));
  g.setAttribute("lineDistance", new THREE.BufferAttribute(new Float32Array(segDist), 1));
  return g;
}

/**
 * Cool ramp for the shock shell: deep blue through cyan to near-white.
 *
 * Flow speed varies little across a density isosurface, so a full-spectrum
 * map like viridis pushes almost the whole surface to one end and reads as a
 * flat wash of colour. A single-hue ramp keeps the brightness variation doing
 * the work and matches the rest of the viewer.
 */
function shockRamp(t: number): RGB {
  return sampleStops(
    [
      [0.10, 0.20, 0.42],
      [0.18, 0.55, 0.82],
      [0.22, 0.82, 1.0],
      [0.88, 0.97, 1.0],
    ],
    t,
  );
}

/**
 * Shock isosurface material.
 *
 * A shock is a thin sheet, and shading it like a solid turns the whole
 * envelope into an opaque blob that hides both the aircraft and the wave
 * structure. This shades by viewing angle instead: bright where the sheet is
 * seen edge-on (the silhouette of each cone), nearly clear face-on. Additive
 * blending then makes overlapping sheets accumulate, so a shock crossing
 * another reads as a brighter line rather than flat grey.
 */
function shockShellMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: { uEdge: { value: 2.0 }, uGain: { value: 1.25 } },
    vertexShader: `
      attribute vec3 shockColor;
      varying vec3 vCol;
      varying vec3 vN;
      varying vec3 vView;
      void main() {
        vCol = shockColor;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vView = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform float uEdge;
      uniform float uGain;
      varying vec3 vCol;
      varying vec3 vN;
      varying vec3 vView;
      void main() {
        float facing = abs(dot(normalize(vN), normalize(vView)));
        float rim = pow(clamp(1.0 - facing, 0.0, 1.0), uEdge);
        float a = clamp(rim * uGain, 0.0, 1.0);
        gl_FragColor = vec4(vCol * a, a);
      }`,
  });
}

/**
 * Streamline material whose dashes travel along the flow. three's
 * LineDashedMaterial has no dash offset, so one is injected into its shader
 * and driven from the render loop.
 */
function flowDashMaterial(dashSize: number): {
  material: THREE.LineDashedMaterial;
  offset: { value: number };
} {
  const offset = { value: 0 };
  const material = new THREE.LineDashedMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.95,
    dashSize,
    gapSize: dashSize * 1.6,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uDashOffset = offset;
    shader.fragmentShader =
      "uniform float uDashOffset;\n" +
      shader.fragmentShader.replace(
        "if ( mod( vLineDistance, totalSize ) > dashSize ) {",
        "if ( mod( vLineDistance - uDashOffset, totalSize ) > dashSize ) {",
      );
  };
  return { material, offset };
}

function grayContext(surface: VizSurface, opaque: boolean): THREE.Mesh {
  return new THREE.Mesh(
    vizToGeometry(surface.positions, surface.indices),
    new THREE.MeshStandardMaterial({
      color: opaque ? 0x9fa8b3 : 0x8b929c,
      transparent: !opaque,
      opacity: opaque ? 1 : 0.38,
      depthWrite: opaque,
      roughness: 0.7,
    }),
  );
}

const PROP_BLADES = 2;

/**
 * Stylized spinning-prop disks: translucent swept disk, solid rim, hub, and
 * faint blade silhouettes, oriented on each disk's thrust axis. Purely visual —
 * the solver models the prop as a momentum source over this disk.
 */
function propDisks(props: PropDiskM[]): THREE.Group {
  const group = new THREE.Group();
  const up = new THREE.Vector3(0, 0, 1);
  for (const p of props) {
    const r = p.diameter_m / 2;
    const holder = new THREE.Group();
    const fill = new THREE.Mesh(
      new THREE.CircleGeometry(r, 64),
      new THREE.MeshBasicMaterial({
        color: 0x35c5dd,
        transparent: true,
        opacity: 0.16,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    const rim = new THREE.Mesh(
      new THREE.RingGeometry(r * 0.965, r, 96),
      new THREE.MeshBasicMaterial({
        color: 0x35c5dd,
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    const hub = new THREE.Mesh(
      new THREE.CircleGeometry(r * 0.07, 24),
      new THREE.MeshBasicMaterial({ color: 0x35c5dd, side: THREE.DoubleSide }),
    );
    // Thin swept-edge band so the disk still reads as a prop when a side or
    // front view looks at it edge-on (the flat layers vanish there).
    const band = new THREE.Mesh(
      new THREE.CylinderGeometry(r, r, p.diameter_m * 0.035, 96, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0x35c5dd,
        transparent: true,
        opacity: 0.55,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    band.rotation.x = Math.PI / 2; // cylinder axis Y -> disk axis Z
    band.renderOrder = 3;
    holder.add(fill, rim, hub, band);
    // Blade silhouettes: a slim tapered shape per blade, evenly spaced.
    const blade = new THREE.Shape();
    blade.moveTo(r * 0.08, -r * 0.035);
    blade.quadraticCurveTo(r * 0.55, -r * 0.11, r * 0.94, -r * 0.03);
    blade.lineTo(r * 0.94, r * 0.02);
    blade.quadraticCurveTo(r * 0.55, r * 0.07, r * 0.08, r * 0.035);
    blade.closePath();
    const bladeGeom = new THREE.ShapeGeometry(blade, 12);
    for (let i = 0; i < PROP_BLADES; i++) {
      const b = new THREE.Mesh(
        bladeGeom,
        new THREE.MeshBasicMaterial({
          color: 0x35c5dd,
          transparent: true,
          opacity: 0.4,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      b.rotation.z = (i / PROP_BLADES) * Math.PI * 2 + Math.PI / 5;
      holder.add(b);
    }
    // Keep coplanar layers from z-fighting.
    fill.renderOrder = 1;
    holder.children.slice(3).forEach((c) => (c.renderOrder = 2));
    rim.renderOrder = 3;
    hub.renderOrder = 3;
    holder.quaternion.setFromUnitVectors(up, new THREE.Vector3(...p.axis).normalize());
    holder.position.set(...p.center_m);
    group.add(holder);
  }
  return group;
}

/**
 * 3D result viewer: geometry / surface pressure (Cp) / flow slice (u_mag,
 * movable plane on any axis) / streamlines. Viz meshes are in meters centered
 * at the origin; the raw STL is rescaled, recentered and yaw-rotated the same
 * way the backend prepares it, so all modes overlay consistently.
 */
export function ResultViewer({ runId, config, model, props }: Props) {
  const [mode, setMode] = useState<Mode>("surface");
  const [showProps, setShowProps] = useState(true);
  const hasProps = !!props && props.length > 0;
  const [sliceAxis, setSliceAxis] = useState<SliceAxis>("y");
  // Slice plane position, meters; undefined = center plane (fast path).
  const [slicePos, setSlicePos] = useState<number | undefined>(undefined);
  const [posInput, setPosInput] = useState("0");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const hostRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const framedRef = useRef(false);
  const sphereRef = useRef<THREE.Sphere | null>(null);

  // Per-run data caches (fetched lazily per mode, kept for tab switches).
  const cacheRef = useRef<{
    stl?: THREE.BufferGeometry;
    surface?: VizSurface;
    streamlines: Record<string, VizStreamlines>;
    shocks: Record<string, VizShock>;
    slices: Record<string, VizSlice>;
    sweeps: Partial<Record<SliceAxis, SweepFrames>>;
  }>({ slices: {}, sweeps: {}, streamlines: {}, shocks: {} });

  const sliceKey = `${sliceAxis}@${slicePos ?? "center"}`;

  // Streamline seeding controls (explicit segmented buttons).
  const [streamDensity, setStreamDensity] = useState<StreamDensity>("med");
  const [streamRegion, setStreamRegion] = useState<StreamRegion>("full");
  const streamKey = `${streamDensity}/${streamRegion}`;
  // Shock isosurface: density rise above freestream that marks the front.
  // Lower catches the weak canopy and wing waves; higher isolates the bow shock.
  const [shockPct, setShockPct] = useState(12);
  const shockKey = `${shockPct}`;
  const compressible =
    (config.flow_model ?? "incompressible") !== "incompressible";
  // Dashes travelling along the streamlines. Off by default: solid lines read
  // better for a still, and the motion is a deliberate choice, not the norm.
  const [flowAnim, setFlowAnim] = useState(false);

  // Dash offset for the streamline flow animation, driven by a rAF loop while
  // the streamline view is open.
  const flowDashRef = useRef<{ offset: { value: number }; speed: number } | null>(
    null,
  );

  // Advance the dash pattern while streamlines are shown. The viewer renders
  // continuously, so moving the uniform is all that is needed.
  useEffect(() => {
    if (mode !== "streamlines" || !flowAnim) {
      flowDashRef.current = null;
      return;
    }
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const d = flowDashRef.current;
      if (d) d.offset.value += d.speed * dt;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [mode, flowAnim]);

  // --- slice sweep animation state ---------------------------------------
  const [sweepPhase, setSweepPhase] = useState<"idle" | "sampling" | "playing">(
    "idle",
  );
  const [sweepSample, setSweepSample] = useState(0); // k while sampling k/N
  const [sweepFrame, setSweepFrame] = useState(0); // current playback frame
  // Fixed |U| range across all frames (drives recoloring + colorbar).
  const [sweepRange, setSweepRange] = useState<[number, number] | null>(null);
  const sweepTokenRef = useRef<{ cancelled: boolean } | null>(null);
  const sweepPlayRef = useRef<{
    frames: VizSlice[];
    positions: number[];
    colors: Float32Array[];
    mesh: THREE.Mesh;
  } | null>(null);
  const sweepFrameRef = useRef(0);
  const sweeping = sweepPhase !== "idle";

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const viewer = createViewer(host);
    viewerRef.current = viewer;
    framedRef.current = false;
    return () => {
      viewer.dispose();
      viewerRef.current = null;
    };
  }, [runId]);

  const sliceViewRef = useRef<SliceAxis | null>(null);

  // Slice mode is a locked, plane-normal view: no orbiting (pan/zoom stay on).
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    viewer.controls.enableRotate = mode !== "slice";
    if (mode !== "slice") {
      viewer.camera.up.set(0, 0, 1);
      sliceViewRef.current = null;
    }
  }, [mode, runId]);

  const snapSliceView = (sphere: THREE.Sphere) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const { dir, up } = SLICE_VIEW[sliceAxis];
    const r = Math.max(sphere.radius, 1e-6);
    viewer.camera.up.set(...up);
    viewer.camera.position
      .copy(sphere.center)
      .addScaledVector(new THREE.Vector3(...dir), r * 3.2);
    viewer.camera.near = r / 100;
    viewer.camera.far = r * 300;
    viewer.camera.updateProjectionMatrix();
    viewer.controls.target.copy(sphere.center);
    viewer.controls.update();
  };

  const setView = (dir: [number, number, number]) => {
    const viewer = viewerRef.current;
    const sphere = sphereRef.current;
    if (!viewer || !sphere) return;
    const v = new THREE.Vector3(...dir).normalize();
    viewer.camera.position
      .copy(sphere.center)
      .addScaledVector(v, sphere.radius * 2.6);
    viewer.controls.target.copy(sphere.center);
    viewer.controls.update();
  };

  useEffect(() => {
    // While the sweep animation owns the slice content, skip the static
    // loader entirely; flipping `sweeping` back to false re-runs this effect
    // and restores the previously selected static slice (from cache).
    if (mode === "slice" && sweeping) return;
    let cancelled = false;
    const cache = cacheRef.current;

    const frameOnce = (viewer: Viewer, obj: THREE.Object3D) => {
      const box = new THREE.Box3().setFromObject(obj);
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      sphereRef.current = sphere;
      if (!framedRef.current) {
        viewer.frame(sphere.center, sphere.radius);
        framedRef.current = true;
      }
      return sphere;
    };

    const getSurface = async () => {
      if (!cache.surface) cache.surface = await api.getVizSurface(runId);
      return cache.surface;
    };

    const load = async () => {
      const viewer = viewerRef.current;
      if (!viewer) return;
      setLoading(true);
      setLoadError(null);
      try {
        if (mode === "geometry") {
          if (!cache.stl) {
            const buf = await api.getStl(runId);
            const g = new STLLoader().parse(buf);
            // Match backend prep (geometry.prepare_stl): scale to meters,
            // center, roll about X, pitch about Y, -yaw about Z, re-center.
            const k = UNIT_TO_METERS[config.unit];
            g.scale(k, k, k);
            g.computeBoundingBox();
            const c = g.boundingBox!.getCenter(new THREE.Vector3());
            g.translate(-c.x, -c.y, -c.z);
            g.rotateX(((config.roll_deg ?? 0) * Math.PI) / 180);
            g.rotateY(((config.pitch_deg ?? 0) * Math.PI) / 180);
            g.rotateZ((-config.yaw_deg * Math.PI) / 180);
            g.computeBoundingBox();
            const c2 = g.boundingBox!.getCenter(new THREE.Vector3());
            g.translate(-c2.x, -c2.y, -c2.z);
            g.computeVertexNormals();
            cache.stl = g;
          }
          if (cancelled) return;
          const mesh = new THREE.Mesh(
            cache.stl.clone(),
            new THREE.MeshStandardMaterial({
              color: 0x9fa8b3,
              roughness: 0.6,
              metalness: 0.15,
            }),
          );
          const group = new THREE.Group();
          group.add(mesh);
          const sphere = frameOnce(viewer, mesh);
          group.add(buildSceneHelpers(sphere.radius, sphere.center));
          if (showProps && hasProps) group.add(propDisks(props!));
          viewer.setContent(group);
        } else if (mode === "surface") {
          const viz = await getSurface();
          if (cancelled) return;
          const g = vizToGeometry(viz.positions, viz.indices);
          const colors = fieldToVertexColors(
            viz.fields.cp,
            divergingBWR,
            symmetricNorm(viz.ranges.cp[0], viz.ranges.cp[1]),
          );
          g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
          const mesh = new THREE.Mesh(
            g,
            new THREE.MeshStandardMaterial({
              vertexColors: true,
              roughness: 0.85,
              metalness: 0,
            }),
          );
          const group = new THREE.Group();
          group.add(mesh);
          if (showProps && hasProps) group.add(propDisks(props!));
          frameOnce(viewer, mesh);
          viewer.setContent(group);
        } else if (mode === "shock") {
          const [shock, surface] = await Promise.all([
            cache.shocks[shockKey]
              ? Promise.resolve(cache.shocks[shockKey])
              : api.getVizShock(runId, shockPct / 100),
            getSurface(),
          ]);
          cache.shocks[shockKey] = shock;
          if (cancelled) return;
          const group = new THREE.Group();
          const body = grayContext(surface, true);
          // Translucent and double-sided: the shock is a thin sheet wrapping
          // the aircraft, so both faces have to draw or it reads as holes.
          const shockGeo = vizToGeometry(shock.positions, shock.indices);
          shockGeo.setAttribute(
            "shockColor",
            new THREE.BufferAttribute(
              fieldToVertexColors(
                shock.fields.u_mag,
                shockRamp,
                linearNorm(shock.ranges.u_mag[0], shock.ranges.u_mag[1]),
              ),
              3,
            ),
          );
          const shockMesh = new THREE.Mesh(shockGeo, shockShellMaterial());
          group.add(body);
          group.add(shockMesh);
          if (showProps && hasProps) group.add(propDisks(props!));
          // Frame the shock, not the body: the cone extends several body
          // lengths downstream, and framing the aircraft crops it.
          frameOnce(viewer, shockMesh);
          viewer.setContent(group);
        } else if (mode === "streamlines") {
          const [lines, surface] = await Promise.all([
            cache.streamlines[streamKey]
              ? Promise.resolve(cache.streamlines[streamKey])
              : api.getVizStreamlines(runId, streamDensity, streamRegion),
            getSurface(),
          ]);
          cache.streamlines[streamKey] = lines;
          if (cancelled) return;

          // Dash size scales with the model so the pattern reads the same on a
          // 100 mm drone and a 5 m car.
          const span = model
            ? Math.max(
                model.bbox_m[1][0] - model.bbox_m[0][0],
                model.bbox_m[1][1] - model.bbox_m[0][1],
                model.bbox_m[1][2] - model.bbox_m[0][2],
              )
            : 1;
          let lineMat: THREE.Material;
          if (flowAnim) {
            const { material, offset } = flowDashMaterial(span * 0.06);
            flowDashRef.current = { offset, speed: span * 0.35 };
            lineMat = material;
          } else {
            flowDashRef.current = null;
            lineMat = new THREE.LineBasicMaterial({
              vertexColors: true, transparent: true, opacity: 0.9,
            });
          }
          const segs = new THREE.LineSegments(streamlinesToSegments(lines), lineMat);
          const body = grayContext(surface, true);
          const group = new THREE.Group();
          group.add(segs);
          group.add(body);
          if (showProps && hasProps) group.add(propDisks(props!));
          frameOnce(viewer, body);
          viewer.setContent(group);
        } else {
          // Flow slice + semi-transparent geometry for context.
          const [slice, surface] = await Promise.all([
            cache.slices[sliceKey]
              ? Promise.resolve(cache.slices[sliceKey])
              : api.getVizSlice(runId, sliceAxis, slicePos),
            getSurface(),
          ]);
          cache.slices[sliceKey] = slice;
          if (cancelled) return;

          const sliceGeom = vizToGeometry(slice.positions, slice.indices);
          const colors = fieldToVertexColors(
            slice.fields.u_mag,
            viridis,
            linearNorm(slice.ranges.u_mag[0], slice.ranges.u_mag[1]),
          );
          sliceGeom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
          const sliceMesh = new THREE.Mesh(
            sliceGeom,
            new THREE.MeshBasicMaterial({
              vertexColors: true,
              side: THREE.DoubleSide,
            }),
          );

          const contextMesh = grayContext(surface, false);
          const group = new THREE.Group();
          group.add(sliceMesh);
          group.add(contextMesh);
          if (showProps && hasProps) group.add(propDisks(props!));
          // Slice mode manages its own camera: snap normal to the plane when
          // the axis (or mode) changes; keep zoom when only the position moves.
          const box = new THREE.Box3().setFromObject(contextMesh);
          const sphere = box.getBoundingSphere(new THREE.Sphere());
          sphereRef.current = sphere;
          framedRef.current = true;
          viewer.setContent(group);
          if (sliceViewRef.current !== sliceAxis) {
            snapSliceView(sphere);
            sliceViewRef.current = sliceAxis;
          }
        }
        if (!cancelled) setLoading(false);
      } catch (e) {
        if (cancelled) return;
        setLoading(false);
        if (e instanceof ApiError && e.status === 404) {
          setLoadError("Visualization not available for this run yet.");
        } else {
          setLoadError(`Failed to load: ${(e as Error).message}`);
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [runId, mode, sliceKey, sliceAxis, slicePos, config.unit, config.yaw_deg, config.pitch_deg, config.roll_deg, streamKey, shockKey, sweeping, showProps, props, flowAnim]);

  /**
   * Stop the sweep: cancel any in-flight sampling and drop back to the
   * static slice (the main effect reloads it from cache — no camera snap,
   * since the axis-locked view is unchanged).
   */
  const stopSweep = useCallback(() => {
    if (sweepTokenRef.current) sweepTokenRef.current.cancelled = true;
    sweepPlayRef.current = null;
    setSweepPhase("idle");
    setSweepRange(null);
    setSweepSample(0);
  }, []);

  /**
   * Play the slice sweep: sequentially fetch SWEEP_COUNT planes spanning the
   * model bbox ±20% along the active axis (each on-demand slice takes ~2-3s
   * server-side), recolor all frames against their common |U| range, then
   * loop. Frames are cached per axis so replays start instantly.
   */
  const startSweep = async () => {
    if (sweeping || mode !== "slice" || !model) return;
    const axis = sliceAxis;
    const token = { cancelled: false };
    sweepTokenRef.current = token;
    setSweepPhase("sampling");
    setSweepSample(0);
    setLoadError(null);
    try {
      const cache = cacheRef.current;
      let sweep = cache.sweeps[axis];
      if (!sweep) {
        const ai = AXIS_IDX[axis];
        const positions = sweepPositions(
          model.bbox_m[0][ai],
          model.bbox_m[1][ai],
          SWEEP_COUNT,
        );
        const frames: VizSlice[] = [];
        for (let i = 0; i < positions.length; i++) {
          setSweepSample(i + 1);
          const f = await api.getVizSlice(runId, axis, positions[i]);
          if (token.cancelled) return;
          frames.push(f);
        }
        sweep = { positions, frames };
        cache.sweeps[axis] = sweep;
      }
      // Gray model context (normally already cached by the static slice).
      if (!cache.surface) cache.surface = await api.getVizSurface(runId);
      if (token.cancelled) return;
      const viewer = viewerRef.current;
      if (!viewer) return;

      // Recolor every frame against the common range so the animation reads
      // on one fixed scale.
      const range = commonRange(sweep.frames.map((f) => f.ranges.u_mag));
      const norm = linearNorm(range[0], range[1]);
      const colors = sweep.frames.map((f) =>
        fieldToVertexColors(f.fields.u_mag, viridis, norm),
      );

      const g0 = vizToGeometry(sweep.frames[0].positions, sweep.frames[0].indices);
      g0.setAttribute("color", new THREE.BufferAttribute(colors[0], 3));
      const sliceMesh = new THREE.Mesh(
        g0,
        new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }),
      );
      const group = new THREE.Group();
      group.add(sliceMesh);
      group.add(grayContext(cache.surface, false));
      if (showProps && hasProps) group.add(propDisks(props!));
      // Content swap only — never re-frame or re-snap the locked slice camera.
      viewer.setContent(group);

      sweepPlayRef.current = {
        frames: sweep.frames,
        positions: sweep.positions,
        colors,
        mesh: sliceMesh,
      };
      sweepFrameRef.current = 0;
      setSweepFrame(0);
      setSweepRange(range);
      setSweepPhase("playing");
    } catch (e) {
      if (token.cancelled) return;
      setSweepPhase("idle");
      setLoadError(`Sweep failed: ${(e as Error).message}`);
    }
  };

  // Playback loop: step the plane every SWEEP_FRAME_MS, swapping the slice
  // mesh geometry in place (camera untouched).
  useEffect(() => {
    if (sweepPhase !== "playing") return;
    const t = setInterval(() => {
      const play = sweepPlayRef.current;
      if (!play) return;
      sweepFrameRef.current = (sweepFrameRef.current + 1) % play.frames.length;
      const i = sweepFrameRef.current;
      const f = play.frames[i];
      const g = vizToGeometry(f.positions, f.indices);
      g.setAttribute("color", new THREE.BufferAttribute(play.colors[i], 3));
      play.mesh.geometry.dispose();
      play.mesh.geometry = g;
      setSweepFrame(i);
    }, SWEEP_FRAME_MS);
    return () => clearInterval(t);
  }, [sweepPhase]);

  // Any axis/mode/run change (or unmount) aborts sampling and stops playback.
  useEffect(() => {
    return () => stopSweep();
  }, [mode, sliceAxis, runId, stopSweep]);

  const surface = cacheRef.current.surface;
  const slice = cacheRef.current.slices[sliceKey];
  const streamlines = cacheRef.current.streamlines[streamKey];

  // Sweep position readout: server-echoed pos (clamped) falls back to the
  // requested position.
  const play = sweepPlayRef.current;
  const sweepPosM = play
    ? (play.frames[sweepFrame]?.pos ?? play.positions[sweepFrame] ?? 0)
    : 0;
  const sweepReadout = play
    ? `sweep ${sliceAxis} = ${Math.round(sweepPosM * 1000)} mm · ${sweepFrame + 1}/${play.frames.length}`
    : "";
  const cpMax = surface
    ? Math.max(Math.abs(surface.ranges.cp[0]), Math.abs(surface.ranges.cp[1]))
    : 0;

  // Slice position bounds (mm) along the active axis, from the domain bbox.
  const axisIdx = AXIS_IDX[sliceAxis];
  const domain = model?.domain_bbox_m;
  const posMin = domain ? Math.round(domain[0][axisIdx] * 1000) : undefined;
  const posMax = domain ? Math.round(domain[1][axisIdx] * 1000) : undefined;

  const applySlicePos = () => {
    const mm = parseFloat(posInput);
    if (!Number.isFinite(mm)) return;
    setSlicePos(mm === 0 && sliceAxis !== "x" ? undefined : mm / 1000);
  };

  // ◀ ▶ step the plane by ~10% of the model's extent along the active axis.
  const stepMm = (() => {
    const bb = model?.bbox_m;
    if (!bb) return 10;
    const extent = (bb[1][axisIdx] - bb[0][axisIdx]) * 1000;
    const raw = extent / 10;
    // round to 1/2/5×10^n so steps read cleanly
    const mag = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 0.1))));
    const m = raw / mag;
    return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * mag;
  })();

  const stepSlice = (dir: 1 | -1) => {
    let mm = (parseFloat(posInput) || 0) + dir * stepMm;
    if (posMin !== undefined && posMax !== undefined) {
      mm = Math.min(Math.max(mm, posMin), posMax);
    }
    mm = Math.round(mm * 100) / 100;
    setPosInput(String(mm));
    setSlicePos(mm === 0 && sliceAxis !== "x" ? undefined : mm / 1000);
  };

  return (
    <section className="panel viewer-panel">
      <div className="panel-head viewer-panel-head">
        <span>3D viewer</span>
        <button
          className="seg viewer-save"
          title="Save the current view as a PNG"
          onClick={() => {
            const v = viewerRef.current;
            if (!v) return;
            v.renderer.render(v.scene, v.camera);
            downloadDataUrl(
              `slipstream_${mode}.png`,
              v.renderer.domElement.toDataURL("image/png"),
            );
          }}
        >
          save png
        </button>
        {hasProps && (
          <button
            className={`seg${showProps ? " seg-active" : ""}`}
            title="Show or hide the propeller disks the solver modeled"
            onClick={() => setShowProps((v) => !v)}
          >
            props
          </button>
        )}
        <div className="segmented">
          {(
            [
              ["geometry", "Geometry"],
              ["surface", "Surface pressure"],
              ["slice", "Flow slice"],
              ["streamlines", "Streamlines"],
              // Shocks need a density field, which only the compressible
              // solvers write. Hidden entirely on an incompressible run.
              ...(compressible
                ? ([["shock", "Shock waves"]] as [Mode, string][])
                : []),
            ] as [Mode, string][]
          ).map(([m, label]) => (
            <button
              key={m}
              className={`seg${mode === m ? " seg-active" : ""}`}
              onClick={() => setMode(m)}
            >
              {label}
            </button>
          ))}
        </div>
        {mode === "slice" && (
          <>
            <div className="segmented">
              {(["x", "y", "z"] as SliceAxis[]).map((a) => (
                <button
                  key={a}
                  className={`seg${sliceAxis === a ? " seg-active" : ""}`}
                  onClick={() => {
                    setSliceAxis(a);
                    setSlicePos(undefined);
                    setPosInput("0");
                  }}
                >
                  {AXIS_LABEL[a]}
                </button>
              ))}
            </div>
            <div className="slice-pos">
              <button
                className="seg seg-step"
                onClick={() => stepSlice(-1)}
                disabled={sweeping}
                title={`move plane −${stepMm} mm`}
              >
                ◀
              </button>
              <input
                type="number"
                value={posInput}
                step="any"
                min={posMin}
                max={posMax}
                disabled={sweeping}
                onChange={(e) => setPosInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && applySlicePos()}
                title={
                  posMin !== undefined
                    ? `plane position along ${sliceAxis}, ${posMin} to ${posMax} mm`
                    : "plane position (mm)"
                }
              />
              <span className="slice-pos-unit">mm</span>
              <button
                className="seg seg-step"
                onClick={() => stepSlice(1)}
                disabled={sweeping}
                title={`move plane +${stepMm} mm`}
              >
                ▶
              </button>
              <button className="seg" onClick={applySlicePos} disabled={sweeping}>
                Set
              </button>
            </div>
            <div className="segmented">
              <button
                className="seg"
                onClick={() => void startSweep()}
                disabled={sweeping || !model}
                title={`Animate ${SWEEP_COUNT} planes across the model along ${sliceAxis}`}
              >
                ▶ Sweep
              </button>
              <button
                className="seg"
                onClick={stopSweep}
                disabled={!sweeping}
                title="Stop and restore the selected slice"
              >
                ■ Stop
              </button>
            </div>
          </>
        )}
        {mode === "shock" && (
          <>
            <div className="segmented" title="density rise above freestream that marks the shock front">
              {[6, 12, 25].map((v) => (
                <button
                  key={v}
                  className={`seg${shockPct === v ? " seg-active" : ""}`}
                  onClick={() => setShockPct(v)}
                >
                  {v === 6 ? "weak" : v === 12 ? "std" : "strong"}
                </button>
              ))}
            </div>
            <span className="config-note viewer-note">
              isosurface at +{shockPct}% density
            </span>
          </>
        )}
        {mode === "streamlines" && (
          <>
            <div className="segmented" title="seed grid density">
              {(["low", "med", "high"] as StreamDensity[]).map((d) => (
                <button
                  key={d}
                  className={`seg${streamDensity === d ? " seg-active" : ""}`}
                  onClick={() => setStreamDensity(d)}
                >
                  {d}
                </button>
              ))}
            </div>
            <div className="segmented" title="seed rake span vs model size">
              {(["full", "core"] as StreamRegion[]).map((r) => (
                <button
                  key={r}
                  className={`seg${streamRegion === r ? " seg-active" : ""}`}
                  onClick={() => setStreamRegion(r)}
                >
                  {r}
                </button>
              ))}
            </div>
            <label className="viewer-check" title="Dashes travel along the streamlines in the flow direction">
              <input
                type="checkbox"
                checked={flowAnim}
                onChange={(e) => setFlowAnim(e.target.checked)}
              />
              <span>animate</span>
            </label>
          </>
        )}
      </div>
      <div className="viewer-body">
        <div className="viewer-canvas" ref={hostRef} />
        {mode !== "slice" && (
          <div className="view-presets">
            {VIEWS.map((v) => (
              <button key={v.label} className="seg" onClick={() => setView(v.dir)}>
                {v.label}
              </button>
            ))}
          </div>
        )}
        {sweeping && (
          <div className="viewer-status">
            {sweepPhase === "sampling"
              ? `sampling ${sweepSample}/${SWEEP_COUNT}…`
              : sweepReadout}
          </div>
        )}
        {!sweeping && loading && (
          <div className="viewer-status">
            {mode === "slice" && slicePos !== undefined
              ? "sampling plane…"
              : mode === "streamlines" && !streamlines
                ? "tracing streamlines…"
                : "loading…"}
          </div>
        )}
        {loadError && <div className="viewer-status viewer-status-error">{loadError}</div>}
        {mode === "surface" && surface && (
          <Colorbar
            colormap={divergingBWR}
            min={-cpMax}
            max={cpMax}
            label="Cp"
            showZero
          />
        )}
        {mode === "slice" && sweepRange && (
          <Colorbar
            colormap={viridis}
            min={sweepRange[0]}
            max={sweepRange[1]}
            label="|U| m/s"
          />
        )}
        {mode === "slice" && !sweepRange && slice && (
          <Colorbar
            colormap={viridis}
            min={slice.ranges.u_mag[0]}
            max={slice.ranges.u_mag[1]}
            label="|U| m/s"
          />
        )}
        {mode === "streamlines" && streamlines && (
          <Colorbar
            colormap={viridis}
            min={streamlines.ranges.u_mag[0]}
            max={streamlines.ranges.u_mag[1]}
            label="|U| m/s"
          />
        )}
      </div>
    </section>
  );
}
