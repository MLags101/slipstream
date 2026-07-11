import type { RunSummary } from "../api";
import { StatusPill } from "./StatusPill";
import { formatCoeff, formatTimestamp } from "../lib/format";

interface Props {
  runs: RunSummary[] | null;
  activeId: string | null;
  /** Cd values for done runs (fetched lazily by App). */
  cdById: Record<string, number>;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}

export function Sidebar({ runs, activeId, cdById, onSelect, onNew, onDelete }: Props) {
  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="brand">
          <span className="brand-mark">⌁</span> WindTunnel
        </div>
        <button className="btn btn-primary btn-block" onClick={onNew}>
          + New run
        </button>
      </div>
      <div className="run-list">
        {runs === null && <div className="run-list-empty">loading runs…</div>}
        {runs !== null && runs.length === 0 && (
          <div className="run-list-empty">
            No runs yet.
            <br />
            Drop an STL to get started.
          </div>
        )}
        {runs?.map((r) => (
          <div
            key={r.id}
            className={`run-item${r.id === activeId ? " run-item-active" : ""}`}
            onClick={() => onSelect(r.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === "Enter" && onSelect(r.id)}
          >
            <div className="run-item-top">
              <span className="run-item-name" title={r.name}>
                {r.name}
              </span>
              <button
                className="icon-btn run-item-delete"
                title="Delete run"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(r.id);
                }}
              >
                ✕
              </button>
            </div>
            <div className="run-item-bottom">
              <StatusPill status={r.status} />
              {r.status === "done" && cdById[r.id] !== undefined && (
                <span className="run-item-cd mono">
                  Cd {formatCoeff(cdById[r.id])}
                </span>
              )}
              {r.status !== "done" && r.status !== "error" && (
                <span className="run-item-cd mono">
                  {Math.round(r.progress * 100)}%
                </span>
              )}
              <span className="run-item-date">{formatTimestamp(r.created_at)}</span>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}
