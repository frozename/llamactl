import { skipToken, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";

import { useActiveWorkload } from "@/hooks/useActiveWorkload";
import { trpc } from "@/lib/trpc";

import type { LogLine } from "./types";

import { MAX_LOG_LINES } from "./types";

export interface UseServerControlReturn {
  workload: string | null | undefined;
  workloadLoading: boolean;
  status: ReturnType<typeof trpc.serverStatus.useQuery>;
  catalog: ReturnType<typeof trpc.catalogList.useQuery>;
  env: ReturnType<typeof trpc.env.useQuery>;
  target: string;
  setTarget: (v: string) => void;
  timeoutSeconds: number;
  setTimeoutSeconds: (v: number) => void;
  skipTuned: boolean;
  setSkipTuned: (v: boolean) => void;
  starting: { target: string; timeoutSeconds: number; skipTuned: boolean } | null;
  log: LogLine[];
  error: string | null;
  setError: (v: string | null) => void;
  logRef: React.RefObject<HTMLDivElement | null>;
  onStart: () => void;
  stopMutation: ReturnType<typeof trpc.serverStop.useMutation>;
  keepAliveStatus: ReturnType<typeof trpc.keepAliveStatus.useQuery>;
  keepAliveStartMutation: ReturnType<typeof trpc.keepAliveStart.useMutation>;
  keepAliveStopMutation: ReturnType<typeof trpc.keepAliveStop.useMutation>;
  rels: string[];
}

export function useServerControl(): UseServerControlReturn {
  const queryClient = useQueryClient();
  const { workload, loading: workloadLoading } = useActiveWorkload();
  const status = trpc.serverStatus.useQuery(workload ? { workload } : skipToken, {
    refetchInterval: 5000,
    enabled: !!workload,
  });
  const catalog = trpc.catalogList.useQuery("all");
  const env = trpc.env.useQuery();
  const [target, setTarget] = useState("current");
  const [timeoutSeconds, setTimeoutSeconds] = useState(60);
  const [skipTuned, setSkipTuned] = useState(false);
  const [starting, setStarting] = useState<{
    target: string;
    timeoutSeconds: number;
    skipTuned: boolean;
  } | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  const appendLog = (line: LogLine): void => {
    setLog((prev) => {
      const next = [...prev, line];
      return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next;
    });
    requestAnimationFrame(() => {
      if (logRef.current) {
        logRef.current.scrollTop = logRef.current.scrollHeight;
      }
    });
  };

  useServerStartSubscription({
    starting,
    workload: workload ?? undefined,
    setStarting,
    setError,
    appendLog,
    queryClient,
  });

  const onResetStart = (): void => {
    setLog([]);
    setError(null);
    setStarting({ target: target.trim(), timeoutSeconds, skipTuned });
  };

  return {
    workload,
    workloadLoading,
    status,
    catalog,
    env,
    target,
    setTarget,
    timeoutSeconds,
    setTimeoutSeconds,
    skipTuned,
    setSkipTuned,
    starting,
    log,
    error,
    setError,
    logRef,
    rels: useMemo(() => (catalog.data ?? []).map((r) => r.rel), [catalog.data]),
    onStart: (): void => {
      if (!target.trim()) {
        setError("Target is required");
        return;
      }
      onResetStart();
    },
    stopMutation: trpc.serverStop.useMutation({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: [["serverStatus"], { type: "query" }] });
      },
      onError: (err) => {
        setError(err.message);
      },
    }),
    keepAliveStatus: trpc.keepAliveStatus.useQuery(undefined, { refetchInterval: 5000 }),
    keepAliveStartMutation: trpc.keepAliveStart.useMutation({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: [["keepAliveStatus"], { type: "query" }] });
      },
      onError: (err) => {
        setError(err.message);
      },
    }),
    keepAliveStopMutation: trpc.keepAliveStop.useMutation({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: [["keepAliveStatus"], { type: "query" }] });
      },
      onError: (err) => {
        setError(err.message);
      },
    }),
  };
}

interface ServerStartEvent {
  type: string;
  pid?: number;
  command?: string;
  args?: string[];
  attempt?: number;
  httpCode?: number;
  reason?: string;
  endpoint?: string;
  code?: number;
  result?: { ok: boolean; pid?: number; endpoint?: string; error?: string };
}

function waitingLogLine(e: ServerStartEvent): LogLine | null {
  if (typeof e.attempt === "number" && e.attempt % 5 === 0) {
    return {
      kind: "waiting",
      text: `waiting attempt=${String(e.attempt)} http=${String(e.httpCode ?? "n/a")}`,
    };
  }
  return null;
}

/** Log line for the log-only start events; null for `done` (which
 *  also mutates card state), throttled `waiting`, and unknown types. */
function logLineForServerEvent(e: ServerStartEvent): LogLine | null {
  if (e.type === "launch")
    return {
      kind: "launch",
      text: `launched pid=${String(e.pid)} — ${String(e.command)} ${Array.isArray(e.args) ? e.args.join(" ") : ""}`,
    };
  if (e.type === "waiting") return waitingLogLine(e);
  if (e.type === "retry") return { kind: "retry", text: `retry: ${String(e.reason)}` };
  if (e.type === "ready")
    return {
      kind: "ready",
      text: `ready pid=${String(e.pid)} endpoint=${String(e.endpoint)}`,
    };
  if (e.type === "timeout") return { kind: "timeout", text: `timeout pid=${String(e.pid)}` };
  if (e.type === "exited") return { kind: "exited", text: `exited code=${String(e.code ?? "?")}` };
  return null;
}

function useServerStartSubscription(opts: {
  starting: { target: string; timeoutSeconds: number; skipTuned: boolean } | null;
  workload?: string;
  setStarting: (v: null) => void;
  setError: (v: string) => void;
  appendLog: (v: LogLine) => void;
  queryClient: ReturnType<typeof useQueryClient>;
}): void {
  const handleDone = (e: ServerStartEvent): void => {
    if (e.result?.ok)
      opts.appendLog({
        kind: "done",
        text: `started pid=${String(e.result.pid)} endpoint=${String(e.result.endpoint)}`,
      });
    else {
      opts.appendLog({ kind: "error", text: e.result?.error ?? "start failed" });
      opts.setError(e.result?.error ?? "start failed");
    }
    opts.setStarting(null);
    void opts.queryClient.invalidateQueries({ queryKey: [["serverStatus"], { type: "query" }] });
  };
  const handleEvent = (evt: unknown): void => {
    const e = evt as ServerStartEvent;
    if (e.type === "done") {
      handleDone(e);
      return;
    }
    const line = logLineForServerEvent(e);
    if (line) opts.appendLog(line);
  };
  trpc.serverStart.useSubscription(
    opts.starting && opts.workload ? { ...opts.starting, workload: opts.workload } : skipToken,
    {
      onData: handleEvent,
      onError: (err) => {
        opts.appendLog({ kind: "error", text: err.message });
        opts.setError(err.message);
        opts.setStarting(null);
      },
    },
  );
}
