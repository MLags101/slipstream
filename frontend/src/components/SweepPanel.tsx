import { useCallback, useEffect, useState } from "react";
import { api, type GroupDetail } from "../api";
import { usePoll } from "../hooks/usePoll";
import { isTerminal, StatusPill } from "./StatusPill";
import { LineChart } from "./LineChart";
import { formatCoeff, formatForce } from "../lib/format";

// Same categorical palette as the convergence charts.
const C_BLUE = "#3987e5";
const C_AQUA = "#199e70";

interface Props {
  groupId: string;
  /** The member currently open in the detail view (highlighted, not clickable). */
  activeRunId: string;
  onSelectRun: (id: string) => void;
}

/**
 * Yaw sweep results for a run's group: member status list, and — once at
 * least two members are done — Cd-vs-yaw + drag-vs-yaw charts with a
 * numeric table. Polls /api/groups/{gid} every ~3s until all members settle.
 */
export function SweepPanel({ groupId, activeRunId, onSelectRun }: Props) {
  const fetchGroup = useCallback(() => api.getGroup(groupId), [groupId]);
  const [group, setGroup] = useState<GroupDetail | null>(null);
  const allSettled =
    group !== null && group.runs.every((r) => isTerminal(r.status));
  const poll = usePoll(fetchGroup, 3000, !allSettled);
  useEffect(() => {
    if (poll.data) setGroup(poll.data);
  }, [poll.data]);

  if (group === null) {
    return (
      <section className="panel">
        <div className="panel-head">Sweep</div>
        <div className="sweep-loading">
          {poll.error
            ? `Failed to load sweep: ${poll.error.message}`
            : "loading sweep…"}
        </div>
      </section>
    );
  }

  const param = group.param ?? "yaw";
  const isTrim = group.kind === "trim";
  const angleOf = (m: (typeof group.runs)[number]) =>
    Math.round((m.angle ?? m.yaw_deg) * 100) / 100;
  // Trim members arrive in iteration order — keep it. Sweeps sort by angle.
  const members = isTrim
    ? [...group.runs]
    : [...group.runs].sort((a, b) => angleOf(a) - angleOf(b));
  const settled = members.filter((m) => isTerminal(m.status)).length;
  const done = members.filter((m) => m.status === "done" && m.cd !== null);
  const trim = group.trim;

  return (
    <section className="panel">
      <div className="panel-head">
        {isTrim ? "Trim solve" : param === "pitch" ? "Pitch sweep" : "Yaw sweep"}
        <span className="panel-head-meta">
          {group.wind_speed} m/s · {group.quality} · {settled}/{members.length}{" "}
          finished
        </span>
      </div>
      {isTrim && trim && (
        <div className="trim-strip mono">
          {trim.converged === null || trim.converged === undefined ? (
            <>trimming… iteration {trim.iterations || members.length}</>
          ) : trim.error ? (
            <span className="trim-strip-error">
              TRIM FAILED after {trim.iterations} iteration
              {trim.iterations === 1 ? "" : "s"} — {trim.error}
            </span>
          ) : (
            <>
              {trim.converged ? "TRIM" : "TRIM (max iterations)"}: tilt{" "}
              {(trim.tilt_deg ?? 0).toFixed(1)}° · thrust{" "}
              {Math.round(trim.thrust_g_per_prop ?? 0)} g/prop · drag{" "}
              {(trim.drag_N ?? 0).toFixed(2)} N
            </>
          )}
        </div>
      )}
      <div className="sweep-members">
        {members.map((m) => {
          const active = m.id === activeRunId;
          return (
            <div
              key={m.id}
              className={`sweep-member${active ? " sweep-member-active" : ""}`}
              onClick={() => !active && onSelectRun(m.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === "Enter" && !active && onSelectRun(m.id)}
            >
              <span className="sweep-member-yaw mono">{angleOf(m)}°</span>
              <StatusPill status={m.status} />
              {m.status === "done" && m.cd !== null && (
                <span className="sweep-member-cd mono">
                  Cd {formatCoeff(m.cd)}
                </span>
              )}
              {!isTerminal(m.status) && (
                <span className="sweep-member-cd mono">
                  {Math.round(m.progress * 100)}%
                </span>
              )}
            </div>
          );
        })}
      </div>
      {done.length >= 2 && (
        <>
          <div className="charts">
            <LineChart
              title={`Cd vs ${param}`}
              xLabel={`${param} (deg)`}
              markers
              series={[
                {
                  name: "Cd",
                  color: C_BLUE,
                  x: done.map((m) => angleOf(m)),
                  y: done.map((m) => m.cd as number),
                },
              ]}
            />
            <LineChart
              title={`Drag vs ${param}`}
              xLabel={`${param} (deg)`}
              markers
              series={[
                {
                  name: "drag (N)",
                  color: C_AQUA,
                  x: done.map((m) => angleOf(m)),
                  // LineChart drops non-finite points.
                  y: done.map((m) => m.drag_N ?? NaN),
                },
              ]}
            />
          </div>
          <div className="sweep-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{param}</th>
                  <th>Cd</th>
                  <th>drag</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.id}>
                    <td className="mono">{angleOf(m)}°</td>
                    <td className="mono">
                      {m.cd !== null ? formatCoeff(m.cd) : "—"}
                    </td>
                    <td className="mono">
                      {m.drag_N !== null ? formatForce(m.drag_N) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
