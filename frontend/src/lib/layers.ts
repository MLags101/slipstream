import type { LayerOptions, RunResult } from "../api";

/**
 * Prism layer presets. These are the boundary-layer cells snappyHexMesh grows
 * off the walls, and they set y+ — which is what decides whether the k-omega
 * SST wall functions are being used inside their valid range.
 *
 * `settings: null` means "send no layers config", i.e. the backend defaults.
 * Keep "standard" identical to those defaults so the preset round-trips.
 */
export interface LayerPreset {
  id: string;
  label: string;
  hint: string;
  settings: LayerOptions | null;
}

export const LAYER_PRESETS: LayerPreset[] = [
  {
    id: "none",
    label: "None",
    hint: "No layer cells. Fastest and most robust to mesh, but the wall shear — and so the viscous part of drag — is badly resolved.",
    settings: { count: 0 },
  },
  {
    id: "standard",
    label: "Standard — 3 layers",
    hint: "The default. Enough for pressure-dominated bluff bodies like a car or a drone frame.",
    settings: null,
  },
  {
    id: "fine",
    label: "Fine — 6 layers",
    hint: "A thinner first cell for a lower y+. Use for streamlined shapes — wings, hulls, fairings — where skin friction and separation matter.",
    settings: { count: 6, expansion: 1.2, final_thickness: 0.4 },
  },
  {
    id: "veryFine",
    label: "Very fine — 10 layers",
    hint: "Deep stack aimed at the low end of the wall-function range. Slow to mesh and can fail to grow on sharp corners — check the y+ report afterwards.",
    settings: { count: 10, expansion: 1.15, final_thickness: 0.5 },
  },
];

export const CUSTOM_PRESET = "custom";

/** The layer settings the backend applies when none are sent. */
export const LAYER_DEFAULTS: Required<Omit<LayerOptions, "ground">> = {
  count: 3,
  expansion: 1.2,
  final_thickness: 0.3,
  min_thickness: 0.1,
};

/** Allowed ranges; must match foamcase.LAYER_LIMITS. */
export const LAYER_LIMITS: Record<
  keyof typeof LAYER_DEFAULTS,
  [number, number]
> = {
  count: [0, 12],
  expansion: [1.0, 2.0],
  final_thickness: [0.05, 1.0],
  min_thickness: [0.001, 0.5],
};

/**
 * Which preset a config corresponds to, or CUSTOM_PRESET. Used to reopen a
 * rerun on the preset the user originally picked instead of dropping them
 * into "custom".
 */
export function presetIdFor(layers: LayerOptions | undefined): string {
  if (!layers || Object.keys(layers).length === 0) return "standard";
  // `ground` is an independent checkbox, not part of the preset identity.
  const { ground: _ground, ...rest } = layers;
  if (Object.keys(rest).length === 0) return "standard";
  for (const p of LAYER_PRESETS) {
    const want = p.settings ?? LAYER_DEFAULTS;
    const keys = new Set([...Object.keys(want), ...Object.keys(rest)]);
    let same = true;
    for (const k of keys) {
      const a = (want as Record<string, number | undefined>)[k];
      const b = (rest as Record<string, number | undefined>)[k];
      // An unset key means the default, so compare against that.
      const da = a ?? (LAYER_DEFAULTS as Record<string, number>)[k];
      const db = b ?? (LAYER_DEFAULTS as Record<string, number>)[k];
      if (da !== db) {
        same = false;
        break;
      }
    }
    if (same) return p.id;
  }
  return CUSTOM_PRESET;
}

/** Short summary for a run's meta line, e.g. "6 layers, ratio 1.2". */
export function layerLabel(layers: LayerOptions | undefined): string {
  const count = layers?.count ?? LAYER_DEFAULTS.count;
  if (count === 0) return "no boundary layers";
  const ratio = layers?.expansion ?? LAYER_DEFAULTS.expansion;
  const ground = layers?.ground ? " + floor" : "";
  return `${count} layer${count === 1 ? "" : "s"}, ratio ${ratio}${ground}`;
}

/** Wall-function validity band; must match post.Y_PLUS_LOW / Y_PLUS_HIGH. */
export const Y_PLUS_LOW = 30;
export const Y_PLUS_HIGH = 300;

/**
 * Plain-language reading of a run's y+, or null when the run has none (solved
 * before y+ was reported, or postProcess failed). Deliberately blunt: a y+ far
 * outside the band is the single biggest reason a result is wrong, and saying
 * so is more useful than a number the reader has to interpret.
 */
export function yPlusText(result: RunResult): string | null {
  const entry = result.y_plus?.model ?? null;
  if (!entry) return null;
  const avg = entry.average;
  const verdict = result.y_plus_verdict ?? null;
  // Below the band edge a decimal matters — 13 vs 1.3 is a different problem.
  const head = `Average y+ on the model is ${avg.toFixed(
    avg < Y_PLUS_LOW ? 1 : 0,
  )} (range ${entry.min.toFixed(1)}–${entry.max.toFixed(0)}).`;
  if (verdict === "ok")
    return `${head} That is inside the ${Y_PLUS_LOW}–${Y_PLUS_HIGH} band where the wall functions are valid.`;
  if (verdict === "low")
    return (
      `${head} That is below ${Y_PLUS_LOW}, so the first cell sits inside the viscous sublayer — ` +
      "too fine for the wall function but too coarse to resolve the layer properly. " +
      "Skin friction is the part that suffers. Use fewer or thicker layers to raise it."
    );
  if (verdict === "high")
    return (
      `${head} That is above ${Y_PLUS_HIGH}, so the first cell has swallowed the boundary layer ` +
      "and the wall shear is being extrapolated across it. Add layers, or lower the final " +
      "layer thickness, to bring it down."
    );
  return head;
}

/**
 * Per-patch y+ rows for the results table, model first. Returns [] when the
 * run has no y+ data.
 */
export function yPlusRows(
  result: RunResult,
): { patch: string; min: number; max: number; average: number }[] {
  const y = result.y_plus;
  if (!y) return [];
  const names = Object.keys(y).sort((a, b) =>
    a === "model" ? -1 : b === "model" ? 1 : a.localeCompare(b),
  );
  return names.map((patch) => ({ patch, ...y[patch] }));
}
