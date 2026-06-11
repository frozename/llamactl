import type { bench, schemas } from "@llamactl/core";

import { skipToken } from "@tanstack/react-query";
import * as React from "react";
import { Suspense } from "react";

import { useActiveWorkload } from "@/hooks/useActiveWorkload";
import { trpc } from "@/lib/trpc";
import { EditorialHero } from "@/ui";

import { DashboardPromotions, DashboardStats } from "./components";
import { ExposePanel } from "./expose-panel";
import { fmtTps } from "./helpers";
import { ThemedNodeMap } from "./ThemedNodeMap";

type BenchCompareRow = bench.BenchCompareRow;
type PresetOverride = schemas.PresetOverride;

function ExposedWorkloads(): React.JSX.Element {
  const list = trpc.workloadList.useQuery(undefined, { refetchInterval: 5000 });
  const rows = list.data ?? [];
  const running = rows.filter((r) => r.phase === "Running" && r.endpoint);
  if (running.length === 0)
    return (
      <div
        style={{
          borderRadius: "var(--r-md)",
          border: "1px dashed var(--color-border)",
          padding: 16,
          color: "var(--color-text-secondary)",
        }}
      >
        No workloads currently serving.
      </div>
    );
  return (
    <ul
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        fontFamily: "var(--font-mono)",
        fontSize: 14,
        margin: 0,
        padding: 0,
        listStyle: "none",
      }}
    >
      {running.map((w) => (
        <li
          key={w.name}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderRadius: "var(--r-md)",
            border: "1px solid var(--color-border)",
            background: "var(--color-surface-1)",
            padding: "8px 12px",
          }}
        >
          <div>
            <span style={{ color: "var(--color-brand)" }}>{w.name}</span>
            <span style={{ margin: "0 4px", color: "var(--color-text-secondary)" }}>·</span>
            <span style={{ color: "var(--color-text-secondary)" }}>{w.node}</span>
            <span style={{ margin: "0 4px", color: "var(--color-text-secondary)" }}>·</span>
            <span>{w.rel}</span>
          </div>
          {w.endpoint && (
            <a
              href={w.endpoint}
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--color-ok)", textDecoration: "underline" }}
            >
              {w.endpoint}
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

function BenchTable({ rows }: { rows: BenchCompareRow[] }): React.JSX.Element {
  if (rows.length === 0)
    return (
      <div
        style={{
          borderRadius: "var(--r-md)",
          border: "1px dashed var(--color-border)",
          padding: 16,
          color: "var(--color-text-secondary)",
        }}
      >
        No tuned records yet.
      </div>
    );
  return (
    <div
      style={{
        overflow: "hidden",
        borderRadius: "var(--r-md)",
        border: "1px solid var(--color-border)",
      }}
    >
      <table
        style={{
          width: "100%",
          fontFamily: "var(--font-mono)",
          fontSize: 14,
          borderCollapse: "collapse",
        }}
      >
        <thead
          style={{
            background: "var(--color-surface-1)",
            textAlign: "left",
            color: "var(--color-text-secondary)",
          }}
        >
          <tr>
            <th style={{ padding: "8px 12px", fontWeight: 500 }}>Model</th>
            <th style={{ padding: "8px 12px", fontWeight: 500 }}>Class</th>
            <th style={{ padding: "8px 12px", textAlign: "right", fontWeight: 500 }}>Gen tps</th>
            <th style={{ padding: "8px 12px", textAlign: "right", fontWeight: 500 }}>Prompt tps</th>
            <th style={{ padding: "8px 12px", fontWeight: 500 }}>Mode/Ctx</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.rel}
              style={{
                borderTop: "1px solid var(--color-border)",
                background: "var(--color-surface-1)",
              }}
            >
              <td style={{ padding: "8px 12px" }}>{row.label}</td>
              <td style={{ padding: "8px 12px", color: "var(--color-text-secondary)" }}>
                {row.class}
              </td>
              <td style={{ padding: "8px 12px", textAlign: "right", color: "var(--color-ok)" }}>
                {fmtTps(row.tuned?.gen_tps)}
              </td>
              <td style={{ padding: "8px 12px", textAlign: "right" }}>
                {fmtTps(row.tuned?.prompt_tps)}
              </td>
              <td style={{ padding: "8px 12px", color: "var(--color-text-secondary)" }}>
                {row.mode} / {row.ctx}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DashboardBody(): React.JSX.Element {
  const envQ = trpc.env.useQuery();
  const compQ = trpc.benchCompare.useQuery();
  const promQ = trpc.promotions.useQuery();
  const { workload, loading: wlLoading } = useActiveWorkload();
  const statusQ = trpc.serverStatus.useQuery(workload ? { workload } : skipToken, {
    refetchInterval: 5000,
    enabled: !!workload,
  });

  if (envQ.isLoading || compQ.isLoading || promQ.isLoading)
    return <div style={{ padding: 24, color: "var(--color-text-secondary)" }}>Loading…</div>;

  const env = envQ.data;
  const activeModel = statusQ.data?.state === "up" && statusQ.data.rel ? statusQ.data.rel : "none";
  const rows = compQ.data ?? [];
  const topBench = rows
    .filter((r) => r.tuned)
    .sort(
      (a, b) =>
        Number.parseFloat(b.tuned?.gen_tps ?? "0") - Number.parseFloat(a.tuned?.gen_tps ?? "0"),
    )
    .slice(0, 5);
  const promotions = promQ.data ?? [];

  return (
    <div style={{ height: "100%", overflow: "auto", padding: 24 }}>
      <EditorialHero
        eyebrow="Dashboard"
        title="Your fleet"
        titleAccent="at a glance"
        lede="Nodes, workloads, and cost — in one view. Pin a workload or open a specific node from the Explorer to dig in."
        pills={[
          { label: "healthy", tone: "ok" },
          { label: "Beacon", tone: "info" },
        ]}
        style={{ marginBottom: 32 }}
      />
      {!workload && !wlLoading && (
        <div
          style={{
            marginBottom: 24,
            borderRadius: "var(--r-md)",
            border: "1px solid var(--color-border)",
            background: "var(--color-surface-1)",
            padding: 12,
            color: "var(--color-text-secondary)",
          }}
        >
          No active workload. Apply one to enable this view.
        </div>
      )}
      <section style={{ marginBottom: 32 }} data-testid="dashboard-node-map-section">
        <h2
          style={{
            marginBottom: 12,
            fontSize: 14,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            color: "var(--color-text-secondary)",
          }}
        >
          Cluster map
        </h2>
        <ThemedNodeMap />
      </section>
      <DashboardStats env={env} activeModel={activeModel} />
      <section style={{ marginTop: 32 }}>
        <h2
          style={{
            marginBottom: 12,
            fontSize: 14,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            color: "var(--color-text-secondary)",
          }}
        >
          Exposed workloads
        </h2>
        <ExposedWorkloads />
        <ExposePanel />
      </section>
      <section style={{ marginTop: 32 }}>
        <h2
          style={{
            marginBottom: 12,
            fontSize: 14,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            color: "var(--color-text-secondary)",
          }}
        >
          Top benches (gen tps)
        </h2>
        <BenchTable rows={topBench} />
      </section>
      <DashboardPromotions promotions={promotions} />
    </div>
  );
}

export default function Dashboard(): React.JSX.Element {
  return (
    <div style={{ height: "100%" }} data-testid="dashboard-root">
      <Suspense
        fallback={<div style={{ padding: 24, color: "var(--color-text-secondary)" }}>Loading…</div>}
      >
        <DashboardBody />
      </Suspense>
    </div>
  );
}
