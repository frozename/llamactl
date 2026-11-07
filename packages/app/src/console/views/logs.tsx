// #410 P5a-3d, console logs view: a tab-node workload picker whose
// selection is derived from the route (no local selection state), one
// serverStatus poll + serverLogs tail for the selected workload behind
// a status gate, a reconnect-safe masked buffer, and a client-side
// Follow auto-scroll. Unmount (leaving the route) is the teardown:
// tRPC's useSubscription cleanup unsubscribes.

import { skipToken } from "@tanstack/react-query";
import * as React from "react";

import type { StatusDotTone } from "@/ui";
import { Button, StatusDot } from "@/ui";

import type { LogsGate, LogsSelection, LogsState } from "../logs-scope";
import type { ConsoleRoute } from "../router";

import {
  INITIAL_LOGS_STATE,
  logsConnState,
  logsReducer,
  logsStreamGate,
  logsSubscriptionInput,
  logsWorkloadNames,
  selectLogsWorkload,
} from "../logs-scope";
import { useConsoleNode, useNodeTrpc } from "../node-trpc";

const sectionStyle: React.CSSProperties = { display: "grid", gap: 8, padding: 16 };
const secondaryStyle: React.CSSProperties = { fontSize: 12, color: "var(--color-text-secondary)" };
const bufferStyle: React.CSSProperties = {
  maxHeight: 480,
  overflowY: "auto",
  fontFamily: "var(--font-mono, monospace)",
  fontSize: 12,
  background: "var(--color-surface-2)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--r-md, 6px)",
  padding: 8,
};

function connTone(conn: string): StatusDotTone {
  if (conn === "streaming") return "ok";
  if (conn === "reconnecting") return "warn";
  if (conn === "connecting") return "info";
  if (conn === "error") return "err";
  return "idle";
}

function LogLine({ text }: { text: string }): React.JSX.Element {
  return (
    <div data-testid="console-logs-line" style={{ whiteSpace: "pre-wrap" }}>
      {text}
    </div>
  );
}

function LogsBuffer({
  state,
  scrollRef,
}: {
  state: LogsState;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}): React.JSX.Element {
  return (
    <div ref={scrollRef} style={bufferStyle}>
      {state.entries.map((entry, index) =>
        entry.kind === "divider" ? (
          <div
            key={`divider-${String(index)}`}
            data-testid="console-logs-divider"
            style={secondaryStyle}
          >
            reconnected
          </div>
        ) : (
          <LogLine key={`line-${String(index)}`} text={entry.text} />
        ),
      )}
    </div>
  );
}

function LogsStream({ workload, gate }: { workload: string; gate: LogsGate }): React.JSX.Element {
  const trpc = useNodeTrpc();
  const input = React.useMemo(() => logsSubscriptionInput(workload), [workload]);
  const [state, dispatch] = React.useReducer(logsReducer, INITIAL_LOGS_STATE);
  const [follow, setFollow] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  // A gate-off period ends with a brand-new subscription that replays
  // its backfill; the link's own RECONNECT_SIGNAL never fires for it, so
  // the flap itself has to mark the buffer for a fresh start.
  const previousGateRef = React.useRef<LogsGate>(gate);
  React.useEffect(() => {
    const previous = previousGateRef.current;
    previousGateRef.current = gate;
    if (previous === "online" && gate !== "online") {
      dispatch({ type: "gate-off" });
    }
  }, [gate]);
  // skipToken alone pauses the subscription: tRPC's overloads omit
  // `enabled` from the options whenever the input may be skipToken.
  const sub = trpc.serverLogs.useSubscription(gate === "online" ? input : skipToken, {
    onStarted: () => {
      dispatch({ type: "stream-start" });
      setError(null);
    },
    onData: (event) => {
      dispatch({ type: "event", event });
    },
    onError: (err) => {
      setError(err.message);
    },
  });
  const conn = logsConnState(sub.status, error, gate, state.reconnecting === true);

  React.useEffect(() => {
    if (follow && scrollRef.current !== null) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [state.entries, follow]);

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <StatusDot
          data-testid="console-logs-conn"
          data-state={conn}
          tone={connTone(conn)}
          pulse={conn === "streaming" || conn === "connecting" || conn === "reconnecting"}
          label={conn}
        />
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12 }}>
          <input
            type="checkbox"
            aria-label="Follow"
            checked={follow}
            onChange={(event) => {
              setFollow(event.target.checked);
            }}
          />
          Follow
        </label>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            dispatch({ type: "clear" });
          }}
        >
          Clear
        </Button>
      </div>
      {gate === "offline" ? (
        <div data-testid="console-logs-offline" style={secondaryStyle}>
          Server offline
        </div>
      ) : gate === "error" ? (
        <div data-testid="console-logs-gate-error" style={secondaryStyle}>
          Server status unavailable
        </div>
      ) : (
        <LogsBuffer state={state} scrollRef={scrollRef} />
      )}
      {error !== null ? (
        <div data-testid="console-logs-error" style={{ fontSize: 12, color: "var(--color-err)" }}>
          {error}
        </div>
      ) : null}
    </div>
  );
}

function LogsNotice({
  listError,
  selection,
  routeWorkload,
  tabNode,
}: {
  listError: boolean;
  selection: LogsSelection;
  routeWorkload: string | undefined;
  tabNode: string;
}): React.JSX.Element | null {
  if (listError) {
    return (
      <div data-testid="console-logs-list-error" style={secondaryStyle}>
        Could not load workloads
      </div>
    );
  }
  if (selection.kind === "pending") {
    return (
      <div data-testid="console-logs-pending" style={secondaryStyle}>
        Loading workloads…
      </div>
    );
  }
  if (selection.kind === "elsewhere") {
    return (
      <div style={secondaryStyle}>
        <p style={{ margin: 0 }}>{selection.message}</p>
        <a href={selection.href}>{`Open ${routeWorkload ?? ""} on ${selection.node}`}</a>
      </div>
    );
  }
  if (selection.kind === "missing") {
    return <div style={secondaryStyle}>{`No workload named ${selection.name} on this node`}</div>;
  }
  if (selection.kind === "none") {
    return <div style={secondaryStyle}>{`No workloads on ${tabNode}`}</div>;
  }
  return null;
}

export function LogsView({
  route,
  onSelectWorkload,
}: {
  route: ConsoleRoute;
  onSelectWorkload: (name: string) => void;
}): React.JSX.Element {
  const trpc = useNodeTrpc();
  const tabNode = useConsoleNode();
  const list = trpc.workloadList.useQuery();
  const selection = selectLogsWorkload(list.data, route.workload, tabNode);
  const name = selection.kind === "selected" ? selection.name : null;
  const status = trpc.serverStatus.useQuery(name === null ? skipToken : { workload: name }, {
    enabled: name !== null,
    refetchInterval: 5000,
  });
  const optionNames = logsWorkloadNames(Array.isArray(list.data) ? list.data : [], tabNode);
  return (
    <section data-testid="console-view-logs" style={sectionStyle}>
      <select
        aria-label="Logs workload"
        value={name ?? ""}
        onChange={(event) => {
          const next = event.target.value;
          if (next !== "") {
            onSelectWorkload(next);
          }
        }}
      >
        {name === null ? (
          <option value="" disabled>
            Select a workload
          </option>
        ) : null}
        {optionNames.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      <LogsNotice
        listError={list.isError}
        selection={selection}
        routeWorkload={route.workload}
        tabNode={tabNode}
      />
      {name !== null ? (
        <LogsStream key={`${tabNode}\u0000${name}`} workload={name} gate={logsStreamGate(status)} />
      ) : null}
    </section>
  );
}
