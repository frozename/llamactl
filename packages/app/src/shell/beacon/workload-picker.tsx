import * as React from "react";

import { useActiveWorkload } from "@/hooks/useActiveWorkload";

export function WorkloadPicker(): React.JSX.Element | null {
  const { workload, workloads, setWorkload, loading } = useActiveWorkload();

  if (loading || workloads.length === 0) return null;
  if (workloads.length === 1) {
    return (
      <span
        data-testid="beacon-workload-picker"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          color: "var(--color-text-secondary)",
        }}
      >
        <span aria-hidden="true">▸</span>
        <span>{workloads[0]!.name}</span>
      </span>
    );
  }

  return (
    <select
      data-testid="beacon-workload-picker"
      aria-label="Active workload"
      value={workload ?? ""}
      onChange={(e) => {
        setWorkload(e.target.value || null);
      }}
      style={{
        appearance: "none",
        border: "1px solid var(--color-border)",
        borderRadius: "var(--r-sm)",
        background: "var(--color-surface-2)",
        color: "var(--color-text-secondary)",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        lineHeight: "16px",
        padding: "1px 8px",
        maxWidth: 180,
      }}
    >
      {workloads.map((w) => (
        <option key={w.name} value={w.name}>
          {w.name}
        </option>
      ))}
    </select>
  );
}
