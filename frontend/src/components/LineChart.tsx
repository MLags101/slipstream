/**
 * Hand-rolled SVG line chart for convergence data.
 * - linear or log10 y-axis
 * - hairline gridlines, muted axis ink, 2px round-cap series lines
 * - legend (always shown for >= 2 series), hover crosshair + tooltip
 */
import { useMemo, useRef, useState, useEffect } from "react";
import { linearTicks, logTicks, formatLogTick } from "../lib/scale";
import { formatCompact } from "../lib/format";

export interface ChartSeries {
  name: string;
  color: string;
  x: number[];
  y: number[];
}

interface Props {
  title: string;
  series: ChartSeries[];
  yScale?: "linear" | "log";
  height?: number;
  xLabel?: string;
  formatY?: (v: number) => string;
  /** Draw a dot at every data point (for sparse series like sweeps). */
  markers?: boolean;
}

const MARGIN = { top: 12, right: 14, bottom: 30, left: 52 };

export function LineChart({
  title,
  series,
  yScale = "linear",
  height = 220,
  xLabel = "iteration",
  formatY,
  markers = false,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hoverX, setHoverX] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const log = yScale === "log";

  const model = useMemo(() => {
    const visible = series
      .map((s) => {
        const pts: { x: number; y: number }[] = [];
        for (let i = 0; i < Math.min(s.x.length, s.y.length); i++) {
          const y = s.y[i];
          if (!Number.isFinite(y) || (log && y <= 0)) continue;
          pts.push({ x: s.x[i], y });
        }
        return { name: s.name, color: s.color, pts };
      })
      .filter((s) => s.pts.length > 0);

    if (visible.length === 0) return null;

    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const s of visible) {
      for (const p of s.pts) {
        if (p.x < xMin) xMin = p.x;
        if (p.x > xMax) xMax = p.x;
        if (p.y < yMin) yMin = p.y;
        if (p.y > yMax) yMax = p.y;
      }
    }
    if (xMin === xMax) xMax = xMin + 1;

    const yT = log ? logTicks(yMin, yMax) : linearTicks(yMin, yMax, 4);
    const xT = linearTicks(xMin, xMax, 5);
    return { visible, xMin, xMax, xTicks: xT, yTicks: yT };
  }, [series, log]);

  const innerW = Math.max(10, width - MARGIN.left - MARGIN.right);
  const innerH = height - MARGIN.top - MARGIN.bottom;

  const fmtY = formatY ?? (log ? formatLogTick : formatCompact);

  if (!model || width === 0) {
    return (
      <div className="chart" ref={wrapRef}>
        <div className="chart-title">{title}</div>
        <div className="chart-empty" style={{ height }}>
          waiting for data…
        </div>
      </div>
    );
  }

  const { visible, xMin, xMax, xTicks, yTicks } = model;

  const sx = (x: number) =>
    MARGIN.left + ((x - xMin) / (xMax - xMin)) * innerW;
  const sy = (y: number) => {
    if (log) {
      const lo = Math.log10(yTicks.min);
      const hi = Math.log10(yTicks.max);
      return MARGIN.top + innerH - ((Math.log10(y) - lo) / (hi - lo)) * innerH;
    }
    return (
      MARGIN.top +
      innerH -
      ((y - yTicks.min) / (yTicks.max - yTicks.min)) * innerH
    );
  };

  const paths = visible.map((s) => {
    let d = "";
    let pen = false;
    for (const p of s.pts) {
      const cmd = pen ? "L" : "M";
      d += `${cmd}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`;
      pen = true;
    }
    return { ...s, d };
  });

  // Hover: nearest x across all series (they share an iteration axis).
  let hover: { px: number; x: number; rows: { name: string; color: string; y: number }[] } | null =
    null;
  if (hoverX !== null) {
    const dataX = xMin + ((hoverX - MARGIN.left) / innerW) * (xMax - xMin);
    const rows: { name: string; color: string; y: number }[] = [];
    let snapX: number | null = null;
    for (const s of visible) {
      let best: { x: number; y: number } | null = null;
      let bestD = Infinity;
      for (const p of s.pts) {
        const d = Math.abs(p.x - dataX);
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
      if (best) {
        rows.push({ name: s.name, color: s.color, y: best.y });
        if (snapX === null) snapX = best.x;
      }
    }
    if (rows.length > 0 && snapX !== null) {
      hover = { px: sx(snapX), x: snapX, rows };
    }
  }

  const tooltipLeft = hover ? Math.max(0, Math.min(hover.px + 10, width - 150)) : 0;

  return (
    <div className="chart" ref={wrapRef}>
      <div className="chart-head">
        <div className="chart-title">{title}</div>
        {visible.length >= 2 && (
          <div className="chart-legend">
            {visible.map((s) => (
              <span key={s.name} className="legend-item">
                <span className="legend-swatch" style={{ background: s.color }} />
                {s.name}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="chart-plot" style={{ position: "relative" }}>
        <svg
          width={width}
          height={height}
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const px = e.clientX - rect.left;
            setHoverX(px >= MARGIN.left && px <= width - MARGIN.right ? px : null);
          }}
          onMouseLeave={() => setHoverX(null)}
        >
          {/* gridlines + y ticks */}
          {yTicks.ticks.map((t) => (
            <g key={`y${t}`}>
              <line
                x1={MARGIN.left}
                x2={width - MARGIN.right}
                y1={sy(t)}
                y2={sy(t)}
                stroke="var(--grid)"
                strokeWidth={1}
              />
              <text x={MARGIN.left - 7} y={sy(t) + 3.5} textAnchor="end" className="tick">
                {fmtY(t)}
              </text>
            </g>
          ))}
          {/* x ticks */}
          {xTicks.ticks
            .filter((t) => t >= xMin && t <= xMax)
            .map((t) => (
              <text
                key={`x${t}`}
                x={sx(t)}
                y={height - MARGIN.bottom + 16}
                textAnchor="middle"
                className="tick"
              >
                {t}
              </text>
            ))}
          {/* baseline */}
          <line
            x1={MARGIN.left}
            x2={width - MARGIN.right}
            y1={MARGIN.top + innerH}
            y2={MARGIN.top + innerH}
            stroke="var(--axis)"
            strokeWidth={1}
          />
          <text
            x={MARGIN.left + innerW / 2}
            y={height - 4}
            textAnchor="middle"
            className="tick axis-label"
          >
            {xLabel}
          </text>
          {/* series */}
          {paths.map((s) => (
            <path
              key={s.name}
              d={s.d}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}
          {/* point markers */}
          {markers &&
            visible.map((s) =>
              s.pts.map((p, i) => (
                <circle
                  key={`${s.name}-${i}`}
                  cx={sx(p.x)}
                  cy={sy(p.y)}
                  r={3}
                  fill={s.color}
                />
              )),
            )}
          {/* crosshair */}
          {hover && (
            <line
              x1={hover.px}
              x2={hover.px}
              y1={MARGIN.top}
              y2={MARGIN.top + innerH}
              stroke="var(--axis)"
              strokeWidth={1}
            />
          )}
        </svg>
        {hover && (
          <div className="chart-tooltip" style={{ left: tooltipLeft, top: MARGIN.top }}>
            <div className="tooltip-x">iter {hover.x}</div>
            {hover.rows.map((r) => (
              <div key={r.name} className="tooltip-row">
                <span className="legend-swatch" style={{ background: r.color }} />
                <span className="tooltip-name">{r.name}</span>
                <span className="mono">{log ? r.y.toExponential(2) : r.y.toFixed(4)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
