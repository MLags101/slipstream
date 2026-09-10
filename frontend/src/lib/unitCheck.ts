/** Catch an STL unit that can't be right, before a run is wasted on it. */

const TO_METERS: Record<string, number> = { mm: 0.001, cm: 0.01, m: 1, in: 0.0254 };

/** Anything smaller than this across is almost certainly the wrong unit. */
const MIN_PLAUSIBLE_M = 0.005;
/** Anything larger than this is beyond what the tunnel is meant for. */
const MAX_PLAUSIBLE_M = 50;

export interface UnitHint {
  /** Largest bounding-box extent in meters under the selected unit. */
  sizeM: number;
  /** Unit that puts the model at a plausible size, or null if none does. */
  suggest: string | null;
}

/**
 * Returns a hint when the model's largest extent under `unit` is implausibly
 * small or large, e.g. a meters-exported frame read as mm is 0.25 mm across.
 * The suggestion is the unit whose size lands closest (in log terms) to 30 cm.
 */
export function unitHint(dims: readonly number[], unit: string): UnitHint | null {
  const scale = TO_METERS[unit];
  const extent = Math.max(...dims);
  if (!scale || !(extent > 0)) return null;
  const sizeM = extent * scale;
  if (sizeM >= MIN_PLAUSIBLE_M && sizeM <= MAX_PLAUSIBLE_M) return null;
  let suggest: string | null = null;
  let best = Infinity;
  for (const [u, s] of Object.entries(TO_METERS)) {
    const m = extent * s;
    if (u === unit || m < MIN_PLAUSIBLE_M || m > MAX_PLAUSIBLE_M) continue;
    const score = Math.abs(Math.log10(m / 0.3));
    if (score < best) {
      best = score;
      suggest = u;
    }
  }
  return { sizeM, suggest };
}

/** Human-readable length: 0.23 mm, 4.2 cm, 12 m. */
export function formatLength(m: number): string {
  if (m < 0.01) return `${+(m * 1000).toPrecision(2)} mm`;
  if (m < 1) return `${+(m * 100).toPrecision(2)} cm`;
  return `${+m.toPrecision(3)} m`;
}
