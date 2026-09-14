/** Pure axis-scale helpers for the SVG convergence charts. */

export interface LinearTicks {
  ticks: number[];
  min: number;
  max: number;
  /** Decimal places the tick spacing needs, so labels are exact and distinct. */
  decimals: number;
}

/** "Nice" linear ticks covering [min, max] with about `count` steps. */
export function linearTicks(min: number, max: number, count = 5): LinearTicks {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { ticks: [0, 1], min: 0, max: 1, decimals: 0 };
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
  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  const round = (v: number) => {
    const r = Number(v.toFixed(decimals));
    return Object.is(r, -0) ? 0 : r;
  };
  const lo = round(Math.floor(min / step) * step);
  const hi = round(Math.ceil(max / step) * step);
  // Index-based and rounded: repeatedly adding `step` drifts (0.2 + 0.1 gives
  // 0.30000000000000004), which leaked straight into axis labels.
  const n = Math.round((hi - lo) / step);
  const ticks: number[] = [];
  for (let i = 0; i <= n; i++) ticks.push(round(lo + i * step));
  return { ticks, min: lo, max: hi, decimals };
}

/**
 * Label for a linear tick: exactly `decimals` places so neighboring ticks never
 * print the same text (0.002 steps no longer collapse to "1.16, 1.16"), with
 * large values kept compact.
 */
export function formatTick(v: number, decimals: number): string {
  if (Math.abs(v) >= 10000) return `${(v / 1000).toFixed(1)}k`;
  return v.toFixed(decimals);
}

/** Decade ticks for a log10 axis covering positive values [min, max]. */
export function logTicks(min: number, max: number): LinearTicks {
  const safeMin = Math.max(min, 1e-12);
  const safeMax = Math.max(max, safeMin * 10);
  const lo = Math.floor(Math.log10(safeMin));
  const hi = Math.ceil(Math.log10(safeMax));
  const ticks: number[] = [];
  for (let e = lo; e <= hi; e++) ticks.push(Math.pow(10, e));
  return { ticks, min: Math.pow(10, lo), max: Math.pow(10, hi), decimals: 0 };
}

/** Format a decade tick as 1e-3 style. */
export function formatLogTick(v: number): string {
  const e = Math.round(Math.log10(v));
  if (e === 0) return "1";
  return `1e${e}`;
}
