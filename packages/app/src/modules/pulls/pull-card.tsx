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
    <div className="border rounded bg-surface-1 border-border">
      <div className="flex items-center justify-between p-2 px-3 text-xs">
        <div className="flex items-center gap-3 font-mono">
          <span style={{ color: stateColor }}>{state}</span>
          <span className="text-secondary break-all">{label}</span>
        </div>
        <div className="flex items-center gap-1">
          {state === "running" && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                setState("error");
                setError("Cancelled by user");
              }}
              className="p-1 px-2 text-xs"
            >
              Cancel
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              onDismiss(spec.id);
            }}
            disabled={state === "running"}
            className="p-1 px-2 text-xs"
          >
            ×
          </Button>
        </div>
      </div>
      {(summary !== null || error !== null) && (
        <div
          className="font-mono border-t border-border p-1 px-3 text-xs"
          style={{ color: error ? "var(--color-err)" : "var(--color-ok)" }}
        >
          {error ?? summary}
        </div>
      )}
      <div
        ref={logRef}
        className="max-h-[28vh] overflow-auto border-t border-border bg-surface-0 p-2 px-3 font-mono text-xs"
      >
        {log.length === 0 ? (
          <div className="text-secondary">Waiting for output…</div>
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
