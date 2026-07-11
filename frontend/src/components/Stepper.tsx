import type { RunStatus } from "../api";

const STAGES: { key: RunStatus; label: string }[] = [
  { key: "queued", label: "Queued" },
  { key: "preparing", label: "Prepare" },
  { key: "meshing", label: "Mesh" },
  { key: "solving", label: "Solve" },
  { key: "postprocessing", label: "Post" },
  { key: "done", label: "Done" },
];

interface Props {
  status: RunStatus;
  progress: number;
  message: string;
}

/** Six-stage pipeline stepper + progress bar + current step message. */
export function Stepper({ status, progress, message }: Props) {
  const errored = status === "error";
  const currentIdx = errored
    ? -1
    : STAGES.findIndex((s) => s.key === status);

  return (
    <div className="stepper-block">
      <div className="stepper">
        {STAGES.map((s, i) => {
          let cls = "step";
          if (!errored) {
            if (i < currentIdx || status === "done") cls += " step-past";
            else if (i === currentIdx) cls += " step-current";
          }
          return (
            <div key={s.key} className={cls}>
              <span className="step-dot" />
              <span className="step-label">{s.label}</span>
              {i < STAGES.length - 1 && <span className="step-line" />}
            </div>
          );
        })}
      </div>
      <div className="progress-track">
        <div
          className={`progress-fill${errored ? " progress-error" : ""}`}
          style={{ width: `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%` }}
        />
      </div>
      <div className="progress-message">
        <span className="mono">{Math.round(progress * 100)}%</span>
        <span>{errored ? "failed" : message}</span>
      </div>
    </div>
  );
}
