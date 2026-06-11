import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { useMemo, useState } from "react";

import { trpc } from "@/lib/trpc";
import { Button, Input, StatusDot } from "@/ui";

import type {
  ComponentRef,
  ComponentState,
  CompositeSpecShape,
  DryRunResult,
  StatusComponent,
  WetRunResult,
} from "./types";

import { countComponents } from "./helpers";

export function TabBar(props: {
  active: string;
  onChange: (id: string) => void;
}): React.JSX.Element {
  const tabs = [
    { id: "list", label: "List" },
    { id: "apply", label: "Apply" },
    { id: "detail", label: "Detail" },
  ];
  return (
    <div
      style={{
        marginBottom: 16,
        display: "flex",
        gap: 4,
        borderBottom: "1px solid var(--color-border)",
      }}
    >
      {tabs.map((tab) => (
        <Button
          key={tab.id}
          type="button"
          onClick={() => {
            props.onChange(tab.id);
          }}
          style={{
            padding: "8px 12px",
            fontSize: 14,
            fontWeight: tab.id === props.active ? 500 : 400,
            color: tab.id === props.active ? "var(--color-text)" : "var(--color-text-secondary)",
            borderBottom: "2px solid",
            borderColor: tab.id === props.active ? "var(--color-brand)" : "transparent",
          }}
        >
          {tab.label}
        </Button>
      ))}
    </div>
  );
}

export function DryRunPreview(props: { result: DryRunResult }): React.JSX.Element {
  const { result } = props;
  return (
    <div
      style={{
        borderRadius: "var(--r-md)",
        border: "1px solid var(--color-border)",
        background: "var(--color-surface-1)",
        padding: 12,
      }}
    >
      <div style={{ marginBottom: 8, color: "var(--color-text-secondary)", fontSize: 12 }}>
        Dry-run succeeded -- composite{" "}
        <span style={{ fontFamily: "var(--font-mono)", color: "var(--color-text)" }}>
          {result.manifest.metadata.name}
        </span>{" "}
        would apply {countComponents(result.manifest.spec)} component(s).
      </div>
      <div style={{ marginBottom: 8 }}>
        <div style={{ marginBottom: 4, fontWeight: 500, color: "var(--color-text)", fontSize: 12 }}>
          Topological order
        </div>
        <ol
          style={{
            marginTop: 2,
            fontFamily: "var(--font-mono)",
            color: "var(--color-text)",
            fontSize: 12,
          }}
        >
          {result.order.map((ref, i) => (
            <li key={`${ref.kind}/${ref.name}`} style={{ display: "flex", gap: 8 }}>
              <span style={{ color: "var(--color-text-secondary)" }}>{i + 1}.</span>
              <span
                style={{
                  borderRadius: "var(--r-md)",
                  border: "1px solid var(--color-border)",
                  background: "var(--color-surface-2)",
                  padding: "2px 6px",
                  fontSize: 10,
                }}
              >
                {ref.kind}
              </span>
              <span>{ref.name}</span>
            </li>
          ))}
        </ol>
      </div>
      {result.impliedEdges.length > 0 && (
        <div>
          <div
            style={{ marginBottom: 4, fontWeight: 500, color: "var(--color-text)", fontSize: 12 }}
          >
            Implied dependency edges
          </div>
          <ul
            style={{
              marginTop: 2,
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              color: "var(--color-text-secondary)",
            }}
          >
            {result.impliedEdges.map((e, i) => (
              <li key={i}>
                {e.from.kind}/{e.from.name}{" "}
                <span style={{ color: "var(--color-text)" }}>{"->"}</span> {e.to.kind}/{e.to.name}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function WetRunSummary(props: { result: WetRunResult }): React.JSX.Element {
  const { result } = props;
  const failed = result.componentResults.filter((r) => r.state === "Failed");
  const tone =
    result.status.phase === "Ready" ||
    result.status.phase === "Pending" ||
    result.status.phase === "Applying"
      ? "ok"
      : result.status.phase === "Failed"
        ? "err"
        : "warn";
  return (
    <div
      style={{
        borderRadius: "var(--r-md)",
        border: "1px solid var(--color-border)",
        borderColor: result.ok ? "var(--color-ok)" : "var(--color-err)",
        background: "var(--color-surface-1)",
        padding: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10 }}>
          <StatusDot tone={tone} />
          {result.status.phase}
        </span>
        <span style={{ color: "var(--color-text)" }}>
          {result.ok ? "apply succeeded" : "apply failed"}
        </span>
        {result.rolledBack && (
          <span style={{ color: "var(--color-warn)", fontSize: 12 }}> - rolled back</span>
        )}
      </div>
      {failed.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <div style={{ fontWeight: 500, color: "var(--color-err)", fontSize: 12 }}>
            Failed components ({failed.length})
          </div>
          <ul
            style={{
              marginTop: 2,
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--color-text)",
            }}
          >
            {failed.map((f, i) => (
              <li key={i}>
                <span style={{ color: "var(--color-text-secondary)" }}>{f.ref.kind}/</span>
                {f.ref.name}
                {f.message && <span style={{ color: "var(--color-err)" }}>: {f.message}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

interface TreeSection {
  title: string;
  rows: { ref: ComponentRef; meta: React.JSX.Element }[];
}

function buildTreeSections(spec: CompositeSpecShape): TreeSection[] {
  return [
    {
      title: "Services",
      rows: spec.services.map((s) => ({
        ref: { kind: "service" as const, name: s.name },
        meta: (
          <span style={{ fontSize: 10, color: "var(--color-text-secondary)" }}>
            {s.kind} on <span style={{ fontFamily: "var(--font-mono)" }}>{s.node}</span>
          </span>
        ),
      })),
    },
    {
      title: "Workloads",
      rows: spec.workloads.map((w) => ({
        ref: { kind: "workload" as const, name: w.node },
        meta: (
          <span style={{ fontSize: 10, color: "var(--color-text-secondary)" }}>
            <span style={{ fontFamily: "var(--font-mono)" }}>
              {w.target.kind}:{w.target.value}
            </span>
          </span>
        ),
      })),
    },
    {
      title: "RAG nodes",
      rows: spec.ragNodes.map((r) => ({
        ref: { kind: "rag" as const, name: r.name },
        meta: (
          <span style={{ fontSize: 10, color: "var(--color-text-secondary)" }}>
            node <span style={{ fontFamily: "var(--font-mono)" }}>{r.node}</span>
            {r.backingService && (
              <>
                {" "}
                - backed by{" "}
                <span style={{ fontFamily: "var(--font-mono)" }}>{r.backingService}</span>
              </>
            )}
          </span>
        ),
      })),
    },
    {
      title: "Gateways",
      rows: spec.gateways.map((g) => ({
        ref: { kind: "gateway" as const, name: g.name },
        meta: (
          <span style={{ fontSize: 10, color: "var(--color-text-secondary)" }}>
            {g.provider} on <span style={{ fontFamily: "var(--font-mono)" }}>{g.node}</span>
            {g.upstreamWorkloads.length > 0 && (
              <>
                {" "}
                - upstreams{" "}
                <span style={{ fontFamily: "var(--font-mono)" }}>
                  {g.upstreamWorkloads.join(", ")}
                </span>
              </>
            )}
          </span>
        ),
      })),
    },
  ];
}

export function ComponentTree(props: {
  spec: CompositeSpecShape;
  statusComponents: StatusComponent[];
}): React.JSX.Element {
  const { spec, statusComponents } = props;
  const statusByKey = useMemo(() => {
    const m = new Map<string, StatusComponent>();
    for (const c of statusComponents) m.set(`${c.ref.kind}/${c.ref.name}`, c);
    return m;
  }, [statusComponents]);
  const badge = (ref: ComponentRef): React.JSX.Element => {
    const match = statusByKey.get(`${ref.kind}/${ref.name}`);
    const state: ComponentState = match?.state ?? "Pending";
    return (
      <span
        style={{
          borderRadius: "var(--r-md)",
          border: "1px solid var(--color-border)",
          padding: "2px 6px",
          fontSize: 10,
          background: "var(--color-surface-2)",
          color: "var(--color-text-secondary)",
        }}
        title={match?.message ?? state}
      >
        {state}
      </span>
    );
  };
  const sections = buildTreeSections(spec);
  return (
    <div style={{ marginTop: 12 }}>
      {sections.map((sec) => (
        <div key={sec.title}>
          <div
            style={{ marginBottom: 4, fontWeight: 500, color: "var(--color-text)", fontSize: 12 }}
          >
            {sec.title} ({sec.rows.length})
          </div>
          {sec.rows.length === 0 ? (
            <div
              style={{
                borderRadius: "var(--r-md)",
                border: "1px dashed var(--color-border)",
                padding: 8,
                fontSize: 10,
                color: "var(--color-text-secondary)",
              }}
            >
              none declared
            </div>
          ) : (
            <ul style={{ marginTop: 4 }}>
              {sec.rows.map((row) => (
                <li
                  key={`${row.ref.kind}/${row.ref.name}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    borderRadius: "var(--r-md)",
                    border: "1px solid var(--color-border)",
                    background: "var(--color-surface-1)",
                    padding: "4px 8px",
                  }}
                >
                  {badge(row.ref)}
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      color: "var(--color-text)",
                      fontSize: 12,
                    }}
                  >
                    {row.ref.name}
                  </span>
                  {row.meta}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

export function DestroySection(props: {
  name: string;
  onDestroyed: () => void;
}): React.JSX.Element {
  const { name, onDestroyed } = props;
  const qc = useQueryClient();
  const utils = trpc.useUtils();
  const [armed, setArmed] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const destroy = trpc.compositeDestroy.useMutation({
    onSuccess: () => {
      setArmed(false);
      setTyped("");
      setError(null);
      void utils.compositeList.invalidate();
      void qc.invalidateQueries();
      onDestroyed();
    },
    onError: (err) => {
      setError(err.message);
    },
  });
  if (!armed)
    return (
      <Button
        type="button"
        onClick={() => {
          setArmed(true);
        }}
        style={{ color: "var(--color-err)", fontSize: 12 }}
      >
        Destroy composite...
      </Button>
    );
  return (
    <div
      style={{
        marginTop: 8,
        borderRadius: "var(--r-md)",
        border: "1px solid var(--color-border)",
        borderColor: "var(--color-err)",
        background: "var(--color-surface-1)",
        padding: 12,
      }}
    >
      <div style={{ color: "var(--color-text)", fontSize: 12 }}>
        Destructive action: this will tear down every component in{" "}
        <span style={{ fontFamily: "var(--font-mono)" }}>{name}</span>. Type the name to confirm.
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Input
          type="text"
          value={typed}
          onChange={(e) => {
            setTyped(e.target.value);
          }}
          placeholder={name}
          style={{ width: 192, fontSize: 12 }}
        />
        <Button
          type="button"
          onClick={() => {
            destroy.mutate({ name, dryRun: false });
          }}
          disabled={typed.trim() !== name || destroy.isPending}
          style={{
            background: "var(--color-err)",
            color: "white",
            opacity: typed.trim() !== name || destroy.isPending ? 0.5 : 1,
          }}
        >
          {destroy.isPending ? "Destroying..." : "Confirm destroy"}
        </Button>
        <Button
          type="button"
          onClick={() => {
            setArmed(false);
            setTyped("");
            setError(null);
          }}
        >
          Cancel
        </Button>
      </div>
      {error && <div style={{ color: "var(--color-err)", fontSize: 12 }}>{error}</div>}
    </div>
  );
}
