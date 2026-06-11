import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { useMemo, useState } from "react";
import { stringify as yamlStringify } from "yaml";

import { trpc } from "@/lib/trpc";
import { Button } from "@/ui";

function ExposeFields(props: {
  name: string;
  onNameChange: (v: string) => void;
  node: string;
  onNodeChange: (v: string) => void;
  rel: string;
  onRelChange: (v: string) => void;
  nodeOptions: string[];
  catalogRels: string[];
  busy: boolean;
  canSubmit: boolean;
}): React.JSX.Element {
  const { name, node, rel, nodeOptions, catalogRels, busy, canSubmit } = props;
  return (
    <div
      style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 8, fontSize: 12 }}
    >
      <div style={{ display: "flex", flexDirection: "column" }}>
        <label style={{ color: "var(--color-text-secondary)" }}>name</label>
        <input
          type="text"
          placeholder="gemma-qa"
          value={name}
          onChange={(e) => {
            props.onNameChange(e.target.value);
          }}
          data-testid="dashboard-expose-name"
          style={{
            width: 160,
            borderRadius: "var(--r-md)",
            border: "1px solid var(--color-border)",
            background: "var(--color-surface-2)",
            padding: "4px 8px",
            color: "var(--color-text)",
          }}
        />
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <label style={{ color: "var(--color-text-secondary)" }}>node</label>
        <select
          value={node}
          onChange={(e) => {
            props.onNodeChange(e.target.value);
          }}
          style={{
            width: 128,
            borderRadius: "var(--r-md)",
            border: "1px solid var(--color-border)",
            background: "var(--color-surface-2)",
            padding: "4px 8px",
            color: "var(--color-text)",
          }}
        >
          {nodeOptions.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>
      <div style={{ display: "flex", flex: 1, flexDirection: "column" }}>
        <label style={{ color: "var(--color-text-secondary)" }}>rel</label>
        <input
          type="text"
          placeholder="rel path"
          list="dashboard-rel-suggestions"
          value={rel}
          onChange={(e) => {
            props.onRelChange(e.target.value);
          }}
          style={{
            width: "100%",
            borderRadius: "var(--r-md)",
            border: "1px solid var(--color-border)",
            background: "var(--color-surface-2)",
            padding: "4px 8px",
            fontFamily: "var(--font-mono)",
            color: "var(--color-text)",
          }}
        />
        <datalist id="dashboard-rel-suggestions">
          {catalogRels.map((r) => (
            <option key={r} value={r} />
          ))}
        </datalist>
      </div>
      <Button
        type="submit"
        disabled={busy || !canSubmit}
        style={{ opacity: busy || !canSubmit ? 0.4 : 1 }}
      >
        {busy ? "Exposing…" : "Expose"}
      </Button>
    </div>
  );
}

export function ExposePanel(): React.JSX.Element {
  const qc = useQueryClient();
  const utils = trpc.useUtils();
  const nodes = trpc.nodeList.useQuery();
  const catalog = trpc.catalogList.useQuery();
  const [name, setName] = useState("");
  const [node, setNode] = useState("local");
  const [rel, setRel] = useState("");
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "error"; message: string }
    | { kind: "ok"; name: string; action: string; endpoint: string | null }
  >({ kind: "idle" });

  const apply = trpc.workloadApply.useMutation({
    onSuccess: (result) => {
      setStatus({
        kind: "ok",
        name: result.name,
        action: result.action,
        endpoint: result.status.endpoint,
      });
      void utils.workloadList.invalidate();
      void qc.invalidateQueries();
    },
    onError: (err) => {
      setStatus({ kind: "error", message: err.message });
    },
  });

  function onSubmit(): void {
    setStatus({ kind: "idle" });
    if (!name.trim() || !rel.trim() || !node.trim()) {
      setStatus({ kind: "error", message: "name, node, and rel are required" });
      return;
    }
    const manifest = {
      apiVersion: "llamactl/v1" as const,
      kind: "ModelRun" as const,
      metadata: { name: name.trim(), labels: {} },
      spec: {
        node: node.trim(),
        target: { kind: "rel" as const, value: rel.trim() },
        extraArgs: [],
        timeoutSeconds: 60,
        workers: [],
      },
    };
    apply.mutate({ yaml: yamlStringify(manifest) });
  }

  const nodeOptions = (nodes.data?.nodes ?? [])
    .filter((n) => n.effectiveKind === "agent")
    .map((n) => n.name);
  if (nodeOptions.length === 0) nodeOptions.push("local");
  const catalogRels = useMemo((): string[] => {
    if (!catalog.data) return [];
    return (catalog.data as { rel: string }[])
      .map((r) => r.rel)
      .filter((s): s is string => typeof s === "string" && s.length > 0);
  }, [catalog.data]);

  const canSubmit = name.trim().length > 0 && rel.trim().length > 0 && node.trim().length > 0;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      data-testid="dashboard-expose"
      style={{
        marginTop: 8,
        borderRadius: "var(--r-md)",
        border: "1px solid var(--color-border)",
        background: "var(--color-surface-1)",
        padding: 16,
      }}
    >
      <div style={{ marginBottom: 8, fontSize: 14, fontWeight: 500, color: "var(--color-text)" }}>
        Expose a model
      </div>
      <ExposeFields
        name={name}
        onNameChange={setName}
        node={node}
        onNodeChange={setNode}
        rel={rel}
        onRelChange={setRel}
        nodeOptions={nodeOptions}
        catalogRels={catalogRels}
        busy={apply.isPending}
        canSubmit={canSubmit}
      />
      {status.kind === "error" && (
        <div style={{ marginTop: 8, fontSize: 12, color: "var(--color-err)" }}>
          {status.message}
        </div>
      )}
      {status.kind === "ok" && (
        <div style={{ marginTop: 8, fontSize: 12, color: "var(--color-ok)" }}>
          {status.action} {status.name}
          {status.endpoint && (
            <>
              {" "}
              ·{" "}
              <a
                href={status.endpoint}
                target="_blank"
                rel="noreferrer"
                style={{ fontFamily: "var(--font-mono)", textDecoration: "underline" }}
              >
                {status.endpoint}
              </a>
            </>
          )}
        </div>
      )}
    </form>
  );
}
