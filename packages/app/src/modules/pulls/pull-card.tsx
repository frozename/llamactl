import * as React from "react";
import { useRef, useState } from "react";

import { trpc } from "@/lib/trpc";
import { Button } from "@/ui";

import { type LogLine, MAX_LOG_LINES, type PullCardSpec } from "./types";

function getLogColor(kind: LogLine["kind"]): string {
  if (kind === "stderr" || kind === "error") return "var(--color-warn)";
  if (kind === "done") return "var(--color-ok)";
  if (kind === "start" || kind === "profile") return "var(--color-brand)";
  return "var(--color-text)";
}

export function PullCard({
  spec,
  onDismiss,
  onDone,
}: {
  spec: PullCardSpec;
  onDismiss: (id: string) => void;
  onDone: () => void;
}): React.JSX.Element {
  const [log, setLog] = useState<LogLine[]>([]);
  const [state, setState] = useState<"running" | "done" | "error">("running");
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

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

  usePullSubscriptions({ spec, state, setState, setSummary, setError, appendLog, onDone });

  const label =
    spec.mode === "file"
      ? `pull file ${spec.repo} ${String(spec.file)}`
      : spec.mode === "candidate"
        ? `pull candidate ${spec.repo}${spec.profile ? ` (${spec.profile})` : ""}`
        : `candidate test ${spec.repo}`;
  const stateColor =
    state === "done"
      ? "var(--color-ok)"
      : state === "error"
        ? "var(--color-err)"
        : "var(--color-brand)";

  return (
    <div
      style={{
        borderRadius: 6,
        border: "1px solid var(--color-border)",
        backgroundColor: "var(--color-surface-1)",
      }}
    >
      <PullCardHeader
        state={state}
        stateColor={stateColor}
        label={label}
        onCancel={() => {
          setState("error");
          setError("Cancelled by user");
        }}
        onDismiss={() => {
          onDismiss(spec.id);
        }}
      />
      {(summary !== null || error !== null) && (
        <div
          style={{
            fontFamily: "monospace",
            borderTop: "1px solid var(--color-border)",
            padding: "4px 12px",
            fontSize: 12,
            color: error ? "var(--color-err)" : "var(--color-ok)",
          }}
        >
          {error ?? summary}
        </div>
      )}
      <div
        ref={logRef}
        style={{
          maxHeight: "28vh",
          overflow: "auto",
          borderTop: "1px solid var(--color-border)",
          backgroundColor: "var(--color-surface-0)",
          padding: "6px 12px",
          fontFamily: "monospace",
          fontSize: 12,
        }}
      >
        {log.length === 0 ? (
          <div style={{ color: "var(--color-text-secondary)" }}>Waiting for output…</div>
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

function PullCardHeader({
  state,
  stateColor,
  label,
  onCancel,
  onDismiss,
}: {
  state: "running" | "done" | "error";
  stateColor: string;
  label: string;
  onCancel: () => void;
  onDismiss: () => void;
}): React.JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "8px 12px",
        fontSize: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ fontFamily: "monospace", color: stateColor }}>{state}</span>
        <span
          style={{
            fontFamily: "monospace",
            color: "var(--color-text-secondary)",
            wordBreak: "break-all",
          }}
        >
          {label}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        {state === "running" && (
          <Button
            variant="destructive"
            size="sm"
            onClick={onCancel}
            style={{ fontSize: 12, padding: "2px 8px" }}
          >
            Cancel
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={onDismiss}
          disabled={state === "running"}
          style={{ fontSize: 12, padding: "2px 8px" }}
          aria-label="Dismiss"
        >
          ×
        </Button>
      </div>
    </div>
  );
}

interface PullEvent {
  type: string;
  command?: unknown;
  args?: unknown[];
  line?: unknown;
  code?: unknown;
  profile?: unknown;
  gen_ts?: unknown;
  prompt_ts?: unknown;
  result?: {
    rel?: string;
    wasMissing?: boolean;
    mmproj?: string | null;
    curatedAdded?: boolean;
    preset?: { ran?: boolean; reason?: string };
    vision?: { ran?: boolean; reason?: string };
  };
}

/** Log line for the simple log-only pull events; null for the
 *  done-variants (which also mutate card state) and unknown types. */
function logLineForPullEvent(e: PullEvent): LogLine | null {
  if (e.type === "start")
    return {
      kind: "start",
      text: `$ ${String(e.command)} ${Array.isArray(e.args) ? e.args.join(" ") : ""}`,
    };
  if (e.type === "stdout") return { kind: "stdout", text: String(e.line) };
  if (e.type === "stderr") return { kind: "stderr", text: String(e.line) };
  if (e.type === "exit") return { kind: "exit", text: `(exit ${String(e.code)})` };
  if (e.type === "profile-start")
    return { kind: "profile", text: `-- profile=${String(e.profile)} --` };
  if (e.type === "profile-done")
    return {
      kind: "profile",
      text: `-- profile=${String(e.profile)} gen_ts=${String(e.gen_ts)} prompt_ts=${String(e.prompt_ts)} --`,
    };
  if (e.type === "profile-fail")
    return {
      kind: "error",
      text: `-- profile=${String(e.profile)} failed (code=${String(e.code)}) --`,
    };
  return null;
}

function doneSummary(e: PullEvent): string {
  return `rel=${e.result?.rel ?? "?"} wasMissing=${e.result?.wasMissing ? "yes" : "no"}${e.result?.mmproj ? ` mmproj=${JSON.stringify(e.result.mmproj)}` : ""}`;
}

function candidateTestSummary(e: PullEvent): string {
  return `rel=${String(e.result?.rel)} curated_added=${String(e.result?.curatedAdded)} preset=${e.result?.preset?.ran ? "ran" : (e.result?.preset?.reason ?? "skipped")} vision=${e.result?.vision?.ran ? "ran" : (e.result?.vision?.reason ?? "skipped")}`;
}

function usePullSubscriptions(opts: {
  spec: PullCardSpec;
  state: string;
  setState: (v: "done" | "error") => void;
  setSummary: (v: string | null) => void;
  setError: (v: string | null) => void;
  appendLog: (v: LogLine) => void;
  onDone: () => void;
}): void {
  const finishWithSummary = (s: string): void => {
    opts.setSummary(s);
    opts.setState("done");
    opts.appendLog({ kind: "done", text: s });
    opts.onDone();
  };
  const handleData = (evt: unknown): void => {
    const e = evt as PullEvent;
    const line = logLineForPullEvent(e);
    if (line) {
      opts.appendLog(line);
      return;
    }
    if (e.type === "done" || e.type === "done-candidate") {
      finishWithSummary(doneSummary(e));
      return;
    }
    if (e.type === "done-candidate-test") {
      finishWithSummary(candidateTestSummary(e));
      return;
    }
    opts.appendLog({ kind: "stdout", text: JSON.stringify(e) });
  };
  const handleError = (err: { message: string }): void => {
    opts.appendLog({ kind: "error", text: err.message });
    opts.setError(err.message);
    opts.setState("error");
  };
  const enabled = opts.state === "running";
  trpc.pullFile.useSubscription(
    opts.spec.mode === "file" && opts.spec.file
      ? { repo: opts.spec.repo, file: opts.spec.file }
      : { repo: "", file: "" },
    {
      enabled: enabled && opts.spec.mode === "file" && !!opts.spec.file,
      onData: handleData,
      onError: handleError,
    },
  );
  trpc.pullCandidate.useSubscription(
    opts.spec.mode === "candidate"
      ? { repo: opts.spec.repo, file: opts.spec.file, profile: opts.spec.profile }
      : { repo: "" },
    {
      enabled: enabled && opts.spec.mode === "candidate",
      onData: handleData,
      onError: handleError,
    },
  );
  trpc.candidateTestRun.useSubscription(
    opts.spec.mode === "test"
      ? { repo: opts.spec.repo, file: opts.spec.file, profile: opts.spec.profile }
      : { repo: "" },
    { enabled: enabled && opts.spec.mode === "test", onData: handleData, onError: handleError },
  );
}
