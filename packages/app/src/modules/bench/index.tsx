import * as React from "react";
import { useMemo } from "react";

import { trpc } from "@/lib/trpc";

import { BenchForm } from "./bench-form";
import { HistoryTable, LogPanel } from "./components";
import { SchedulerPanel } from "./scheduler-panel";
import { useBench } from "./use-bench";

export default function Bench(): React.JSX.Element {
  const catalog = trpc.catalogList.useQuery("all");
  const history = trpc.benchHistory.useQuery(undefined);

  const { target, setTarget, mode, setMode, log, summary, error, logRef, start, cancel, busy } =
    useBench();

  const rels = useMemo(() => (catalog.data ?? []).map((row) => row.rel), [catalog.data]);
  const recentHistory = history.data ?? [];
  const canRun = target.trim().length > 0;

  return (
    <div style={{ height: "100%", overflow: "auto", padding: 24 }} data-testid="models-bench-root">
      <div
        style={{
          marginBottom: 4,
          fontSize: 12,
          textTransform: "uppercase",
          letterSpacing: "0.1em",
          color: "var(--color-text-secondary)",
        }}
      >
        Bench
      </div>
      <h1 style={{ marginBottom: 16, fontSize: 24, fontWeight: 600, color: "var(--color-text)" }}>
        Tune + measure
      </h1>

      <SchedulerPanel />

      <BenchForm
        target={target}
        setTarget={setTarget}
        mode={mode}
        setMode={setMode}
        busy={busy}
        canRun={canRun}
        rels={rels}
        onStart={start}
        onCancel={cancel}
      />

      {error && (
        <div
          style={{
            marginBottom: 12,
            borderRadius: 6,
            border: "1px solid var(--color-err)",
            backgroundColor: "var(--color-surface-1)",
            padding: "8px 12px",
            fontSize: 14,
            color: "var(--color-err)",
          }}
        >
          {error}
        </div>
      )}
      {summary && (
        <div
          style={{
            marginBottom: 12,
            borderRadius: 6,
            border: "1px solid var(--color-ok)",
            backgroundColor: "var(--color-surface-1)",
            padding: "8px 12px",
            fontSize: 14,
          }}
        >
          <div style={{ color: "var(--color-ok)" }}>Bench complete</div>
          <div
            style={{ fontFamily: "monospace", fontSize: 12, color: "var(--color-text-secondary)" }}
          >
            {summary}
          </div>
        </div>
      )}

      <LogPanel log={log} busy={busy} logRef={logRef} />

      <section>
        <h2
          style={{
            marginBottom: 8,
            fontSize: 14,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            color: "var(--color-text-secondary)",
          }}
        >
          Recent history ({recentHistory.length})
        </h2>
        <HistoryTable recentHistory={recentHistory} />
      </section>
    </div>
  );
}
