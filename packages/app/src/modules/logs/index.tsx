import { skipToken } from "@tanstack/react-query";
import * as React from "react";
import { useEffect, useRef, useState } from "react";

import { useActiveWorkload } from "@/hooks/useActiveWorkload";
import { trpc } from "@/lib/trpc";
import { Button, StatusDot } from "@/ui";
import type { StatusDotTone } from "@/ui";

const MAX_BUFFER_LINES = 2000;

type ConnState = "connecting" | "live" | "error" | "idle";

interface LogStreamResult {
  lines: string[];
  setLines: React.Dispatch<React.SetStateAction<string[]>>;
  follow: boolean;
  setFollow: React.Dispatch<React.SetStateAction<boolean>>;
  historyLines: number;
  setHistoryLines: React.Dispatch<React.SetStateAction<number>>;
  subKey: number;
  setSubKey: React.Dispatch<React.SetStateAction<number>>;
  autoscroll: boolean;
  setAutoscroll: React.Dispatch<React.SetStateAction<boolean>>;
  error: string | null;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  conn: ConnState;
  setConn: React.Dispatch<React.SetStateAction<ConnState>>;
  workload: string | undefined;
  workloadLoading: boolean;
  serverDown: boolean;
}

interface LogLineEvent {
  type: string;
  line: string;
}

function useLogStream(): LogStreamResult {
  const [lines, setLines] = useState<string[]>([]);
  const [follow, setFollow] = useState(true);
  const [historyLines, setHistoryLines] = useState(200);
  const [subKey, setSubKey] = useState(0);
  const [autoscroll, setAutoscroll] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [conn, setConn] = useState<ConnState>("connecting");
  const { workload, loading: workloadLoading } = useActiveWorkload();

  const serverStatus = trpc.serverStatus.useQuery(workload ? { workload } : skipToken, {
    refetchInterval: 5000,
    enabled: !!workload,
  });
  const serverDown = serverStatus.data?.state === "down";

  trpc.serverLogs.useSubscription(
    workload ? { workload, lines: historyLines, follow } : skipToken,
    {
      enabled: !!workload && !serverDown,
      onStarted: () => {
        setConn(follow ? "live" : "idle");
        setError(null);
      },
      onData: (evt: unknown) => {
        const e = evt as LogLineEvent;
        if (e.type === "line" && typeof e.line === "string") {
          setLines((prev) => {
            const next = [...prev, e.line];
            return next.length > MAX_BUFFER_LINES ? next.slice(-MAX_BUFFER_LINES) : next;
          });
        }
      },
      onError: (err: { message: string }) => {
        setError(err.message);
        setConn("error");
      },
      // The sub key forces the hook to tear down and recreate the
      // subscription when the user toggles follow or changes the
      // history window — tRPC v11 only re-subscribes when the input
      // identity changes, so we bump a counter to kick it.
      key: subKey,
    } as Parameters<typeof trpc.serverLogs.useSubscription>[1],
  );

  return {
    lines,
    setLines,
    follow,
    setFollow,
    historyLines,
    setHistoryLines,
    subKey,
    setSubKey,
    autoscroll,
    setAutoscroll,
    error,
    setError,
    conn,
    setConn,
    workload: workload ?? undefined,
    workloadLoading,
    serverDown,
  };
}

function LogInfo({ s }: { s: LogStreamResult }): React.JSX.Element {
  return (
    <div>
      <h1 style={{ fontSize: 18, fontWeight: 600 }}>Logs</h1>
      <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
        {s.serverDown ? (
          <span>Server offline</span>
        ) : (
          <>
            Tailing{" "}
            <span style={{ fontFamily: "var(--font-mono)" }}>{s.workload}/llama-server.log</span>
          </>
        )}
        {s.error && (
          <span style={{ marginLeft: 8, color: "var(--color-err)" }}>· error: {s.error}</span>
        )}
      </div>
    </div>
  );
}

function LogControls({ s }: { s: LogStreamResult }): React.JSX.Element {
  const connTone: StatusDotTone =
    s.conn === "live"
      ? "ok"
      : s.conn === "error"
        ? "err"
        : s.conn === "connecting"
          ? "info"
          : "idle";
  const connLabel =
    s.conn === "live"
      ? "streaming"
      : s.conn === "error"
        ? "error"
        : s.conn === "connecting"
          ? "connecting"
          : "idle";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 12 }}>
      <StatusDot
        tone={connTone}
        pulse={s.conn === "live" || s.conn === "connecting"}
        label={connLabel}
      />
      <label style={{ display: "flex", gap: 4 }}>
        <input
          type="checkbox"
          checked={s.follow}
          onChange={(e) => {
            s.setFollow(e.target.checked);
            s.setConn("connecting");
            s.setSubKey((k) => k + 1);
          }}
        />
        follow
      </label>
      <label style={{ display: "flex", gap: 4 }}>
        history
        <input
          type="number"
          min={0}
          max={1000}
          step={50}
          value={s.historyLines}
          onChange={(e) => {
            s.setHistoryLines(Number(e.target.value) || 0);
          }}
          style={{ width: 60, textAlign: "right" }}
        />
      </label>
      <label style={{ display: "flex", gap: 4 }}>
        <input
          type="checkbox"
          checked={s.autoscroll}
          onChange={(e) => {
            s.setAutoscroll(e.target.checked);
          }}
        />
        autoscroll
      </label>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => {
          s.setLines([]);
          s.setError(null);
          s.setConn("connecting");
          s.setSubKey((k) => k + 1);
        }}
      >
        Reconnect
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          s.setLines([]);
          s.setError(null);
        }}
      >
        Clear
      </Button>
    </div>
  );
}

function LogHeader({ s }: { s: LogStreamResult }): React.JSX.Element {
  return (
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
      <LogInfo s={s} />
      <LogControls s={s} />
    </div>
  );
}

function LogTerminal({ s }: { s: LogStreamResult }): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (s.autoscroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [s.lines, s.autoscroll]);

  return (
    <div
      ref={scrollRef}
      style={{
        flex: 1,
        overflow: "auto",
        borderRadius: "var(--r-md)",
        border: "1px solid var(--color-border)",
        background: "var(--color-surface-0)",
        padding: 8,
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        marginTop: 12,
      }}
    >
      {!s.workload && !s.workloadLoading ? (
        <div style={{ color: "var(--color-text-secondary)" }}>No active workload.</div>
      ) : s.serverDown ? (
        <div style={{ color: "var(--color-text-secondary)" }}>Server offline.</div>
      ) : s.lines.length === 0 ? (
        <div style={{ color: "var(--color-text-secondary)" }}>(no log lines yet)</div>
      ) : (
        s.lines.map((line, i) => (
          <div key={i} style={{ whiteSpace: "pre-wrap" }}>
            {line}
          </div>
        ))
      )}
    </div>
  );
}

export default function Logs(): React.JSX.Element {
  const s = useLogStream();
  return (
    <div
      style={{ display: "flex", height: "100%", flexDirection: "column", padding: 24 }}
      data-testid="logs-root"
    >
      <LogHeader s={s} />
      <LogTerminal s={s} />
    </div>
  );
}
