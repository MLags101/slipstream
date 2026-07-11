/**
 * Pure math for the slice sweep animation: frame plane positions along an
 * axis and the common color range across frames. No three.js imports so
 * these stay unit-testable.
 */

/**
 * `count` evenly spaced plane positions spanning [min, max] widened by ±20%
 * of the extent (the backend clamps positions into the domain).
 */
export function sweepPositions(min: number, max: number, count = 12): number[] {
  const extent = max - min;
  const lo = min - 0.2 * extent;
  const hi = max + 0.2 * extent;
  if (count <= 1) return [(lo + hi) / 2];
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(lo + ((hi - lo) * i) / (count - 1));
  }
  return out;
}

/**
 * Union of per-frame [min, max] ranges -> one fixed range so every frame of
 * the animation is recolored against the same scale.
 */
export function commonRange(ranges: [number, number][]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const [a, b] of ranges) {
    if (a < lo) lo = a;
    if (b > hi) hi = b;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  return [lo, hi];
}
