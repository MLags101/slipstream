import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { usePoll } from "./hooks/usePoll";
import { Sidebar } from "./components/Sidebar";
import { NewRunView } from "./components/NewRunView";
import { RunDetailView } from "./components/RunDetailView";

type Route = { view: "new" } | { view: "run"; id: string };

export default function App() {
  const [route, setRoute] = useState<Route>({ view: "new" });
  const [refresh, setRefresh] = useState(0);
  const [detailUnreachable, setDetailUnreachable] = useState(false);

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

  return (
    <div className="app">
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
          onSelect={(id) => setRoute({ view: "run", id })}
          onNew={() => setRoute({ view: "new" })}
          onDelete={handleDelete}
        />
        <main className="main">
          {route.view === "new" ? (
            <NewRunView
              onCreated={(id) => {
                setRefresh((n) => n + 1);
                setRoute({ view: "run", id });
              }}
            />
          ) : (
            <RunDetailView
              key={route.id}
              id={route.id}
              onDelete={handleDelete}
              onUnreachable={setDetailUnreachable}
            />
          )}
        </main>
      </div>
    </div>
  );
}
