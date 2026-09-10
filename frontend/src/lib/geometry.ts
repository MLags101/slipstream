/**
 * Pure geometry helpers for turning the contract's flat-array viz payloads
 * into typed arrays for three.js BufferGeometry. No three.js imports so these
 * stay unit-testable.
 */

import type { StlUnit } from "../api";

/** Meters per declared STL unit. */
export const UNIT_TO_METERS: Record<StlUnit, number> = {
  mm: 0.001,
  cm: 0.01,
  m: 1,
  in: 0.0254,
};

export interface MeshArrays {
  positions: Float32Array;
  indices: Uint16Array | Uint32Array;
  vertexCount: number;
}

/**
 * Validate + convert the contract's flat position/index arrays. Picks
 * Uint16 vs Uint32 index storage based on vertex count.
 */
export function toMeshArrays(positions: number[], indices: number[]): MeshArrays {
  if (positions.length % 3 !== 0) {
    throw new Error(`positions length ${positions.length} not divisible by 3`);
  }
  if (indices.length % 3 !== 0) {
    throw new Error(`indices length ${indices.length} not divisible by 3`);
  }
  const vertexCount = positions.length / 3;
  const IndexArray = vertexCount > 65535 ? Uint32Array : Uint16Array;
  const idx = new IndexArray(indices.length);
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i];
    if (v < 0 || v >= vertexCount) {
      throw new Error(`index ${v} out of range (0..${vertexCount - 1})`);
    }
    idx[i] = v;
  }
  return {
    positions: new Float32Array(positions),
    indices: idx,
    vertexCount,
  };
}

export interface PropPlacement {
  x: number;
  y: number;
  z: number;
  /** Rotor diameter, sized so neighbouring disks do not overlap. */
  d: number;
}

/**
 * Starting positions for `count` rotor disks on a multirotor, in the STL's own
 * coordinates. Rotors go on the perimeter of the bounding rectangle shrunk to
 * 85% of its half-extents, at evenly spaced angles, sitting on the model's top
 * face — which is where rotors actually are on a frame, and close to the real
 * motor positions on both test frames (within a few mm on each axis).
 *
 * The angles start half a step in so that the common four-rotor case lands
 * exactly on the four corners rather than on the mid-edges.
 */
export function defaultPropPlacements(
  center: readonly [number, number, number],
  size: readonly [number, number, number],
  count: number,
): PropPlacement[] {
  const n = Math.max(1, Math.floor(count));
  const ax = (Math.abs(size[0]) / 2) * 0.85;
  const ay = (Math.abs(size[1]) / 2) * 0.85;
  const top = center[2] + Math.abs(size[2]) / 2;

  const at = (i: number): [number, number] => {
    const t = ((2 * Math.PI) / n) * i + Math.PI / n;
    const c = Math.cos(t);
    const s = Math.sin(t);
    // Project onto the rectangle perimeter instead of the inscribed ellipse.
    const k = Math.max(Math.abs(c), Math.abs(s)) || 1;
    return [center[0] + (ax * c) / k, center[1] + (ay * s) / k];
  };

  const pts = Array.from({ length: n }, (_, i) => at(i));
  // Diameter from the closest neighbour spacing, so disks never start overlapped.
  let gap = Infinity;
  for (let i = 0; i < pts.length && pts.length > 1; i++) {
    const j = (i + 1) % pts.length;
    gap = Math.min(gap, Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]));
  }
  if (!Number.isFinite(gap) || gap <= 0) gap = Math.max(ax, ay, 1) * 2;
  const d = round1(gap * 0.8);

  return pts.map(([x, y]) => ({ x: round1(x), y: round1(y), z: round1(top), d }));
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

export interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
  center: [number, number, number];
  size: [number, number, number];
  /** Radius of the bounding sphere around center (for camera framing). */
  radius: number;
}

/** Axis-aligned bounds of a flat xyz position array. */
export function boundsOf(positions: ArrayLike<number>): Bounds {
  if (positions.length < 3) {
    return { min: [0, 0, 0], max: [0, 0, 0], center: [0, 0, 0], size: [0, 0, 0], radius: 0 };
  }
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = positions[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  const center: [number, number, number] = [
    (min[0] + max[0]) / 2,
    (min[1] + max[1]) / 2,
    (min[2] + max[2]) / 2,
  ];
  const size: [number, number, number] = [
    max[0] - min[0],
    max[1] - min[1],
    max[2] - min[2],
  ];
  const radius = Math.hypot(size[0], size[1], size[2]) / 2;
  return { min, max, center, size, radius };
}
