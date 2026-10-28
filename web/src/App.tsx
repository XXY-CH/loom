import { useCallback, useEffect, useMemo, useState } from "react";
import {
  consumeEventStream,
  createApi,
  openEventStream,
  SSE_RETRY_DELAY_MS,
} from "./api.js";
import { ConnectForm } from "./ConnectForm.js";
import { RunDetail } from "./RunDetail.js";
import { RunList } from "./RunList.js";
import { StartForm } from "./StartForm.js";
import {
  type Connection,
  clearConnection,
  readConnection,
  saveConnection,
} from "./session.js";
import type { RunSummary } from "./types.js";

/** Subscribes to the SSE snapshot stream with automatic reconnection. */
function useRunSnapshots(connection: Connection): {
  runs: RunSummary[] | null;
  live: boolean;
} {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [live, setLive] = useState(false);
  useEffect(() => {
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const loop = async () => {
      while (!stopped) {
        try {
          const response = await openEventStream(
            connection.base,
            connection.token,
            controller.signal,
          );
          setLive(true);
          await consumeEventStream(response, (payload) => {
            if (Array.isArray(payload)) setRuns(payload as RunSummary[]);
          });
        } catch {
          // Stream ended or failed: fall through to the retry below.
        }
        if (stopped) return;
        setLive(false);
        await new Promise<void>((resolve) => {
          retry = setTimeout(resolve, SSE_RETRY_DELAY_MS);
        });
      }
    };
    void loop();
    return () => {
      stopped = true;
      controller.abort();
      if (retry) clearTimeout(retry);
    };
  }, [connection]);
  return { runs, live };
}

const RUN_ID_IN_HASH = /^#\/runs\/([A-Za-z0-9][A-Za-z0-9_-]{0,79})$/;

/** Hash-only routing (#/runs/<id>): history-API paths would collide with the
 * service's own /runs endpoints, so the URL path stays untouched. */
function useSelectedRunId(): [string | null, (runId: string) => void] {
  const [runId, setRunId] = useState<string | null>(() => {
    const match = RUN_ID_IN_HASH.exec(window.location.hash);
    return match?.[1] ?? null;
  });
  useEffect(() => {
    const onHashChange = () => {
      const match = RUN_ID_IN_HASH.exec(window.location.hash);
      setRunId(match?.[1] ?? null);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  const select = useCallback((next: string) => {
    window.location.hash = `#/runs/${next}`;
    setRunId(next);
  }, []);
  return [runId, select];
}

function Workbench({
  connection,
  onDisconnect,
}: {
  connection: Connection;
  onDisconnect: () => void;
}) {
  const { runs, live } = useRunSnapshots(connection);
  const [selectedId, select] = useSelectedRunId();
  const [starting, setStarting] = useState(false);
  const api = useMemo(
    () => createApi(connection.base, connection.token),
    [connection],
  );
  const selected = useMemo(
    () => runs?.find((run) => run.runId === selectedId) ?? null,
    [runs, selectedId],
  );
  const onSelect = useCallback(
    (runId: string) => {
      setStarting(false);
      select(runId);
    },
    [select],
  );
  return (
    <div className="workbench">
      <header className="workbench-header">
        <h1>Loom Workbench</h1>
        <span>{connection.base}</span>
        <span data-testid="connection-state">
          {live ? "live" : runs ? "reconnecting" : "connecting"}
        </span>
        <button type="button" onClick={() => setStarting((open) => !open)}>
          Start run…
        </button>
        <button type="button" onClick={onDisconnect}>
          Disconnect
        </button>
      </header>
      <div className="workbench-body">
        <RunList
          runs={runs ?? []}
          selectedId={selectedId}
          onSelect={onSelect}
        />
        {starting ? (
          <StartForm api={api} onCancel={() => setStarting(false)} />
        ) : selected ? (
          <RunDetail key={selected.runId} run={selected} api={api} />
        ) : (
          <p data-testid="run-detail-empty">Select a run to inspect it.</p>
        )}
      </div>
    </div>
  );
}

export function App() {
  const [connection, setConnection] = useState<Connection | null>(() =>
    readConnection(),
  );
  const connect = (next: Connection) => {
    saveConnection(next);
    setConnection(next);
  };
  const disconnect = () => {
    clearConnection();
    window.location.hash = "";
    setConnection(null);
  };
  if (!connection) return <ConnectForm onConnect={connect} />;
  return <Workbench connection={connection} onDisconnect={disconnect} />;
}
