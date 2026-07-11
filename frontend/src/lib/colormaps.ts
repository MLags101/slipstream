/**
 * Colormaps as pure, unit-testable functions. No three.js imports here.
 * Colors are [r, g, b] triples in 0..1 (ready for BufferGeometry color
 * attributes).
 */

export type RGB = [number, number, number];

function hex(h: string): RGB {
  const n = parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Sample a list of evenly spaced color stops at t in [0,1] (clamped). */
export function sampleStops(stops: RGB[], t: number): RGB {
  if (!Number.isFinite(t)) t = 0;
  const clamped = Math.min(1, Math.max(0, t));
  const x = clamped * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = stops[i];
  const b = stops[i + 1];
  return [lerp(a[0], b[0], f), lerp(a[1], b[1], f), lerp(a[2], b[2], f)];
}

/** Matplotlib viridis, 17 anchor stops, linearly interpolated. */
const VIRIDIS_STOPS: RGB[] = [
  "#440154", "#48186a", "#472d7b", "#424086", "#3b528b", "#33638d",
  "#2c728e", "#26828e", "#21918c", "#1fa088", "#28ae80", "#3fbc73",
  "#5ec962", "#84d44b", "#addc30", "#d8e219", "#fde725",
].map(hex);

export function viridis(t: number): RGB {
  return sampleStops(VIRIDIS_STOPS, t);
}

/** Blue-white-red diverging (cool -> neutral -> warm), midpoint at t=0.5. */
const DIVERGING_STOPS: RGB[] = [
  "#3b4cc0", "#6788ee", "#9abbff", "#c9d7f0", "#f2f0ec",
  "#f2c9b4", "#ee8468", "#d44e41", "#b40426",
].map(hex);

export function divergingBWR(t: number): RGB {
  return sampleStops(DIVERGING_STOPS, t);
}

export type Colormap = (t: number) => RGB;
export type Normalizer = (value: number) => number;

/** Linear normalization of [min, max] -> [0, 1]. Degenerate range -> 0.5. */
export function linearNorm(min: number, max: number): Normalizer {
  const span = max - min;
  if (span <= 0 || !Number.isFinite(span)) return () => 0.5;
  return (v) => Math.min(1, Math.max(0, (v - min) / span));
}

/**
 * Symmetric normalization centered at 0 (for diverging maps): the larger of
 * |min|, |max| sets both arms, so value 0 always lands at t=0.5.
 */
export function symmetricNorm(min: number, max: number): Normalizer {
  const m = Math.max(Math.abs(min), Math.abs(max));
  if (m <= 0 || !Number.isFinite(m)) return () => 0.5;
  return (v) => Math.min(1, Math.max(0, 0.5 + v / (2 * m)));
}

/**
 * Map a per-vertex scalar field to a flat RGB Float32Array suitable for a
 * three.js "color" BufferAttribute (itemSize 3).
 */
export function fieldToVertexColors(
  values: ArrayLike<number>,
  colormap: Colormap,
  norm: Normalizer,
): Float32Array {
  const out = new Float32Array(values.length * 3);
  for (let i = 0; i < values.length; i++) {
    const [r, g, b] = colormap(norm(values[i]));
    out[i * 3] = r;
    out[i * 3 + 1] = g;
    out[i * 3 + 2] = b;
  }
  return out;
}

/** CSS linear-gradient string sampling a colormap (for colorbar legends). */
export function colormapGradientCSS(colormap: Colormap, samples = 24): string {
  const stops: string[] = [];
  for (let i = 0; i < samples; i++) {
    const t = i / (samples - 1);
    const [r, g, b] = colormap(t);
    stops.push(
      `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)}) ${(t * 100).toFixed(1)}%`,
    );
  }
  return `linear-gradient(to top, ${stops.join(", ")})`;
}
