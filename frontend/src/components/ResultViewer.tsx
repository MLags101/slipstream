import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import {
  api,
  ApiError,
  type ModelInfo,
  type RunConfig,
  type SliceAxis,
  type VizSlice,
  type VizStreamlines,
  type VizSurface,
} from "../api";
import { createViewer, buildSceneHelpers, type Viewer } from "../viewer/scene";
import { toMeshArrays, UNIT_TO_METERS } from "../lib/geometry";
import {
  divergingBWR,
  viridis,
  fieldToVertexColors,
  symmetricNorm,
  linearNorm,
} from "../lib/colormaps";
import { Colorbar } from "./Colorbar";

type Mode = "geometry" | "surface" | "slice" | "streamlines";

interface Props {
  runId: string;
  config: RunConfig;
  model?: ModelInfo | null;
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
  for (const track of viz.lines) {
    for (let i = 0; i + 1 < track.length; i++) {
      for (const idx of [track[i], track[i + 1]]) {
        segPos.push(pos[3 * idx], pos[3 * idx + 1], pos[3 * idx + 2]);
        segCol.push(colors[3 * idx], colors[3 * idx + 1], colors[3 * idx + 2]);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(segPos), 3));
  g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(segCol), 3));
  return g;
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

/**
 * 3D result viewer: geometry / surface pressure (Cp) / flow slice (u_mag,
 * movable plane on any axis) / streamlines. Viz meshes are in meters centered
 * at the origin; the raw STL is rescaled, recentered and yaw-rotated the same
 * way the backend prepares it, so all modes overlay consistently.
 */
export function ResultViewer({ runId, config, model }: Props) {
  const [mode, setMode] = useState<Mode>("surface");
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
    streamlines?: VizStreamlines;
    slices: Record<string, VizSlice>;
  }>({ slices: {} });

  const sliceKey = `${sliceAxis}@${slicePos ?? "center"}`;

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
            // Match backend prep: scale to meters, center at origin,
            // rotate -yaw about Z.
            const k = UNIT_TO_METERS[config.unit];
            g.scale(k, k, k);
            g.computeBoundingBox();
            const c = g.boundingBox!.getCenter(new THREE.Vector3());
            g.translate(-c.x, -c.y, -c.z);
            g.rotateZ((-config.yaw_deg * Math.PI) / 180);
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
          frameOnce(viewer, mesh);
          viewer.setContent(group);
        } else if (mode === "streamlines") {
          const [lines, surface] = await Promise.all([
            cache.streamlines
              ? Promise.resolve(cache.streamlines)
              : api.getVizStreamlines(runId),
            getSurface(),
          ]);
          cache.streamlines = lines;
          if (cancelled) return;

          const segs = new THREE.LineSegments(
            streamlinesToSegments(lines),
            new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 }),
          );
          const body = grayContext(surface, true);
          const group = new THREE.Group();
          group.add(segs);
          group.add(body);
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
  }, [runId, mode, sliceKey, sliceAxis, slicePos, config.unit, config.yaw_deg]);

  const surface = cacheRef.current.surface;
  const slice = cacheRef.current.slices[sliceKey];
  const streamlines = cacheRef.current.streamlines;
  const cpMax = surface
    ? Math.max(Math.abs(surface.ranges.cp[0]), Math.abs(surface.ranges.cp[1]))
    : 0;

  // Slice position bounds (mm) along the active axis, from the domain bbox.
  const axisIdx = { x: 0, y: 1, z: 2 }[sliceAxis];
  const domain = model?.domain_bbox_m;
  const posMin = domain ? Math.round(domain[0][axisIdx] * 1000) : undefined;
  const posMax = domain ? Math.round(domain[1][axisIdx] * 1000) : undefined;

  const applySlicePos = () => {
    const mm = parseFloat(posInput);
    if (!Number.isFinite(mm)) return;
    setSlicePos(mm === 0 && sliceAxis !== "x" ? undefined : mm / 1000);
  };

  return (
    <section className="panel viewer-panel">
      <div className="panel-head viewer-panel-head">
        <span>3D viewer</span>
        <div className="segmented">
          {(
            [
              ["geometry", "Geometry"],
              ["surface", "Surface pressure"],
              ["slice", "Flow slice"],
              ["streamlines", "Streamlines"],
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
              <input
                type="number"
                value={posInput}
                step="any"
                min={posMin}
                max={posMax}
                onChange={(e) => setPosInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && applySlicePos()}
                title={
                  posMin !== undefined
                    ? `plane position along ${sliceAxis}, ${posMin} to ${posMax} mm`
                    : "plane position (mm)"
                }
              />
              <span className="slice-pos-unit">mm</span>
              <button className="seg" onClick={applySlicePos}>
                Set
              </button>
            </div>
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
        {loading && (
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
        {mode === "slice" && slice && (
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
