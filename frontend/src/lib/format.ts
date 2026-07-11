/** Display formatting helpers. */

/** 850000 -> "850,000" */
export function formatInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** Seconds -> "9m 00s" / "45s" / "1h 12m" */
export function formatDuration(s: number): string {
  const sec = Math.round(s);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const r = sec % 60;
  if (m < 60) return `${m}m ${String(r).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Frontal area: cm² when it is small (< 0.1 m²), m² otherwise. */
export function formatArea(m2: number): string {
  if (m2 < 0.1) return `${(m2 * 1e4).toFixed(1)} cm²`;
  return `${m2.toFixed(3)} m²`;
}

/** Fixed-decimal coefficient (Cd, Cl, ...). */
export function formatCoeff(v: number, digits = 3): string {
  return v.toFixed(digits);
}

/** Force in newtons with sensible precision. */
export function formatForce(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 100) return `${n.toFixed(0)} N`;
  if (abs >= 1) return `${n.toFixed(2)} N`;
  return `${n.toFixed(3)} N`;
}

/** Compact axis / colorbar number: 0.0012 -> "1.2e-3", 15234 -> "15.2k". */
export function formatCompact(v: number): string {
  if (v === 0) return "0";
  const abs = Math.abs(v);
  if (abs >= 10000) return `${(v / 1000).toFixed(1)}k`;
  if (abs < 0.001) return v.toExponential(1);
  if (abs < 1) return v.toFixed(3);
  if (abs < 10) return v.toFixed(2);
  return v.toFixed(1);
}

/** "quad frame v2.stl" -> "quad frame v2" */
export function nameFromFilename(filename: string): string {
  return filename.replace(/\.stl$/i, "").trim() || "untitled";
}

/** ISO date -> "Jul 10, 14:02" */
export function formatTimestamp(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  if (isNaN(d.getTime())) return String(epochSeconds);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
