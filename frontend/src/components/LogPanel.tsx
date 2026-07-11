import { useEffect, useRef, useState } from "react";
import type { LogTail } from "../api";

interface Props {
  log: LogTail | null;
  /** Start expanded (e.g. while running / on error). */
  defaultOpen?: boolean;
}

/** Collapsible, auto-scrolling monospace log tail. */
export function LogPanel({ log, defaultOpen = true }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyRef = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);

  // Auto-scroll to bottom on new lines unless the user scrolled up.
  useEffect(() => {
    const el = bodyRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [log?.lines, open]);

  return (
    <section className="panel log-panel">
      <button className="panel-head panel-toggle" onClick={() => setOpen(!open)}>
        <span className={`chevron${open ? " chevron-open" : ""}`}>▸</span>
        <span>Log</span>
        {log && (
          <span className="panel-head-meta mono">
            {log.stage} · {log.total.toLocaleString("en-US")} lines
          </span>
        )}
      </button>
      {open && (
        <pre
          className="log-body mono"
          ref={bodyRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
        >
          {log && log.lines.length > 0 ? log.lines.join("\n") : "no log output yet"}
        </pre>
      )}
    </section>
  );
}
