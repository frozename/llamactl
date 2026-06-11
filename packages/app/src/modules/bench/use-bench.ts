import type * as React from "react";

import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { trpc } from "@/lib/trpc";

import type { LogLine, Mode, RunKind } from "./types";

const MAX_LOG_LINES = 400;

function truncate(lines: LogLine[]): LogLine[] {
  return lines.length > MAX_LOG_LINES ? lines.slice(lines.length - MAX_LOG_LINES) : lines;
}

function eventText(value: unknown, fallback = ""): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export interface UseBenchResult {
  target: string;
  setTarget: (v: string) => void;
  mode: Mode;
  setMode: (v: Mode) => void;
  active:
    | { kind: "preset"; target: string; mode: Mode }
    | { kind: "vision"; target: string }
    | null;
  log: LogLine[];
  summary: string | null;
  error: string | null;
  logRef: React.RefObject<HTMLDivElement | null>;
  start: (kind: RunKind) => void;
  cancel: () => void;
  busy: boolean;
}

interface BenchEventHandlers {
  appendLog: (line: LogLine) => void;
  setSummary: (text: string | null) => void;
  clearActive: () => void;
  invalidate: (key: "benchHistory" | "benchCompare" | "benchVisionRows") => void;
}

function handleBenchEvent(ev: unknown, h: BenchEventHandlers): void {
  const e = ev as { type: string } & Record<string, unknown>;
  switch (e.type) {
    case "start":
      h.appendLog({
        kind: "start",
        text: `$ ${eventText(e.command)} ${
          Array.isArray(e.args) ? e.args.map((arg) => eventText(arg)).join(" ") : ""
        }`,
      });
      break;
    case "stdout":
      h.appendLog({ kind: "stdout", text: eventText(e.line) });
      break;
    case "stderr":
      h.appendLog({ kind: "stderr", text: eventText(e.line) });
      break;
    case "profile-start":
      h.appendLog({ kind: "profile", text: `-- profile=${String(e.profile)} --` });
      break;
    case "profile-done":
      h.appendLog({
        kind: "profile",
        text: `-- profile=${String(e.profile)} gen_ts=${String(e.gen_ts)} prompt_ts=${String(e.prompt_ts)} --`,
      });
      break;
    case "profile-fail":
      h.appendLog({
        kind: "error",
        text: `-- profile=${String(e.profile)} failed (code=${String(e.code)}) --`,
      });
      break;
    case "done-preset": {
      const r = e.result as {
        bestProfile?: string;
        gen_ts?: string;
        prompt_ts?: string;
        rel?: string;
      };
      const text = `preset: rel=${String(r.rel)} profile=${String(r.bestProfile)} gen_tps=${String(r.gen_ts)} prompt_tps=${String(r.prompt_ts)}`;
      h.appendLog({ kind: "done", text });
      h.setSummary(text);
      h.clearActive();
      h.invalidate("benchHistory");
      h.invalidate("benchCompare");
      break;
    }
    case "done-vision": {
      const r = e.result as {
        rel?: string;
        load_ms?: string;
        image_encode_ms?: string;
        prompt_tps?: string;
        gen_tps?: string;
      };
      const text = `vision: rel=${String(r.rel)} load_ms=${String(r.load_ms)} encode_ms=${String(r.image_encode_ms)} prompt_tps=${String(r.prompt_tps)} gen_tps=${String(r.gen_tps)}`;
      h.appendLog({ kind: "done", text });
      h.setSummary(text);
      h.clearActive();
      h.invalidate("benchVisionRows");
      h.invalidate("benchCompare");
      break;
    }
    default:
      h.appendLog({ kind: "stdout", text: JSON.stringify(e) });
  }
}

export function useBench(): UseBenchResult {
  const queryClient = useQueryClient();
  const [target, setTarget] = useState("current");
  const [mode, setMode] = useState<Mode>("auto");
  const [active, setActive] = useState<UseBenchResult["active"]>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  const appendLog = (line: LogLine): void => {
    setLog((prev) => truncate([...prev, line]));
    requestAnimationFrame(() => {
      if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    });
  };

  const handleEvent = (ev: unknown): void => {
    handleBenchEvent(ev, {
      appendLog,
      setSummary,
      clearActive: () => {
        setActive(null);
      },
      invalidate: (key) => {
        void queryClient.invalidateQueries({ queryKey: [[key], { type: "query" }] });
      },
    });
  };

  const handleError = (err: { message: string }): void => {
    appendLog({ kind: "error", text: err.message });
    setError(err.message);
    setActive(null);
  };

  trpc.benchPresetRun.useSubscription(
    active?.kind === "preset" ? { target: active.target, mode: active.mode } : { target: "" },
    { enabled: active?.kind === "preset", onData: handleEvent, onError: handleError },
  );

  trpc.benchVisionRun.useSubscription(
    active?.kind === "vision" ? { target: active.target } : { target: "" },
    { enabled: active?.kind === "vision", onData: handleEvent, onError: handleError },
  );

  const start = (kind: RunKind): void => {
    const t = target.trim();
    if (!t) {
      setError("Target is required");
      return;
    }
    setLog([]);
    setSummary(null);
    setError(null);
    if (kind === "preset") setActive({ kind: "preset", target: t, mode });
    else setActive({ kind: "vision", target: t });
  };

  return {
    target,
    setTarget,
    mode,
    setMode,
    active,
    log,
    summary,
    error,
    logRef,
    start,
    cancel: (): void => {
      setActive(null);
      setError("Cancelled by user");
    },
    busy: active !== null,
  };
}
