import * as React from "react";

import { CandidateFilters, CandidateTable, PromotionsMatrix } from "./components";
import { usePresets } from "./use-presets";

/**
 * Preset gallery. Joins `promotions` (preset-overrides.tsv) with
 * `benchCompare` (bench history).
 */

export default function Presets(): React.JSX.Element {
  const presetsObj = usePresets();
  const { error } = presetsObj;

  return (
    <div
      style={{ height: "100%", overflow: "auto", padding: 24 }}
      data-testid="models-presets-root"
    >
      <div
        style={{
          marginBottom: 4,
          fontSize: 12,
          textTransform: "uppercase",
          letterSpacing: "0.1em",
          color: "var(--color-text-secondary)",
        }}
      >
        Presets
      </div>
      <h1 style={{ marginBottom: 16, fontSize: 24, fontWeight: 600, color: "var(--color-text)" }}>
        Promotions &amp; candidates
      </h1>

      {error && <PresetsError error={error} />}

      <PromotionsMatrix presetsObj={presetsObj} />

      <section>
        <CandidateFilters presetsObj={presetsObj} />
        <CandidateTable presetsObj={presetsObj} />
      </section>
    </div>
  );
}

function PresetsError({ error }: { error: string }): React.JSX.Element {
  return (
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
  );
}
