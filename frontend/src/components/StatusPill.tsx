import type { RunStatus } from "../api";

const LABELS: Record<RunStatus, string> = {
  queued: "queued",
  preparing: "preparing",
  meshing: "meshing",
  solving: "solving",
  postprocessing: "post",
  done: "done",
  error: "error",
};

export function StatusPill({ status }: { status: RunStatus }) {
  return <span className={`pill pill-${status}`}>{LABELS[status]}</span>;
}

export const ACTIVE_STATUSES: RunStatus[] = [
  "queued",
  "preparing",
  "meshing",
  "solving",
  "postprocessing",
];

export function isTerminal(status: RunStatus): boolean {
  return status === "done" || status === "error";
}
