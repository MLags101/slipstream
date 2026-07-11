/** Pure axis-scale helpers for the SVG convergence charts. */

export interface LinearTicks {
  ticks: number[];
  min: number;
  max: number;
}

/** "Nice" linear ticks covering [min, max] with about `count` steps. */
export function linearTicks(min: number, max: number, count = 5): LinearTicks {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { ticks: [0, 1], min: 0, max: 1 };
  }
  if (min === max) {
    const pad = Math.abs(min) || 1;
    min -= pad * 0.05;
    max += pad * 0.05;
  }
  const span = max - min;
  const rawStep = span / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  // guard fp drift with a half-step epsilon
  for (let v = lo; v <= hi + step / 2; v += step) {
    ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  }
  return { ticks, min: lo, max: hi };
}

/** Decade ticks for a log10 axis covering positive values [min, max]. */
export function logTicks(min: number, max: number): LinearTicks {
  const safeMin = Math.max(min, 1e-12);
  const safeMax = Math.max(max, safeMin * 10);
  const lo = Math.floor(Math.log10(safeMin));
  const hi = Math.ceil(Math.log10(safeMax));
  const ticks: number[] = [];
  for (let e = lo; e <= hi; e++) ticks.push(Math.pow(10, e));
  return { ticks, min: Math.pow(10, lo), max: Math.pow(10, hi) };
}

/** Format a decade tick as 1e-3 style. */
export function formatLogTick(v: number): string {
  const e = Math.round(Math.log10(v));
  if (e === 0) return "1";
  return `1e${e}`;
}
