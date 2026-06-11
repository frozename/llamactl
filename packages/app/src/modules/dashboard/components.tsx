import type { schemas } from "@llamactl/core";

import * as React from "react";

import { StatCard } from "@/ui";

type PresetOverride = schemas.PresetOverride;

export function DashboardStats({
  env,
  activeModel,
}: {
  env: Record<string, string | number | undefined> | undefined;
  activeModel: string;
}): React.JSX.Element {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12 }}>
      <StatCard label="Profile" value={String(env?.LLAMA_CPP_MACHINE_PROFILE ?? "—")} />
      <StatCard label="Provider" value={String(env?.LOCAL_AI_PROVIDER ?? "—")} />
      <StatCard label="Default Model" value={String(env?.LLAMA_CPP_DEFAULT_MODEL ?? "—")} />
      <StatCard label="Active Model" value={activeModel} />
      <StatCard label="Context Length" value={String(env?.LOCAL_AI_CONTEXT_LENGTH ?? "—")} />
      <StatCard label="Provider URL" value={String(env?.LOCAL_AI_PROVIDER_URL ?? "—")} />
    </div>
  );
}

export function DashboardPromotions({
  promotions,
}: {
  promotions: PresetOverride[];
}): React.JSX.Element {
  return (
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
        Promotions ({String(promotions.length)})
      </h2>
      {promotions.length === 0 ? (
        <div
          style={{
            borderRadius: "var(--r-md)",
            border: "1px dashed var(--color-border)",
            padding: 16,
            color: "var(--color-text-secondary)",
          }}
        >
          No preset overrides active.
        </div>
      ) : (
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
          {promotions.map((p) => (
            <li
              key={`${p.profile}:${p.preset}`}
              style={{
                borderRadius: "var(--r-md)",
                border: "1px solid var(--color-border)",
                background: "var(--color-surface-1)",
                padding: "8px 12px",
              }}
            >
              <span style={{ color: "var(--color-brand)" }}>{p.profile}</span>
              <span style={{ margin: "0 4px", color: "var(--color-text-secondary)" }}>·</span>
              <span>{p.preset}</span>
              <span style={{ margin: "0 8px", color: "var(--color-text-secondary)" }}>→</span>
              <span style={{ color: "var(--color-ok)" }}>{p.rel}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
