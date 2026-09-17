import type { LayerOptions, LayerTarget, RunResult } from "../api";

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
    id: "target",
    label: "Aim for a y+",
    hint: "Sizes the first cell in millimeters to land at the y+ you ask for, instead of as a fraction of the surface cell. This is the only mode that can actually move y+ into the valid band.",
    settings: { count: 10, expansion: 1.2, target_y_plus: 100 },
  },
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
    hint: "A better-resolved wall layer for streamlined shapes — wings, hulls, fairings — where skin friction and separation matter. Lowers y+ only about a quarter; see the note below.",
    settings: { count: 6, expansion: 1.2, final_thickness: 0.4 },
  },
  {
    id: "veryFine",
    label: "Very fine — 10 layers",
    hint: "Deepest stack. Slow to mesh, and on awkward geometry snappyHexMesh may fail to grow it over the whole surface, which is worse than fewer layers grown cleanly — check the y+ report and the coverage afterwards.",
    settings: { count: 10, expansion: 1.15, final_thickness: 0.5 },
  },
];

export const CUSTOM_PRESET = "custom";

/**
 * What the presets actually do to y+, measured on the Ahmed body.
 *
 * Under snappyHexMesh's relativeSizes the first cell height is
 * `final_thickness / expansion^(count-1)`, a fraction of the surface cell. Across
 * these presets that only spans 100% -> 68%, and y+ scales with it, so no preset
 * shifts y+ by more than about a third. Moving a y+ of 3000 into the 30-300 band
 * needs roughly a 10x thinner first cell, which needs an absolute first-layer
 * height, not a relative one. Until that exists, say so rather than implying the
 * presets can target a y+.
 */
export const LAYER_YPLUS_CAVEAT =
  "Layer presets change y+ by about a third at most. They cannot pull a badly " +
  "out-of-range y+ into the valid band — that needs a finer surface mesh.";

/**
 * The layer settings the backend applies when none are sent. `target_y_plus`
 * has no default: absent means relative sizing, which is the default mode.
 */
export const LAYER_DEFAULTS: Required<
  Omit<LayerOptions, "ground" | "target_y_plus">
> = {
  count: 3,
  expansion: 1.2,
  final_thickness: 0.3,
  min_thickness: 0.1,
};

/** Allowed ranges; must match foamcase.LAYER_LIMITS. */
export const LAYER_LIMITS: Record<
  keyof typeof LAYER_DEFAULTS | "target_y_plus",
  [number, number]
> = {
  target_y_plus: [1, 1000],
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
  // Any y+ target is the target mode, whatever number was asked for.
  if (rest.target_y_plus != null) return "target";
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
 * Below this fraction of faces covered, the stack is patchy enough that the
 * wall treatment varies across the surface. Must match post.LAYER_COVERAGE_LOW.
 */
export const LAYER_COVERAGE_LOW = 70;

/**
 * Warning when snappyHexMesh failed to grow the requested layers over enough
 * of a patch. Measured on the Ahmed body: 62.4% coverage on the floor moved Cd
 * 12% the wrong way, worse than having no layers there at all.
 */
export function layerCoverageWarning(result: RunResult): string | null {
  const cov = result.layer_coverage;
  if (!cov) return null;
  const bad = Object.entries(cov).filter(
    ([, v]) => v.coverage_pct < LAYER_COVERAGE_LOW,
  );
  if (bad.length === 0) return null;
  const parts = bad.map(
    ([patch, v]) =>
      `${patch} got ${v.layers.toFixed(1)} of ${v.layers_requested} layers over ` +
      `${v.coverage_pct.toFixed(0)}% of its faces`,
  );
  return (
    `Prism layers did not grow everywhere: ${parts.join("; ")}. A patchy stack ` +
    "treats the wall differently from place to place, which is worse than having " +
    "no layers at all — ask for fewer layers, or a finer mesh so they fit."
  );
}

/**
 * What a y+ target resolved to, and a warning when some patch's cells are too
 * coarse to reach it. Measured on the Ahmed body: the model reached y+ 109
 * against a target of 100, while the floor — whose cells are ~150x the needed
 * first layer — stalled at y+ 1868 with only 4.3 of 10 layers grown.
 */
export function layerTargetText(
  target: LayerTarget | null | undefined,
): { summary: string; warning: string | null } | null {
  if (!target) return null;
  const mm = target.first_layer_m * 1000;
  const counts = target.counts ?? {};
  const perPatch = Object.entries(counts)
    .map(([p, n]) => `${p} ${n}`)
    .join(", ");
  const summary =
    `Aiming for y+ ${target.target_y_plus}: first layer ${mm.toFixed(3)} mm` +
    (perPatch ? ` · layers ${perPatch}` : "");
  const bad = target.unreachable ?? [];
  if (bad.length === 0) return { summary, warning: null };
  return {
    summary,
    warning:
      `The ${bad.join(" and ")} cells are too coarse to reach y+ ` +
      `${target.target_y_plus}. The layers cannot bridge from a ` +
      `${mm.toFixed(3)} mm first cell up to them, so most of the stack will ` +
      "not grow. Use a finer mesh quality, or accept the y+ reported there.",
  };
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
