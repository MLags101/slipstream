import { useEffect, useRef, useState } from "react";
import { BackendUnreachableError } from "../api";

export interface PollState<T> {
  data: T | null;
  /** Last non-connectivity error (e.g. a 404/409 from the API). */
  error: Error | null;
  /** True while the backend cannot be reached; polling continues. */
  unreachable: boolean;
}

/**
 * Poll `fetcher` every `intervalMs`, starting immediately. Pass `enabled:
 * false` to pause (last data is kept). Overlapping requests are skipped.
 * The fetcher should be memoized (useCallback) — a new identity restarts
 * polling from scratch.
 */
export function usePoll<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
  enabled = true,
): PollState<T> {
  const [state, setState] = useState<PollState<T>>({
    data: null,
    error: null,
    unreachable: false,
  });
  const busy = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const tick = async () => {
      if (busy.current) return;
      busy.current = true;
      try {
        const data = await fetcher();
        if (!cancelled) setState({ data, error: null, unreachable: false });
      } catch (e) {
        if (cancelled) return;
        if (e instanceof BackendUnreachableError) {
          setState((s) => ({ ...s, unreachable: true }));
        } else {
          setState((s) => ({ ...s, error: e as Error }));
        }
      } finally {
        busy.current = false;
      }
    };

    tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [fetcher, intervalMs, enabled]);

  return state;
}
