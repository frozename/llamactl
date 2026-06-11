import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { useState } from "react";

import { trpc } from "@/lib/trpc";
import { Button, EditorialHero } from "@/ui";

import { type ScopeFilter, useModelsStore } from "./store";

function ScopeTabs(): React.JSX.Element {
  const { scope, setScope } = useModelsStore();
  const tabs: { id: ScopeFilter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "builtin", label: "Built-in" },
    { id: "custom", label: "Custom" },
  ];
  return (
    <div style={{ marginBottom: 16, display: "flex", gap: 4, fontSize: 14 }} role="tablist">
      {tabs.map((tab) => {
        const active = tab.id === scope;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => {
              setScope(tab.id);
            }}
            style={{
              borderRadius: 4,
              border: active ? "1px solid var(--color-brand)" : "1px solid transparent",
              backgroundColor: active ? "var(--color-surface-2)" : "transparent",
              padding: "4px 12px",
              fontWeight: active ? 500 : 400,
              color: active ? "var(--color-text)" : "var(--color-text-secondary)",
              cursor: "pointer",
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

interface UninstallReport {
  rel: string;
  code: number;
  error?: string;
  actions: string[];
}

interface CatalogEntry {
  id: string;
  label: string;
  family: string;
  class: string;
  scope: string;
  rel: string;
  installed: boolean;
}

function CatalogTable({
  data,
  onUninstall,
  uninstalling,
}: {
  data: CatalogEntry[];
  onUninstall: (rel: string, force: boolean) => void;
  uninstalling: boolean;
}): React.JSX.Element {
  const [pending, setPending] = useState<string | null>(null);
  const [force, setForce] = useState(false);
  return (
    <div style={{ overflow: "hidden", borderRadius: 6, border: "1px solid var(--color-border)" }}>
      <table style={{ width: "100%", fontFamily: "monospace", fontSize: 14 }}>
        <thead
          style={{
            backgroundColor: "var(--color-surface-1)",
            textAlign: "left",
            color: "var(--color-text-secondary)",
          }}
        >
          <tr>
            <th style={{ padding: "8px 12px" }}>Label</th>
            <th style={{ padding: "8px 12px" }}>Family</th>
            <th style={{ padding: "8px 12px" }}>Class</th>
            <th style={{ padding: "8px 12px" }}>Scope</th>
            <th style={{ padding: "8px 12px" }}>Rel</th>
            <th style={{ width: 160 }}></th>
          </tr>
        </thead>
        <tbody>
          {data.map((row) => (
            <tr
              key={row.id}
              style={{
                borderTop: "1px solid var(--color-border)",
                backgroundColor: "var(--color-surface-1)",
              }}
            >
              <td style={{ padding: "8px 12px" }}>{row.label}</td>
              <td style={{ padding: "8px 12px", color: "var(--color-text-secondary)" }}>
                {row.family}
              </td>
              <td style={{ padding: "8px 12px" }}>{row.class}</td>
              <td style={{ padding: "8px 12px", color: "var(--color-text-secondary)" }}>
                {row.scope}
              </td>
              <td
                style={{
                  padding: "8px 12px",
                  color: "var(--color-brand)",
                  wordBreak: "break-all",
                }}
              >
                {row.rel}
              </td>
              <td style={{ padding: "8px 12px", textAlign: "right" }}>
                {row.installed &&
                  (pending === row.rel ? (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                      {row.scope !== "candidate" && (
                        <label
                          style={{
                            display: "flex",
                            gap: 4,
                            fontSize: 12,
                            color: "var(--color-text-secondary)",
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={force}
                            onChange={(e) => {
                              setForce(e.target.checked);
                            }}
                          />
                          force
                        </label>
                      )}
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={uninstalling}
                        onClick={() => {
                          onUninstall(row.rel, force);
                        }}
                      >
                        {uninstalling ? "…" : "Confirm"}
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={uninstalling}
                        onClick={() => {
                          setPending(null);
                          setForce(false);
                        }}
                      >
                        Cancel
                      </Button>
                    </span>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setPending(row.rel);
                      }}
                    >
                      Uninstall
                    </Button>
                  ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Models(): React.JSX.Element {
  const qc = useQueryClient();
  const scope = useModelsStore((s) => s.scope);
  const catalog = trpc.catalogList.useQuery(scope);
  const [report, setReport] = useState<UninstallReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const unMut = trpc.uninstall.useMutation({
    onSuccess: async (res) => {
      if (res.code === 0) {
        setReport(res);
        setError(null);
      } else {
        setReport(null);
        setError(res.error ?? `Uninstall refused (${String(res.code)})`);
      }
      await qc.invalidateQueries({ queryKey: [["catalogList"]] });
      await qc.invalidateQueries({ queryKey: [["promotions"]] });
    },
    onError: (err) => {
      setError(err.message);
    },
  });

  return (
    <div
      style={{ height: "100%", overflow: "auto", padding: 24 }}
      data-testid="models-catalog-root"
    >
      <div
        style={{
          marginBottom: 4,
          fontSize: 12,
          textTransform: "uppercase",
          color: "var(--color-text-secondary)",
        }}
      >
        Models
      </div>
      <h1 style={{ marginBottom: 16, fontSize: 24, fontWeight: 600 }}>
        Catalog ({String(catalog.data?.length ?? 0)})
      </h1>
      <ScopeTabs />
      {error && (
        <div
          style={{
            marginBottom: 12,
            borderRadius: 6,
            border: "1px solid var(--color-err)",
            padding: "8px 12px",
            color: "var(--color-err)",
          }}
        >
          {error}
        </div>
      )}
      {report && (
        <div
          style={{
            marginBottom: 12,
            borderRadius: 6,
            border: "1px solid var(--color-ok)",
            padding: "8px 12px",
            color: "var(--color-ok)",
          }}
        >
          <div style={{ marginBottom: 4 }}>Uninstalled {report.rel}</div>
          <ul style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
            {report.actions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </div>
      )}
      {catalog.isSuccess && catalog.data.length === 0 ? (
        <EditorialHero
          title={`No entries for "${scope}"`}
          lede="Pull a new model to see it here."
        />
      ) : (
        <CatalogTable
          data={catalog.data ?? []}
          onUninstall={(rel, f) => {
            unMut.mutate({ rel, force: f });
          }}
          uninstalling={unMut.isPending}
        />
      )}
    </div>
  );
}
