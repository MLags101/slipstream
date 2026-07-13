import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { usePoll } from "./hooks/usePoll";
import { Sidebar } from "./components/Sidebar";
import { NewRunView } from "./components/NewRunView";
import { RunDetailView } from "./components/RunDetailView";
import { CompareView } from "./components/CompareView";

type Route = { view: "new" } | { view: "run"; id: string } | { view: "compare" };

export default function App() {
  const [route, setRoute] = useState<Route>({ view: "new" });
  const [refresh, setRefresh] = useState(0);
  const [detailUnreachable, setDetailUnreachable] = useState(false);

  // Run comparison: up to two done-run ids picked in the sidebar. Selecting
  // the second opens the compare view; clearing (or dropping below two)
  // leaves it.
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const toggleCompare = useCallback((id: string) => {
    setCompareIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id].slice(-2),
    );
  }, []);
  const clearCompare = useCallback(() => setCompareIds([]), []);
  useEffect(() => {
    if (compareIds.length === 2) setRoute({ view: "compare" });
    else setRoute((r) => (r.view === "compare" ? { view: "new" } : r));
  }, [compareIds]);

  // Run history: poll every ~3s. Bumping `refresh` restarts polling so
  // create/delete show up immediately.
  const listFetcher = useCallback(() => api.listRuns(), [refresh]);
  const list = usePoll(listFetcher, 3000);

  // Cd values for done runs (list items don't carry cd — fetch each result
  // once and cache it).
  const [cdById, setCdById] = useState<Record<string, number>>({});
  const requested = useRef(new Set<string>());
  useEffect(() => {
    if (!list.data) return;
    for (const r of list.data) {
      if (r.status !== "done" || requested.current.has(r.id)) continue;
      requested.current.add(r.id);
      api
        .getResult(r.id)
        .then((res) => setCdById((m) => ({ ...m, [r.id]: res.cd })))
        .catch(() => requested.current.delete(r.id));
    }
  }, [list.data]);

  const backendDown = list.unreachable || detailUnreachable;

  const handleDelete = useCallback(
    async (id: string) => {
      const name = list.data?.find((r) => r.id === id)?.name ?? id;
      if (!window.confirm(`Delete run "${name}"? This removes all its data.`)) return;
      try {
        await api.deleteRun(id);
        setRoute((r) => (r.view === "run" && r.id === id ? { view: "new" } : r));
        setCompareIds((prev) => prev.filter((x) => x !== id));
        setRefresh((n) => n + 1);
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          window.alert("This run is currently executing and can't be deleted.");
        } else {
          window.alert(`Delete failed: ${(e as Error).message}`);
        }
      }
    },
    [list.data],
  );

  const openRun = useCallback((id: string) => setRoute({ view: "run", id }), []);

  // Warn if OpenFOAM isn't installed (fresh machines / packaged app).
  const [foamMissing, setFoamMissing] = useState(false);
  useEffect(() => {
    let stop = false;
    const check = async () => {
      try {
        const r = await fetch("/api/health");
        const h = await r.json();
        if (!stop) setFoamMissing(h.openfoam === null);
      } catch {
        /* backend-down banner covers this */
      }
    };
    void check();
    const t = setInterval(check, 30000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  return (
    <div className="app">
      {foamMissing && !backendDown && (
        <div className="banner-down">
          OpenFOAM not found — runs will fail. Install it with{" "}
          <span className="mono">
            brew install --cask gerlero/openfoam/openfoam
          </span>{" "}
          then relaunch.
        </div>
      )}
      {backendDown && (
        <div className="banner-down">
          Backend unreachable — retrying. Start the server on{" "}
          <span className="mono">localhost:8000</span>.
        </div>
      )}
      <div className="app-body">
        <Sidebar
          runs={list.data}
          activeId={route.view === "run" ? route.id : null}
          cdById={cdById}
          compareIds={compareIds}
          onSelect={openRun}
          onNew={() => setRoute({ view: "new" })}
          onDelete={handleDelete}
          onToggleCompare={toggleCompare}
          onOpenCompare={() => setRoute({ view: "compare" })}
          onClearCompare={clearCompare}
        />
        <main className="main">
          {route.view === "new" && (
            <NewRunView
              onCreated={(id) => {
                setRefresh((n) => n + 1);
                setRoute({ view: "run", id });
              }}
            />
          )}
          {route.view === "compare" && compareIds.length === 2 && (
            <CompareView
              aId={compareIds[0]}
              bId={compareIds[1]}
              onExit={clearCompare}
              onOpenRun={openRun}
            />
          )}
          {route.view === "run" && (
            <RunDetailView
              key={route.id}
              id={route.id}
              onDelete={handleDelete}
              onUnreachable={setDetailUnreachable}
              onSelectRun={openRun}
            />
          )}
        </main>
      </div>
    </div>
  );
}
