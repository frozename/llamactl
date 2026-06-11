import * as React from "react";
import { useState } from "react";
import { stringify as stringifyYaml } from "yaml";

import { trpc } from "@/lib/trpc";

import type { BenchReport } from "./quality-components";

import { BenchReportView } from "./quality-components";

function starterYaml(nodeName: string, collection: string | null): string {
  const manifest = {
    apiVersion: "llamactl/v1",
    kind: "RagBench",
    metadata: { name: `${nodeName.replaceAll(/[^a-z0-9-]/gi, "-")}-quality` },
    spec: {
      node: nodeName,
      ...(collection ? { collection } : {}),
      topK: 10,
      queries: [{ query: "question?", expected_substring: "answer" }],
    },
  };
  return stringifyYaml(manifest);
}

export function QualityTab(props: { nodeName: string; collection: string }): React.JSX.Element {
  const { collection, nodeName } = props;
  const [yaml, setYaml] = useState<string>(() =>
    starterYaml(nodeName, collection.trim() ? collection.trim() : null),
  );
  const [report, setReport] = useState<BenchReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const benchMut = trpc.ragBench.useMutation({
    onSuccess: (data) => {
      setReport(data);
      setError(null);
      setRunning(false);
    },
    onError: (err) => {
      setReport(null);
      setError(err.message);
      setRunning(false);
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-2 text-xs text-[color:var(--color-text-secondary)]">
        <span>
          Measure retrieval quality with a{" "}
          <span className="mono text-[color:var(--color-text)]">RagBench</span> manifest.
        </span>
        <button
          type="button"
          onClick={() => {
            setYaml(starterYaml(nodeName, collection.trim() ? collection.trim() : null));
          }}
          className="rounded border bg-[var(--color-surface-2)] px-2 py-0.5 text-[10px]"
        >
          Load starter
        </button>
      </div>
      <div className="grid grid-cols-12 gap-3">
        <label className="col-span-9 text-sm">
          <span className="mb-1 block text-xs text-[color:var(--color-text-secondary)]">
            RagBench manifest (YAML)
          </span>
          <textarea
            value={yaml}
            onChange={(e) => {
              setYaml(e.target.value);
              setError(null);
            }}
            rows={14}
            className="w-full rounded border bg-[var(--color-surface-2)] p-2 mono text-xs"
          />
        </label>
        <div className="col-span-3 flex flex-col gap-2">
          <button
            type="button"
            onClick={() => {
              setReport(null);
              setError(null);
              setRunning(true);
              benchMut.mutate({ manifestYaml: yaml });
            }}
            disabled={running || !yaml.trim()}
            className="rounded bg-[var(--color-brand)] px-3 py-2 text-sm text-white"
          >
            {running ? "Running…" : "Run bench"}
          </button>
          <span className="text-[10px]">
            Targets <span className="mono">{nodeName}</span>
          </span>
        </div>
      </div>
      {error && (
        <div className="rounded border border-[var(--color-err)] p-3 text-sm text-[color:var(--color-err)]">
          {error}
        </div>
      )}
      {report && <BenchReportView report={report} />}
    </div>
  );
}
