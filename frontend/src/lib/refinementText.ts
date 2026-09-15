import type { RefinementInfo, RefinementOptions } from "../api";

/**
 * Suffix for a run's meta line describing its extra mesh refinement, e.g.
 * " · long wake · slipstreams (4 zones, 3.8 mm cells)". Uses what the backend
 * actually meshed when known, otherwise just the requested options.
 */
export function refinementLabel(
  requested: RefinementOptions | undefined,
  meshed: RefinementInfo | null | undefined,
): string {
  const parts: string[] = [];
  if (requested?.long_wake) parts.push("long wake");
  if (requested?.prop_slipstream) {
    const zones = meshed?.slipstreams ?? [];
    if (zones.length) {
      const finest = Math.min(...zones.map((z) => z.cell_mm));
      const n = zones.length;
      parts.push(
        `slipstreams (${n} zone${n === 1 ? "" : "s"}, ${finest.toFixed(1)} mm cells)`,
      );
    } else {
      parts.push("slipstreams");
    }
  }
  return parts.length ? ` · ${parts.join(" · ")}` : "";
}
