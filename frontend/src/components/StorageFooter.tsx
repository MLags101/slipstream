import { useCallback, useEffect, useState } from "react";
import { api, type StorageInfo } from "../api";

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}

/** Run-store disk usage + one-click cleanup of finished runs. */
export function StorageFooter({
  refreshKey,
  onPruned,
}: {
  refreshKey: number;
  onPruned: () => void;
}) {
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setInfo(await api.getStorage());
    } catch {
      /* backend down — banner covers it */
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [load, refreshKey]);

  if (!info || info.run_count === 0) return null;

  const prune = async () => {
    if (
      !window.confirm(
        `Delete all finished runs and reclaim ${fmtBytes(info.reclaimable_bytes)}? ` +
          "This cannot be undone.",
      )
    )
      return;
    setBusy(true);
    try {
      await api.pruneRuns();
      await load();
      onPruned();
    } finally {
      setBusy(false);
    }
  };

  const compact = async () => {
    if (
      !window.confirm(
        `Compact finished runs to reclaim ${fmtBytes(info.compactable_bytes)}? ` +
          "Results and saved visualizations are kept; only the meshes are freed, " +
          "so new slice angles and streamlines can't be generated for those runs.",
      )
    )
      return;
    setBusy(true);
    try {
      await api.compactRuns();
      await load();
      onPruned();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="storage-footer">
      <span className="storage-usage mono" title={`${info.run_count} runs on disk`}>
        {fmtBytes(info.total_bytes)} · {info.run_count} run
        {info.run_count === 1 ? "" : "s"}
      </span>
      <div className="storage-actions">
        {info.compactable_bytes > 0 && (
          <button
            className="seg"
            disabled={busy}
            onClick={compact}
            title="Free meshes but keep results and saved views"
          >
            {busy ? "…" : `compact (${fmtBytes(info.compactable_bytes)})`}
          </button>
        )}
        {info.reclaimable_bytes > 0 && (
          <button className="seg storage-clear" disabled={busy} onClick={prune}>
            {busy ? "…" : `clear (${fmtBytes(info.reclaimable_bytes)})`}
          </button>
        )}
      </div>
    </div>
  );
}
