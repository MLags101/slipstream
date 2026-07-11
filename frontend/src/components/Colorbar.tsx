import { useMemo } from "react";
import { colormapGradientCSS, type Colormap } from "../lib/colormaps";
import { formatCompact } from "../lib/format";

interface Props {
  colormap: Colormap;
  min: number;
  max: number;
  label: string;
  /** Diverging bars also mark the zero midpoint. */
  showZero?: boolean;
}

/** Vertical colorbar legend with numeric min/max for the active field. */
export function Colorbar({ colormap, min, max, label, showZero = false }: Props) {
  const gradient = useMemo(() => colormapGradientCSS(colormap), [colormap]);
  return (
    <div className="colorbar">
      <div className="colorbar-label">{label}</div>
      <div className="colorbar-scale">
        <div className="colorbar-bar" style={{ background: gradient }} />
        <div className="colorbar-ticks mono">
          <span>{formatCompact(max)}</span>
          {showZero && <span>0</span>}
          <span>{formatCompact(min)}</span>
        </div>
      </div>
    </div>
  );
}
