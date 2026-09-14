import { useCallback, useEffect, useState } from "react";
import { api, type GroupDetail } from "../api";
import { usePoll } from "../hooks/usePoll";
import { isTerminal, StatusPill } from "./StatusPill";
import { LineChart } from "./LineChart";
import { formatCoeff, formatForce } from "../lib/format";
import { downloadText, sweepToCsv, slugify } from "../lib/download";
import { formatPct, meshSweepHeadline } from "../lib/meshSweep";

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
  const isMesh = group.kind === "mesh";
  const angleOf = (m: (typeof group.runs)[number]) =>
    Math.round((m.angle ?? m.yaw_deg) * 100) / 100;
  // Trim and mesh members arrive in iteration order — keep it. Sweeps sort by angle.
  const members = isTrim || isMesh
    ? [...group.runs]
    : [...group.runs].sort((a, b) => angleOf(a) - angleOf(b));
  const settled = members.filter((m) => isTerminal(m.status)).length;
  const done = members.filter((m) => m.status === "done" && m.cd !== null);
  const trim = group.trim;
  const meshHistory = group.mesh?.history ?? [];
  // Mesh sweeps chart against cell count (millions); sweeps against angle.
  const xOf = (m: (typeof group.runs)[number]) =>
    isMesh ? (m.mesh_cells ?? NaN) / 1e6 : angleOf(m);
  const xLabel = isMesh ? "mesh cells (millions)" : `${param} (deg)`;
  const chartDone = isMesh
    ? done.filter((m) => m.mesh_cells !== null && m.mesh_cells !== undefined)
    : done;
  const memberLabel = (m: (typeof group.runs)[number]) =>
    isMesh ? (m.quality ?? "—") : `${angleOf(m)}°`;

  return (
    <section className="panel">
      <div className="panel-head">
        {isTrim
          ? "Trim solve"
          : isMesh
            ? "Mesh independence"
            : param === "pitch"
              ? "Pitch sweep"
              : "Yaw sweep"}
        <span className="panel-head-meta">
          {group.wind_speed} m/s ·{" "}
          {isMesh ? `tol ${formatPct(group.mesh?.tol_pct)}` : group.quality} ·{" "}
          {settled}/{members.length} finished
        </span>
        {!isTrim && !isMesh && done.length >= 2 && (
          <button
            className="seg sweep-export"
            title="Download sweep as CSV"
            onClick={() =>
              downloadText(
                `${slugify(group.name)}_${param}_sweep.csv`,
                sweepToCsv(param, members),
              )
            }
          >
            export csv
          </button>
        )}
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
      {isMesh && (
        <div className="trim-strip mono">
          {group.mesh?.status === "failed" ? (
            <span className="trim-strip-error">
              {meshSweepHeadline(group.mesh, members.length)}
            </span>
          ) : (
            meshSweepHeadline(group.mesh, members.length)
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
              <span className="sweep-member-yaw mono">{memberLabel(m)}</span>
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
      {chartDone.length >= 2 && (
        <>
          <div className="charts">
            <LineChart
              title={isMesh ? "Cd vs mesh size" : `Cd vs ${param}`}
              xLabel={xLabel}
              markers
              series={[
                {
                  name: "Cd",
                  color: C_BLUE,
                  x: chartDone.map((m) => xOf(m)),
                  y: chartDone.map((m) => m.cd as number),
                },
              ]}
            />
            <LineChart
              title={isMesh ? "Drag vs mesh size" : `Drag vs ${param}`}
              xLabel={xLabel}
              markers
              series={[
                {
                  name: "drag (N)",
                  color: C_AQUA,
                  x: chartDone.map((m) => xOf(m)),
                  // LineChart drops non-finite points.
                  y: chartDone.map((m) => m.drag_N ?? NaN),
                },
              ]}
            />
          </div>
          <div className="sweep-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{isMesh ? "mesh" : param}</th>
                  {isMesh && <th>cells</th>}
                  <th>Cd</th>
                  <th>drag</th>
                  {isMesh && <th>Cd change</th>}
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.id}>
                    <td className="mono">{memberLabel(m)}</td>
                    {isMesh && (
                      <td className="mono">
                        {m.mesh_cells ? m.mesh_cells.toLocaleString("en-US") : "—"}
                      </td>
                    )}
                    <td className="mono">
                      {m.cd !== null ? formatCoeff(m.cd) : "—"}
                    </td>
                    <td className="mono">
                      {m.drag_N !== null ? formatForce(m.drag_N) : "—"}
                    </td>
                    {isMesh && (
                      <td className="mono">
                        {formatPct(
                          meshHistory.find((h) => h.quality === m.quality)?.change_pct,
                        )}
                      </td>
                    )}
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
