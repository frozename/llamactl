import * as React from "react";
import { useMemo, useState } from "react";

import { trpc } from "@/lib/trpc";

import type { PipelineRecord, RunningEntry } from "./pipeline-components";

import { DraftPanel, PipelineRow } from "./pipeline-components";
import { PipelineWizardModal } from "./pipeline-wizard";

export function PipelinesTab(props: {
  nodeName: string;
  availableNodes: string[];
}): React.JSX.Element {
  const { availableNodes, nodeName } = props;
  const list = trpc.ragPipelineList.useQuery(undefined, { retry: false });
  const rows = useMemo(
    () => (list.data as { pipelines: PipelineRecord[] } | undefined)?.pipelines ?? [],
    [list.data],
  );
  const runningQ = trpc.ragPipelineRunning.useQuery(undefined, {
    refetchInterval: 2000,
    retry: false,
  });
  const runningData = runningQ.data as { running: RunningEntry[] } | undefined;
  const runningByName = useMemo(() => {
    const m = new Map<string, RunningEntry>();
    for (const r of runningData?.running ?? []) m.set(r.name, r);
    return m;
  }, [runningData]);
  const [logsOpen, setLogsOpen] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);

  React.useEffect(() => {
    const curr = new Set(Array.from(runningByName.keys()));
    if (curr.size === 0 && list.isSuccess) void list.refetch();
  }, [runningByName, list.isSuccess, list]);

  const sorted = useMemo(() => [...rows].sort((a, b) => a.name.localeCompare(b.name)), [rows]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            setWizardOpen(true);
          }}
          className="rounded bg-[var(--color-brand)] px-3 py-1 text-xs text-white"
        >
          + New pipeline
        </button>
      </div>
      <DraftPanel selectedNode={nodeName} availableNodes={availableNodes} />
      <PipelineWizardModal
        open={wizardOpen}
        onClose={() => {
          setWizardOpen(false);
        }}
        onApplied={() => {
          setWizardOpen(false);
        }}
        availableRagNodes={availableNodes}
        defaultRagNode={nodeName}
      />
      {list.isLoading ? (
        <div>Loading…</div>
      ) : sorted.length === 0 ? (
        <div className="p-6 border border-dashed text-color-text-secondary">No pipelines yet.</div>
      ) : (
        <div className="overflow-hidden rounded-md border border-[var(--color-border)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-surface-1)] text-left">
              <tr>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Sources</th>
                <th className="px-3 py-2">Schedule</th>
                <th className="px-3 py-2">Last run</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((rec) => (
                <PipelineRow
                  key={rec.name}
                  rec={rec}
                  running={runningByName.get(rec.name) ?? null}
                  onLogsToggle={() => {
                    setLogsOpen(logsOpen === rec.name ? null : rec.name);
                  }}
                  logsOpen={logsOpen === rec.name}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
