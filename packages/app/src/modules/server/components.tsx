import * as React from "react";

import { Button, Input, StatusDot } from "@/ui";

import type { UseServerControlReturn } from "./use-server-control";

interface ServerStatusData {
  state: string;
  pid: number | null;
  endpoint: string | null;
  advertisedEndpoint: string | null;
  health: {
    httpCode: number | null;
  };
}

export function ServerStatusCards({
  serverObj,
}: {
  serverObj: UseServerControlReturn;
}): React.JSX.Element {
  const s = serverObj.status.data as ServerStatusData | undefined;
  const isUp = s?.state === "up";
  const httpLabel = s?.health.httpCode ?? "unreachable";
  const httpOk = typeof s?.health.httpCode === "number" && s.health.httpCode < 400;

  return (
    <div
      style={{
        marginBottom: 16,
        display: "grid",
        gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
        gap: 12,
      }}
    >
      <div
        style={{
          borderRadius: 6,
          border: "1px solid var(--color-border)",
          backgroundColor: "var(--color-surface-1)",
          padding: 12,
        }}
        data-testid="server-state-card"
      >
        <div className="text-xs uppercase tracking-tight text-secondary">State</div>
        <div
          data-testid="server-state"
          data-state={s?.state ?? "unknown"}
          style={{
            marginTop: 4,
            fontSize: 18,
            fontWeight: 600,
            color: isUp
              ? "var(--color-ok)"
              : s?.state === "down"
                ? "var(--color-err)"
                : "var(--color-text-secondary)",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <StatusDot tone={isUp ? "ok" : s?.state === "down" ? "err" : "idle"} />
          {s?.state ?? "—"}
        </div>
      </div>
      <div
        style={{
          borderRadius: 6,
          border: "1px solid var(--color-border)",
          backgroundColor: "var(--color-surface-1)",
          padding: 12,
        }}
      >
        <div className="text-xs uppercase tracking-tight text-secondary">Endpoint</div>
        <div className="mt-1 font-mono text-sm break-all text-primary">
          {s?.endpoint ? (
            <a href={s.endpoint} target="_blank" rel="noreferrer" className="underline">
              {s.endpoint}
            </a>
          ) : (
            "—"
          )}
        </div>
        {s?.advertisedEndpoint && s.advertisedEndpoint !== s.endpoint && (
          <div className="mt-1 text-[10px] text-secondary">
            LAN:{" "}
            <a
              href={s.advertisedEndpoint}
              target="_blank"
              rel="noreferrer"
              className="font-mono underline"
            >
              {s.advertisedEndpoint}
            </a>
          </div>
        )}
      </div>
      <div
        style={{
          borderRadius: 6,
          border: "1px solid var(--color-border)",
          backgroundColor: "var(--color-surface-1)",
          padding: 12,
        }}
      >
        <div className="text-xs uppercase tracking-tight text-secondary">PID</div>
        <div className="mt-1 font-mono text-sm text-primary">{s?.pid ?? "none"}</div>
      </div>
      <div
        style={{
          borderRadius: 6,
          border: "1px solid var(--color-border)",
          backgroundColor: "var(--color-surface-1)",
          padding: 12,
        }}
        data-testid="server-http-card"
      >
        <div className="text-xs uppercase tracking-tight text-secondary">HTTP</div>
        <div
          className="mt-1 font-mono text-sm"
          style={{
            color: httpOk
              ? "var(--color-ok)"
              : s?.health.httpCode === null || s?.health.httpCode === undefined
                ? "var(--color-text-secondary)"
                : "var(--color-err)",
          }}
        >
          {httpLabel}
        </div>
      </div>
    </div>
  );
}

export function ServerControlForm({
  serverObj,
}: {
  serverObj: UseServerControlReturn;
}): React.JSX.Element {
  const {
    target,
    setTarget,
    timeoutSeconds,
    setTimeoutSeconds,
    skipTuned,
    setSkipTuned,
    starting,
    onStart,
    stopMutation,
    workload,
    rels,
    env,
    status,
  } = serverObj;
  const envData = env.data as Record<string, string> | undefined;
  const busy = starting !== null;
  const s = status.data as ServerStatusData | undefined;
  const isUp = s?.state === "up";

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onStart();
      }}
      style={{
        marginBottom: 16,
        borderRadius: 6,
        border: "1px solid var(--color-border)",
        backgroundColor: "var(--color-surface-1)",
        padding: 16,
      }}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(12, minmax(0, 1fr))", gap: 12 }}>
        <label style={{ gridColumn: "span 6 / span 6" }} className="text-sm">
          <span className="block mb-1 text-xs text-secondary">Target</span>
          <Input
            list="server-rel-suggestions"
            value={target}
            onChange={(e) => {
              setTarget(e.target.value);
            }}
            disabled={busy}
            className="w-full font-mono"
            placeholder="current | best | <rel>"
          />
          <datalist id="server-rel-suggestions">
            {["current", "best", "vision", "balanced", "fast"].map((alias) => (
              <option key={alias} value={alias} />
            ))}
            {rels.map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
        </label>
        <label style={{ gridColumn: "span 2 / span 2" }} className="text-sm">
          <span className="block mb-1 text-xs text-secondary">Timeout (s)</span>
          <Input
            type="number"
            min={5}
            max={600}
            value={timeoutSeconds}
            onChange={(e) => {
              setTimeoutSeconds(Math.max(5, Number(e.target.value) || 60));
            }}
            disabled={busy}
            className="w-full font-mono"
          />
        </label>
        <label
          style={{ gridColumn: "span 2 / span 2" }}
          className="flex flex-col justify-end text-xs text-secondary"
        >
          <span className="mb-1">Tuned args</span>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={!skipTuned}
              onChange={(e) => {
                setSkipTuned(!e.target.checked);
              }}
              disabled={busy}
            />
            <span>use tuned</span>
          </label>
        </label>
        <ServerStartStopButtons
          busy={busy}
          starting={starting}
          isUp={isUp}
          workload={workload}
          stopMutation={stopMutation}
        />
      </div>
      <div className="mt-2 text-xs text-secondary">
        LLAMA_CPP_HOST={envData?.LLAMA_CPP_HOST ?? "?"}:{envData?.LLAMA_CPP_PORT ?? "?"}
      </div>
    </form>
  );
}

function ServerStartStopButtons({
  busy,
  starting,
  isUp,
  workload,
  stopMutation,
}: {
  busy: boolean;
  starting: UseServerControlReturn["starting"];
  isUp: boolean;
  workload: UseServerControlReturn["workload"];
  stopMutation: UseServerControlReturn["stopMutation"];
}): React.JSX.Element {
  return (
    <div style={{ gridColumn: "span 2 / span 2" }} className="flex items-end gap-2">
      <Button
        type="submit"
        variant="primary"
        disabled={busy || !workload}
        data-testid="server-start"
        className="flex-1"
      >
        {starting ? "Starting…" : "Start"}
      </Button>
      <Button
        type="button"
        variant="destructive"
        onClick={() => {
          if (workload) {
            stopMutation.mutate({ workload, graceSeconds: 5 });
          }
        }}
        disabled={busy || stopMutation.isPending || !isUp || !workload}
        data-testid="server-stop"
        className="flex-1"
        title={
          !workload
            ? "No workload selected"
            : !isUp
              ? "Server not running"
              : "SIGTERM -> SIGKILL (5s grace)"
        }
      >
        {stopMutation.isPending ? "Stopping…" : "Stop"}
      </Button>
    </div>
  );
}

interface KeepAliveStatusData {
  running: boolean;
  pid: number | null;
  state?: {
    state: string;
    model: string;
    restarts: number;
    backoff_seconds: number;
  };
}

export function KeepAliveSupervisor({
  serverObj,
}: {
  serverObj: UseServerControlReturn;
}): React.JSX.Element {
  const {
    target,
    setTarget,
    keepAliveStatus,
    keepAliveStartMutation,
    keepAliveStopMutation,
    workload,
  } = serverObj;
  const ka = keepAliveStatus.data as KeepAliveStatusData | undefined;

  return (
    <section
      style={{
        marginBottom: 24,
        borderRadius: 6,
        border: "1px solid var(--color-border)",
        backgroundColor: "var(--color-surface-1)",
        padding: 16,
      }}
    >
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold uppercase tracking-tight text-secondary">
          Keep-alive supervisor
        </h2>
        <span className={`font-mono text-xs ${ka?.running ? "text-ok" : "text-secondary"}`}>
          {ka?.running ? `running (pid=${String(ka.pid)})` : "stopped"}
        </span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(12, minmax(0, 1fr))", gap: 12 }}>
        <label style={{ gridColumn: "span 7 / span 7" }} className="text-sm">
          <span className="block mb-1 text-xs text-secondary">Target</span>
          <Input
            value={target}
            onChange={(e) => {
              setTarget(e.target.value);
            }}
            disabled={ka?.running === true || keepAliveStartMutation.isPending}
            className="w-full font-mono"
          />
        </label>
        <div style={{ gridColumn: "span 5 / span 5" }} className="flex items-end gap-2">
          <Button
            type="button"
            variant="primary"
            onClick={() => {
              keepAliveStartMutation.mutate({ target: target.trim() || "current" });
            }}
            disabled={ka?.running === true || keepAliveStartMutation.isPending}
            className="flex-1"
          >
            {keepAliveStartMutation.isPending ? "Starting…" : "Start supervisor"}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => {
              if (workload) {
                keepAliveStopMutation.mutate({ workload, graceSeconds: 10 });
              }
            }}
            disabled={!ka?.running || keepAliveStopMutation.isPending}
            className="flex-1"
          >
            {keepAliveStopMutation.isPending ? "Stopping…" : "Stop supervisor"}
          </Button>
        </div>
      </div>
      {ka?.state && (
        <div className="grid grid-cols-4 gap-2 mt-3 text-xs text-secondary">
          <div>
            state=<span className="text-primary">{ka.state.state}</span>
          </div>
          <div>
            model=<span className="text-primary">{ka.state.model}</span>
          </div>
          <div>
            restarts=<span className="text-primary">{ka.state.restarts}</span>
          </div>
          <div>
            backoff=<span className="text-primary">{ka.state.backoff_seconds}s</span>
          </div>
        </div>
      )}
    </section>
  );
}

export function ServerLog({ serverObj }: { serverObj: UseServerControlReturn }): React.JSX.Element {
  const { log, logRef, starting } = serverObj;
  return (
    <div
      style={{
        borderRadius: 6,
        border: "1px solid var(--color-border)",
        backgroundColor: "var(--color-surface-0)",
      }}
    >
      <div className="flex items-center justify-between px-3 py-2 text-xs uppercase tracking-tight text-secondary">
        <span>Log</span>
        <span>
          {log.length} line{log.length === 1 ? "" : "s"}
        </span>
      </div>
      <div
        ref={logRef}
        style={{
          maxHeight: "50vh",
          overflow: "auto",
          borderTop: "1px solid var(--color-border)",
          padding: "8px 12px",
        }}
        className="font-mono text-xs"
      >
        {log.length === 0 ? (
          <div className="text-secondary">
            {starting ? "Waiting for events…" : "Lifecycle events appear here during a start."}
          </div>
        ) : (
          log.map((line, i) => (
            <div key={i} style={{ color: getLogColor(line.kind), whiteSpace: "pre-wrap" }}>
              {line.text}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function getLogColor(kind: string): string {
  if (kind === "error" || kind === "timeout" || kind === "exited") return "var(--color-err)";
  if (kind === "ready" || kind === "done") return "var(--color-ok)";
  if (kind === "launch" || kind === "retry") return "var(--color-brand)";
  return "var(--color-text-secondary)";
}
