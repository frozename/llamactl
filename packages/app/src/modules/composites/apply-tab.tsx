import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { useState } from "react";
import * as YAML from "yaml";

import { trpc } from "@/lib/trpc";
import { Button } from "@/ui";

import type { ApplyResult, CompositeShape, DryRunResult, WetRunResult } from "./types";

import { DryRunPreview, WetRunSummary } from "./components";
import { rewriteRuntimeInYaml } from "./helpers";

const DEFAULT_YAML = `apiVersion: llamactl/v1\nkind: Composite\nmetadata:\n  name: my-stack\nspec:\n  services: []\n  workloads: []\n  ragNodes: []\n  gateways: []\n  dependencies: []\n  onFailure: rollback\n`;

function detectRuntimeInYaml(yaml: string): "auto" | "docker" | "kubernetes" {
  const m = /^\s{2}runtime:\s*(docker|kubernetes)\s*$/m.exec(yaml);
  if (m?.[1] === "docker" || m?.[1] === "kubernetes") return m[1];
  return "auto";
}

function ExistingComposites(props: {
  selected: string | null;
  onChange: (name: string | null) => void;
}): React.JSX.Element {
  const list = trpc.compositeList.useQuery();
  const rows = (list.data ?? []) as CompositeShape[];
  if (rows.length === 0)
    return (
      <span
        style={{
          fontFamily: "var(--font-mono)",
          color: "var(--color-text-secondary)",
          fontSize: 12,
        }}
      >
        no composites -- create a new one
      </span>
    );
  return (
    <select
      value={props.selected ?? ""}
      onChange={(e) => {
        props.onChange(e.target.value);
      }}
      style={{
        width: 256,
        borderRadius: "var(--r-md)",
        border: "1px solid var(--color-border)",
        background: "var(--color-surface-2)",
        padding: "4px 8px",
        fontFamily: "var(--font-mono)",
        color: "var(--color-text)",
        fontSize: 12,
      }}
    >
      <option value="" disabled>
        Select a composite
      </option>
      {rows.map((c) => (
        <option key={c.metadata.name} value={c.metadata.name}>
          {c.metadata.name}
        </option>
      ))}
    </select>
  );
}

interface ApplyFormState {
  mode: "new" | "edit";
  setMode: (m: "new" | "edit") => void;
  yamlText: string;
  setYamlText: (y: string) => void;
  dryRunOk: DryRunResult | null;
  wetResult: WetRunResult | null;
  error: string | null;
  dryRunYaml: string | null;
  busy: boolean;
  clearUnlockOnEdit: (next: string) => void;
  runDry: () => Promise<void>;
  runWet: () => Promise<void>;
}

function useApplyForm(props: {
  selectedName: string | null;
  onApplied: (name: string) => void;
}): ApplyFormState {
  const { selectedName, onApplied } = props;
  const qc = useQueryClient();
  const utils = trpc.useUtils();
  const existing = trpc.compositeGet.useQuery(
    { name: selectedName ?? "" },
    { enabled: !!selectedName },
  );
  const [mode, setMode] = useState<"new" | "edit">(selectedName ? "edit" : "new");
  const [yamlText, setYamlText] = useState<string>(DEFAULT_YAML);
  const [dryRunOk, setDryRunOk] = useState<DryRunResult | null>(null);
  const [wetResult, setWetResult] = useState<WetRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dryRunYaml, setDryRunYaml] = useState<string | null>(null);

  React.useEffect(() => {
    if (mode === "edit" && existing.data) {
      const manifest = existing.data as CompositeShape;
      const serializable = {
        apiVersion: manifest.apiVersion,
        kind: manifest.kind,
        metadata: manifest.metadata,
        spec: manifest.spec,
      };
      queueMicrotask(() => {
        setYamlText(YAML.stringify(serializable));
        setDryRunOk(null);
        setWetResult(null);
        setError(null);
        setDryRunYaml(null);
      });
    } else if (mode === "new") {
      queueMicrotask(() => {
        setDryRunOk(null);
        setWetResult(null);
        setError(null);
      });
    }
  }, [mode, existing.data]);

  const apply = trpc.compositeApply.useMutation({
    onError: (err) => {
      setError(err.message);
    },
  });
  const clearUnlockOnEdit = (next: string): void => {
    setYamlText(next);
    if (dryRunYaml !== null && dryRunYaml !== next) {
      setDryRunOk(null);
      setDryRunYaml(null);
    }
    setError(null);
  };

  async function runDry(): Promise<void> {
    setError(null);
    setWetResult(null);
    if (!yamlText.trim()) {
      setError("YAML is empty.");
      return;
    }
    try {
      const res = (await apply.mutateAsync({
        manifestYaml: yamlText,
        dryRun: true,
      })) as ApplyResult;
      if (res.dryRun) {
        setDryRunOk(res);
        setDryRunYaml(yamlText);
      }
    } catch {
      setDryRunOk(null);
      setDryRunYaml(null);
    }
  }

  async function runWet(): Promise<void> {
    setError(null);
    if (dryRunYaml !== yamlText || !dryRunOk) {
      setError("Dry-run first.");
      return;
    }
    try {
      const res = (await apply.mutateAsync({
        manifestYaml: yamlText,
        dryRun: false,
      })) as ApplyResult;
      if (!res.dryRun) {
        setWetResult(res);
        void utils.compositeList.invalidate();
        void qc.invalidateQueries();
        if (res.ok) onApplied(dryRunOk.manifest.metadata.name);
      }
    } catch (e: unknown) {
      /* ignore */
    }
  }

  return {
    mode,
    setMode,
    yamlText,
    setYamlText,
    dryRunOk,
    wetResult,
    error,
    dryRunYaml,
    busy: apply.isPending,
    clearUnlockOnEdit,
    runDry,
    runWet,
  };
}

const FIELD_LABEL_STYLE: React.CSSProperties = {
  marginBottom: 4,
  display: "block",
  color: "var(--color-text-secondary)",
  fontSize: 12,
};

function ModeButtons(props: {
  mode: "new" | "edit";
  onNew: () => void;
  onEdit: () => void;
}): React.JSX.Element {
  const { mode, onNew, onEdit } = props;
  return (
    <div style={{ display: "flex", gap: 4 }}>
      <Button
        type="button"
        onClick={onNew}
        style={{
          padding: "4px 12px",
          fontSize: 12,
          border: mode === "new" ? "1px solid var(--color-brand)" : "1px solid var(--color-border)",
          background: "var(--color-surface-2)",
        }}
      >
        New composite
      </Button>
      <Button
        type="button"
        onClick={onEdit}
        style={{
          padding: "4px 12px",
          fontSize: 12,
          border:
            mode === "edit" ? "1px solid var(--color-brand)" : "1px solid var(--color-border)",
          background: "var(--color-surface-2)",
        }}
      >
        Edit existing
      </Button>
    </div>
  );
}

function ApplyToolbar(props: {
  form: ApplyFormState;
  selectedName: string | null;
  onSelect: (name: string | null) => void;
}): React.JSX.Element {
  const { form, selectedName, onSelect } = props;
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "flex-end",
        gap: 12,
        borderRadius: "var(--r-md)",
        border: "1px solid var(--color-border)",
        background: "var(--color-surface-1)",
        padding: 12,
      }}
    >
      <label style={{ fontSize: 14 }}>
        <span style={FIELD_LABEL_STYLE}>Mode</span>
        <ModeButtons
          mode={form.mode}
          onNew={() => {
            form.setMode("new");
            onSelect(null);
            form.setYamlText(DEFAULT_YAML);
          }}
          onEdit={() => {
            form.setMode("edit");
          }}
        />
      </label>
      {form.mode === "edit" && (
        <label style={{ fontSize: 14 }}>
          <span style={FIELD_LABEL_STYLE}>Composite</span>
          <ExistingComposites selected={selectedName} onChange={onSelect} />
        </label>
      )}
      <label style={{ fontSize: 14 }}>
        <span style={FIELD_LABEL_STYLE}>Runtime</span>
        <select
          value={detectRuntimeInYaml(form.yamlText)}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
            form.clearUnlockOnEdit(
              rewriteRuntimeInYaml(
                form.yamlText,
                e.target.value as "auto" | "docker" | "kubernetes",
              ),
            );
          }}
          style={{
            borderRadius: "var(--r-md)",
            border: "1px solid var(--color-border)",
            background: "var(--color-surface-2)",
            padding: "4px 8px",
            color: "var(--color-text)",
            fontSize: 12,
          }}
        >
          <option value="auto">auto</option>
          <option value="docker">docker</option>
          <option value="kubernetes">kubernetes</option>
        </select>
      </label>
    </div>
  );
}

export function ApplyTab(props: {
  selectedName: string | null;
  onSelect: (name: string | null) => void;
  onApplied: (name: string) => void;
}): React.JSX.Element {
  const { selectedName, onSelect, onApplied } = props;
  const form = useApplyForm({ selectedName, onApplied });

  return (
    <div style={{ marginTop: 16 }}>
      <ApplyToolbar form={form} selectedName={selectedName} onSelect={onSelect} />
      <textarea
        value={form.yamlText}
        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => {
          form.clearUnlockOnEdit(e.target.value);
        }}
        rows={20}
        spellCheck={false}
        style={{
          width: "100%",
          borderRadius: "var(--r-md)",
          border: "1px solid var(--color-border)",
          background: "var(--color-surface-2)",
          padding: "4px 8px",
          fontFamily: "var(--font-mono)",
          color: "var(--color-text)",
          fontSize: 12,
        }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Button
          type="button"
          onClick={() => {
            void form.runDry();
          }}
          disabled={form.busy}
        >
          Dry-run
        </Button>
        <Button
          type="button"
          onClick={() => {
            void form.runWet();
          }}
          disabled={form.busy || !form.dryRunOk || form.dryRunYaml !== form.yamlText}
          style={{ background: "var(--color-brand)", color: "white" }}
        >
          Apply
        </Button>
        {form.error && (
          <span style={{ color: "var(--color-err)", fontSize: 12 }}>{form.error}</span>
        )}
      </div>
      {form.dryRunOk && !form.wetResult && <DryRunPreview result={form.dryRunOk} />}
      {form.wetResult && <WetRunSummary result={form.wetResult} />}
    </div>
  );
}
