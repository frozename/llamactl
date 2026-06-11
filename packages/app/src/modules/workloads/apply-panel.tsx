import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { useState } from "react";
import * as YAML from "yaml";

import { trpc } from "@/lib/trpc";
import { Button, Input } from "@/ui";

export function ApplyPanel(props: { onDone: () => void }): React.JSX.Element {
  const qc = useQueryClient();
  const utils = trpc.useUtils();
  const nodes = trpc.nodeList.useQuery();
  const [yaml, setYaml] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [tpl, setTpl] = useState({ name: "", node: "local", target: "" });

  const apply = trpc.workloadApply.useMutation({
    onSuccess: (res) => {
      setSuccess(`${res.action} ${res.name} on ${res.node}`);
      setError(null);
      setYaml("");
      void utils.workloadList.invalidate();
      void qc.invalidateQueries();
      props.onDone();
    },
    onError: (err) => {
      setError(err.message);
      setSuccess(null);
    },
  });

  const template = trpc.workloadTemplate.useQuery(
    {
      name: tpl.name.trim(),
      node: tpl.node.trim(),
      target: tpl.target.trim(),
      targetKind: "rel",
      extraArgs: [],
      timeoutSeconds: 60,
    },
    { enabled: false, retry: false },
  );
  const validate = trpc.workloadValidate.useQuery({ yaml }, { enabled: false, retry: false });

  const onValidate = async (): Promise<void> => {
    if (!yaml.trim()) {
      setError("YAML is empty.");
      return;
    }
    const r = await validate.refetch();
    if (r.data?.ok) {
      setError(null);
      setSuccess(`valid: ${r.data.manifest.metadata.name} → ${r.data.manifest.spec.node}`);
    } else if (r.data) {
      setError(r.data.error);
      setSuccess(null);
    }
  };

  const onTemplate = async (): Promise<void> => {
    if (!tpl.name.trim() || !tpl.target.trim()) {
      setError("Fill fields before generating.");
      return;
    }
    setError(null);
    const r = await template.refetch();
    if (r.data) setYaml(YAML.stringify(r.data));
    else if (r.error) setError(r.error.message);
  };

  const onSubmit = (e: React.SyntheticEvent): void => {
    e.preventDefault();
    if (yaml.trim()) {
      apply.mutate({ yaml });
    } else {
      setError("YAML required.");
    }
  };

  return (
    <form onSubmit={onSubmit} className="mt-3 p-4 border rounded bg-surface-1 border-border">
      <div className="font-medium text-sm text-primary mb-3">Apply a workload</div>
      <div className="flex flex-wrap items-end gap-2 text-xs mb-3">
        <label className="flex flex-col">
          <span className="text-secondary mb-1">name</span>
          <Input
            type="text"
            placeholder="gemma-qa"
            value={tpl.name}
            onChange={(e) => {
              setTpl({ ...tpl, name: e.target.value });
            }}
          />
        </label>
        <label className="flex flex-col">
          <span className="text-secondary mb-1">node</span>
          <select
            value={tpl.node}
            onChange={(e) => {
              setTpl({ ...tpl, node: e.target.value });
            }}
            className="w-32 px-2 py-1 font-mono border rounded bg-surface-2 border-border text-primary"
          >
            {(nodes.data?.nodes.map((n) => n.name) ?? ["local"]).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col flex-1">
          <span className="text-secondary mb-1">target (rel path)</span>
          <Input
            type="text"
            placeholder="unsloth/gemma-4-..."
            value={tpl.target}
            onChange={(e) => {
              setTpl({ ...tpl, target: e.target.value });
            }}
          />
        </label>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => {
            void onTemplate();
          }}
          disabled={template.isFetching}
        >
          {template.isFetching ? "Generating…" : "Generate YAML"}
        </Button>
      </div>
      <textarea
        placeholder="apiVersion: llamactl/v1\nkind: ModelRun\n..."
        value={yaml}
        onChange={(e) => {
          setYaml(e.target.value);
        }}
        className="w-full h-48 p-2 font-mono text-xs border rounded bg-surface-2 border-border text-primary resize-y mb-3"
      />
      <div className="flex items-center gap-2 text-sm">
        <Button type="submit" variant="primary" size="sm" disabled={apply.isPending}>
          {apply.isPending ? "Applying…" : "Apply"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => {
            void onValidate();
          }}
          disabled={validate.isFetching}
        >
          {validate.isFetching ? "Validating…" : "Validate"}
        </Button>
        {error && <span className="text-xs text-err">{error}</span>}
        {success && <span className="text-xs text-ok">{success}</span>}
      </div>
    </form>
  );
}
