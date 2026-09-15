import { useCallback, useEffect, useRef, useState } from "react";
import { api, type History, type LogTail, type RunDetail } from "../api";
import { usePoll } from "../hooks/usePoll";
import { shortRunId } from "../lib/format";
import { refinementLabel } from "../lib/refinementText";
import { ResolvePanel } from "./ResolvePanel";
import { isTerminal } from "./StatusPill";
import { StatusPill } from "./StatusPill";
import { Stepper } from "./Stepper";
import { LogPanel } from "./LogPanel";
import { LineChart } from "./LineChart";
import { ResultsPanel } from "./ResultsPanel";
import { ResultViewer } from "./ResultViewer";
import { SweepPanel } from "./SweepPanel";

interface Props {
  id: string;
  onDelete: (id: string) => void;
  onUnreachable: (down: boolean) => void;
  /** Navigate to a sibling run (yaw sweep member list). */
  onSelectRun: (id: string) => void;
  /** Resubmit this run's exact config as a new run. */
  onRerun: (id: string) => void;
  /** The run was renamed: refresh the run list. */
  onRenamed: () => void;
}

// Chart series colors — validated 4-slot dark categorical palette.
const C_BLUE = "#3987e5";
const C_AQUA = "#199e70";
const C_YELLOW = "#c98500";
const C_VIOLET = "#9085e9";

export function RunDetailView({
  id,
  onDelete,
  onUnreachable,
  onSelectRun,
  onRerun,
  onRenamed,
}: Props) {
  const fetchRun = useCallback(() => api.getRun(id), [id]);
  const [cancelling, setCancelling] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const renameInput = useRef<HTMLInputElement>(null);
  const renameOpen = renaming !== null;
  // Focus the box and select the old name when the form opens, so typing
  // replaces it (autoFocus runs before an onFocus handler could select).
  useEffect(() => {
    if (renameOpen) renameInput.current?.select();
  }, [renameOpen]);
  useEffect(() => {
    setResolving(false);
    setRenaming(null);
    setRenameError(null);
  }, [id]);

  const saveName = async () => {
    if (renaming === null) return;
    const name = renaming.trim();
    if (!name) {
      setRenameError("Name can't be empty");
      return;
    }
    try {
      setSnapshot(await api.renameRun(id, name));
      setRenaming(null);
      setRenameError(null);
      onRenamed();
    } catch (err) {
      setRenameError(`Rename failed: ${(err as Error).message}`);
    }
  };

  const [snapshot, setSnapshot] = useState<RunDetail | null>(null);
  const terminal = snapshot !== null && isTerminal(snapshot.status);

  // Poll run detail every 1.5s while not done/error (the tick that reveals
  // the terminal status is the last one).
  const poll = usePoll(fetchRun, 1500, !terminal);
  useEffect(() => {
    if (poll.data) setSnapshot(poll.data);
  }, [poll.data]);
  useEffect(() => onUnreachable(poll.unreachable), [poll.unreachable, onUnreachable]);
  // Don't leave a stale "backend down" flag behind when navigating away.
  useEffect(() => () => onUnreachable(false), [onUnreachable]);

  const running = snapshot !== null && !terminal;

  // Log tail: poll while running; fetch once more after the run ends (and
  // once on mount for already-finished runs).
  const [log, setLog] = useState<LogTail | null>(null);
  useEffect(() => {
    if (snapshot === null) return;
    let cancelled = false;
    const load = async () => {
      try {
        const l = await api.getLog(id, 200);
        if (!cancelled) setLog(l);
      } catch {
        /* log may not exist yet */
      }
    };
    void load();
    if (!running) return;
    const t = setInterval(load, 1500);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [id, running, snapshot === null]);

  // Convergence history: poll ~2s while running, final fetch when finished.
  const [history, setHistory] = useState<History | null>(null);
  useEffect(() => {
    if (snapshot === null) return;
    let cancelled = false;
    const load = async () => {
      try {
        const h = await api.getHistory(id);
        if (!cancelled && h.iters) setHistory(h);
      } catch {
        /* not available before solving */
      }
    };
    void load();
    if (!running) return;
    const t = setInterval(load, 2000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [id, running, snapshot === null]);

  if (snapshot === null) {
    return (
      <div className="detail detail-loading">
        {poll.error ? `Failed to load run: ${poll.error.message}` : "loading run…"}
      </div>
    );
  }

  const run = snapshot;
  const hasHistory = history !== null && history.iters.length > 0;
  const hasResiduals =
    history !== null && history.residuals && history.residuals.iters.length > 0;

  return (
    <div className="detail">
      <header className="detail-header">
        {renaming === null ? (
          <div className="detail-title">
            <h1>{run.name}</h1>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setRenaming(run.name)}
              title="Rename this run"
            >
              Rename
            </button>
            <StatusPill status={run.status} />
          </div>
        ) : (
          <form
            className="detail-rename"
            onSubmit={(e) => {
              e.preventDefault();
              void saveName();
            }}
          >
            <input
              className="mono"
              value={renaming}
              maxLength={200}
              ref={renameInput}
              aria-label="Run name"
              onChange={(e) => setRenaming(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setRenaming(null);
                if (e.key === "Enter") {
                  e.preventDefault();
                  void saveName();
                }
              }}
            />
            <button type="submit" className="btn btn-primary btn-sm">
              Save
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setRenaming(null)}
            >
              Cancel
            </button>
            {renameError && <span className="form-error">{renameError}</span>}
          </form>
        )}
        <div className="detail-meta mono">
          <span title={`Run ID ${run.id}`}>#{shortRunId(run.id)}</span> ·{" "}
          {run.config.wind_speed} m/s · yaw {run.config.yaw_deg}° · {run.config.quality}
          {refinementLabel(run.config.refinement, run.refinement)}
          {run.model && ` · ${run.model.triangles.toLocaleString("en-US")} tris`}
        </div>
        <div className="detail-actions">
          {running && (
            <button
              className="btn btn-danger btn-sm"
              disabled={cancelling}
              onClick={async () => {
                setCancelling(true);
                try {
                  await api.cancelRun(id);
                } finally {
                  setCancelling(false);
                }
              }}
            >
              {cancelling ? "Cancelling…" : "Cancel"}
            </button>
          )}
          {terminal && (
            <button className="btn btn-sm" onClick={() => onRerun(id)}>
              Re-run
            </button>
          )}
          {terminal && run.has_mesh && (
            <button
              className="btn btn-sm"
              onClick={() => setResolving((v) => !v)}
              title="Solve again with a new wind speed or thrust, reusing this mesh"
            >
              Re-solve…
            </button>
          )}
          <button className="btn btn-danger btn-sm" onClick={() => onDelete(id)}>
            Delete
          </button>
        </div>
      </header>

      {resolving && terminal && run.has_mesh && (
        <ResolvePanel
          run={run}
          onCreated={(newId) => {
            setResolving(false);
            onSelectRun(newId);
          }}
          onClose={() => setResolving(false)}
        />
      )}

      {run.config.mesh_from && (
        <div className="config-note">
          Re-solved on the mesh from{" "}
          <button className="btn btn-ghost btn-sm" onClick={() => onSelectRun(run.config.mesh_from!)}>
            {run.config.resolve_base_name ?? "the original run"}
          </button>
        </div>
      )}

      {run.model?.watertight === false && (
        <div className="warn-banner">
          ⚠ This STL isn't watertight (open or non-manifold surface). It may mesh
          poorly or fail — load it in New run and use <b>repair model</b> to rebuild
          it as a closed solid, or fix it in your CAD.
        </div>
      )}

      {(run.status === "error" || run.status === "cancelled") && (
        <div className={`error-banner${run.status === "cancelled" ? " cancel-banner" : ""}`}>
          <div className="error-title">
            {run.status === "cancelled" ? "Run cancelled" : "Run failed"}
          </div>
          {run.error && <div className="mono">{run.error}</div>}
        </div>
      )}

      <Stepper status={run.status} progress={run.progress} message={run.message} />

      {run.group_id && (
        <SweepPanel
          groupId={run.group_id}
          activeRunId={id}
          onSelectRun={onSelectRun}
        />
      )}

      {run.status === "done" && run.result && (
        <>
          <ResultsPanel result={run.result} name={run.name} />
          <ResultViewer
            runId={id}
            config={run.config}
            model={run.model}
            props={run.props_m}
          />
        </>
      )}

      {(hasHistory || hasResiduals) && (
        <section className="panel">
          <div className="panel-head">Convergence</div>
          <div className="charts">
            {hasHistory && (
              <LineChart
                title="Force coefficients"
                xLabel="iteration"
                series={[
                  { name: "Cd", color: C_BLUE, x: history.iters, y: history.cd },
                  { name: "Cl", color: C_AQUA, x: history.iters, y: history.cl },
                ]}
              />
            )}
            {hasResiduals && (
              <LineChart
                title="Residuals"
                xLabel="iteration"
                yScale="log"
                series={[
                  { name: "p", color: C_BLUE, x: history.residuals.iters, y: history.residuals.p },
                  { name: "Ux", color: C_AQUA, x: history.residuals.iters, y: history.residuals.Ux },
                  { name: "k", color: C_YELLOW, x: history.residuals.iters, y: history.residuals.k },
                  { name: "ω", color: C_VIOLET, x: history.residuals.iters, y: history.residuals.omega },
                ]}
              />
            )}
          </div>
        </section>
      )}

      <LogPanel
        log={log}
        defaultOpen={run.status !== "done"}
        key={`log-${run.status === "done" ? "done" : "open"}`}
      />
    </div>
  );
}
