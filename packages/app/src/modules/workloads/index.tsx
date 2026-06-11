import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { useState } from "react";

import { trpc } from "@/lib/trpc";
import { Button, StatusDot } from "@/ui";

import type { WorkloadRow as WorkloadRowType } from "./types";

import { ApplyPanel } from "./apply-panel";
import { WorkloadRow } from "./workload-row";

/**
 * Workloads module — declarative ModelRun manifests.
 */

export default function Workloads(): React.JSX.Element {
  const list = trpc.workloadList.useQuery();
  const workloadsDir = trpc.workloadsDir.useQuery();
  const [showApply, setShowApply] = useState(false);

  if (list.isLoading) {
    return (
      <div style={{ height: "100%" }} data-testid="workloads-model-runs-root">
        <div style={{ padding: 24, color: "var(--color-text-secondary)", fontSize: 14 }}>
          Loading…
        </div>
      </div>
    );
  }
  if (list.error) {
    return (
      <div style={{ height: "100%" }} data-testid="workloads-model-runs-root">
        <div style={{ padding: 24, color: "var(--color-err)", fontSize: 14 }}>
          Failed to load workloads: {list.error.message}
        </div>
      </div>
    );
  }

  const rows = (list.data ?? []) as WorkloadRowType[];

  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: 16, padding: 24 }}
      data-testid="workloads-model-runs-root"
    >
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <div>
          <h1 style={{ fontSize: 18, fontWeight: 600, color: "var(--color-text)" }}>Workloads</h1>
          <div style={{ color: "var(--color-text-secondary)", fontSize: 12 }}>
            Declarative ModelRun manifests (
            <span style={{ fontFamily: "var(--font-mono)" }}>
              {workloadsDir.data?.dir ?? "…"}
              {"/*.yaml"}
            </span>
            )
          </div>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => {
            setShowApply((v) => !v);
          }}
        >
          {showApply ? "Cancel" : "Apply workload"}
        </Button>
      </div>
      {showApply && (
        <ApplyPanel
          onDone={() => {
            setShowApply(false);
          }}
        />
      )}
      <ReconcilerToolbar />
      <div style={{ marginTop: 8 }}>
        {rows.length === 0 && (
          <EmptyWorkloadsState
            onApply={() => {
              setShowApply(true);
            }}
          />
        )}
        {rows.map((row) => (
          <WorkloadRow key={row.name} row={row} />
        ))}
      </div>
    </div>
  );
}

function ReconcilerToolbar(): React.JSX.Element {
  const qc = useQueryClient();
  const utils = trpc.useUtils();
  const status = trpc.reconcilerStatus.useQuery(undefined, { refetchInterval: 5000 });
  const start = trpc.reconcilerStart.useMutation({
    onSuccess: () => {
      void utils.reconcilerStatus.invalidate();
      void utils.workloadList.invalidate();
    },
  });
  const stop = trpc.reconcilerStop.useMutation({
    onSuccess: () => {
      void utils.reconcilerStatus.invalidate();
    },
  });
  const kick = trpc.reconcilerKick.useMutation({
    onSuccess: () => {
      void utils.reconcilerStatus.invalidate();
      void utils.workloadList.invalidate();
      void qc.invalidateQueries();
    },
  });

  const running = status.data?.running ?? false;
  const intervalSec = status.data ? Math.round(status.data.intervalMs / 1000) : 10;
  const lastPass = status.data?.lastPassAt
    ? new Date(status.data.lastPassAt).toLocaleTimeString()
    : "—";
  const errors = status.data?.lastResult?.errors ?? 0;
  const reports = status.data?.lastResult?.reports ?? [];
  const actionCounts = reports.reduce<Record<string, number>>((acc, r) => {
    acc[r.action] = (acc[r.action] ?? 0) + 1;
    return acc;
  }, {});
  const summary =
    reports.length === 0
      ? "no workloads reconciled yet"
      : Object.entries(actionCounts)
          .map(([k, v]) => `${k}:${String(v)}`)
          .join(" · ");

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        borderRadius: "var(--r-md)",
        border: "1px solid var(--color-border)",
        borderColor: "var(--color-border)",
        background: "var(--color-surface-1)",
        paddingLeft: 12,
        paddingRight: 12,
        paddingTop: 8,
        paddingBottom: 8,
        fontSize: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <StatusDot tone={running ? "ok" : "idle"} />
        <span style={{ color: "var(--color-text)" }}>auto-heal {running ? "on" : "off"}</span>
        <span style={{ color: "var(--color-text-secondary)" }}>
          · every {intervalSec}s · last {lastPass}
          {errors > 0 && (
            <>
              {" · "}
              <span style={{ color: "var(--color-err)" }}>{errors} errors</span>
            </>
          )}
          {" · "}
          <span>{summary}</span>
        </span>
      </div>
      <div style={{ display: "flex", gap: 4 }}>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => {
            kick.mutate();
          }}
          disabled={kick.isPending}
          title="run one reconcile pass now"
        >
          {kick.isPending ? "…" : "Kick"}
        </Button>
        {running ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              stop.mutate();
            }}
            disabled={stop.isPending}
          >
            Stop
          </Button>
        ) : (
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={() => {
              start.mutate({ intervalSeconds: 10 });
            }}
            disabled={start.isPending}
          >
            Start
          </Button>
        )}
      </div>
    </div>
  );
}

function EmptyWorkloadsState({ onApply }: { onApply: () => void }): React.JSX.Element {
  return (
    <div
      data-testid="workloads-empty"
      style={{
        borderRadius: "var(--r-md)",
        border: "1px solid var(--color-border)",
        borderStyle: "dashed",
        borderColor: "var(--color-border)",
        background: "var(--color-surface-1)",
        padding: 24,
      }}
    >
      <h2 style={{ fontWeight: 600, color: "var(--color-text)", fontSize: 14 }}>
        Declare a workload to self-heal
      </h2>
      <p style={{ marginTop: 4, color: "var(--color-text-secondary)", fontSize: 12 }}>
        A <span style={{ fontFamily: "var(--font-mono)" }}>ModelRun</span> manifest pins a model to
        a node. The reconciler keeps it running, restarts it on crash, and corrects drift when extra
        args change. Use it for long-lived endpoints that shouldn&apos;t depend on someone typing{" "}
        <span style={{ fontFamily: "var(--font-mono)" }}>llamactl server start</span>.
      </p>
      <Button
        type="button"
        variant="primary"
        size="sm"
        onClick={() => {
          onApply();
        }}
        data-testid="workloads-apply"
      >
        Apply workload
      </Button>
    </div>
  );
}
