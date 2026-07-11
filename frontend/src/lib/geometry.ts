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
