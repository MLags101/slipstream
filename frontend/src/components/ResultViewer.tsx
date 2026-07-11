import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import {
  api,
  ApiError,
  type RunConfig,
  type SliceAxis,
  type VizSlice,
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

type Mode = "geometry" | "surface" | "slice";

interface Props {
  runId: string;
  config: RunConfig;
}

/** Build a BufferGeometry from the contract's flat-array viz payload. */
function vizToGeometry(positions: number[], indices: number[]): THREE.BufferGeometry {
  const arrays = toMeshArrays(positions, indices);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(arrays.positions, 3));
  g.setIndex(new THREE.BufferAttribute(arrays.indices, 1));
  g.computeVertexNormals();
  return g;
}

/**
 * 3D result viewer: geometry / surface pressure (Cp) / flow slice (u_mag).
 * Viz meshes are in meters centered at the origin; the raw STL is rescaled,
 * recentered and yaw-rotated the same way the backend prepares it, so all
 * modes overlay consistently.
 */
export function ResultViewer({ runId, config }: Props) {
  const [mode, setMode] = useState<Mode>("surface");
  const [sliceAxis, setSliceAxis] = useState<SliceAxis>("y");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const hostRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const framedRef = useRef(false);

  // Per-run data caches (fetched lazily per mode, kept for tab switches).
  const cacheRef = useRef<{
    stl?: THREE.BufferGeometry;
    surface?: VizSurface;
    slices: Partial<Record<SliceAxis, VizSlice>>;
  }>({ slices: {} });

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

  useEffect(() => {
    let cancelled = false;
    const cache = cacheRef.current;

    const frameOnce = (viewer: Viewer, obj: THREE.Object3D) => {
      const box = new THREE.Box3().setFromObject(obj);
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      if (!framedRef.current) {
        viewer.frame(sphere.center, sphere.radius);
        framedRef.current = true;
      }
      return sphere;
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
          if (!cache.surface) cache.surface = await api.getVizSurface(runId);
          if (cancelled) return;
          const viz = cache.surface;
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
        } else {
          // Flow slice + semi-transparent geometry for context.
          const [slice, surface] = await Promise.all([
            cache.slices[sliceAxis]
              ? Promise.resolve(cache.slices[sliceAxis]!)
              : api.getVizSlice(runId, sliceAxis),
            cache.surface ? Promise.resolve(cache.surface) : api.getVizSurface(runId),
          ]);
          cache.slices[sliceAxis] = slice;
          cache.surface = surface;
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

          const contextGeom = vizToGeometry(surface.positions, surface.indices);
          const contextMesh = new THREE.Mesh(
            contextGeom,
            new THREE.MeshStandardMaterial({
              color: 0x8b929c,
              transparent: true,
              opacity: 0.38,
              depthWrite: false,
              roughness: 0.7,
            }),
          );

          const group = new THREE.Group();
          group.add(sliceMesh);
          group.add(contextMesh);
          frameOnce(viewer, contextMesh);
          viewer.setContent(group);
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
  }, [runId, mode, sliceAxis, config.unit, config.yaw_deg]);

  const surface = cacheRef.current.surface;
  const slice = cacheRef.current.slices[sliceAxis];
  const cpMax = surface
    ? Math.max(Math.abs(surface.ranges.cp[0]), Math.abs(surface.ranges.cp[1]))
    : 0;

  return (
    <section className="panel viewer-panel">
      <div className="panel-head viewer-panel-head">
        <span>3D viewer</span>
        <div className="segmented">
          {(["geometry", "surface", "slice"] as Mode[]).map((m) => (
            <button
              key={m}
              className={`seg${mode === m ? " seg-active" : ""}`}
              onClick={() => setMode(m)}
            >
              {m === "geometry" ? "Geometry" : m === "surface" ? "Surface pressure" : "Flow slice"}
            </button>
          ))}
        </div>
        {mode === "slice" && (
          <div className="segmented">
            {(["y", "z"] as SliceAxis[]).map((a) => (
              <button
                key={a}
                className={`seg${sliceAxis === a ? " seg-active" : ""}`}
                onClick={() => setSliceAxis(a)}
              >
                {a === "y" ? "side (y)" : "top (z)"}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="viewer-body">
        <div className="viewer-canvas" ref={hostRef} />
        {loading && <div className="viewer-status">loading…</div>}
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
      </div>
    </section>
  );
}
