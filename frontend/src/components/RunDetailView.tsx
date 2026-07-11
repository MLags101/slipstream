import { useCallback, useEffect, useState } from "react";
import { api, type History, type LogTail, type RunDetail } from "../api";
import { usePoll } from "../hooks/usePoll";
import { isTerminal } from "./StatusPill";
import { StatusPill } from "./StatusPill";
import { Stepper } from "./Stepper";
import { LogPanel } from "./LogPanel";
import { LineChart } from "./LineChart";
import { ResultsPanel } from "./ResultsPanel";
import { ResultViewer } from "./ResultViewer";

interface Props {
  id: string;
  onDelete: (id: string) => void;
  onUnreachable: (down: boolean) => void;
}

// Chart series colors — validated 4-slot dark categorical palette.
const C_BLUE = "#3987e5";
const C_AQUA = "#199e70";
const C_YELLOW = "#c98500";
const C_VIOLET = "#9085e9";

export function RunDetailView({ id, onDelete, onUnreachable }: Props) {
  const fetchRun = useCallback(() => api.getRun(id), [id]);

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
        <div className="detail-title">
          <h1>{run.name}</h1>
          <StatusPill status={run.status} />
        </div>
        <div className="detail-meta mono">
          {run.config.wind_speed} m/s · yaw {run.config.yaw_deg}° · {run.config.quality}
          {run.model && ` · ${run.model.triangles.toLocaleString("en-US")} tris`}
        </div>
        <button className="btn btn-danger btn-sm" onClick={() => onDelete(id)}>
          Delete
        </button>
      </header>

      {run.status === "error" && (
        <div className="error-banner">
          <div className="error-title">Run failed</div>
          <div className="mono">{run.error ?? "unknown error"}</div>
        </div>
      )}

      <Stepper status={run.status} progress={run.progress} message={run.message} />

      {run.status === "done" && run.result && (
        <>
          <ResultsPanel result={run.result} />
          <ResultViewer runId={id} config={run.config} model={run.model} />
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
