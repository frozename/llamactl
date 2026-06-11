import { useQueryClient } from "@tanstack/react-query";
import { Layers } from "lucide-react";
import * as React from "react";
import { useState } from "react";
import * as YAML from "yaml";

import { trpc } from "@/lib/trpc";
import { Badge, Button, StatusDot } from "@/ui";

import type { WorkloadRow as WorkloadRowType } from "./types";

import { type WorkerManifest, WorkersPanel } from "./workers-panel";

interface DescribeData {
  manifest: {
    metadata: { name: string };
    spec: {
      node: string;
      workers?: WorkerManifest[];
    };
  };
  liveStatus: unknown;
}

export function WorkloadRow(props: { row: WorkloadRowType }): React.JSX.Element {
  const qc = useQueryClient();
  const utils = trpc.useUtils();
  const { row } = props;
  const [showDescribe, setShowDescribe] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [keepRunning, setKeepRunning] = useState(false);
  const describe = trpc.workloadDescribe.useQuery({ name: row.name }, { enabled: showDescribe });
  const del = trpc.workloadDelete.useMutation({
    onSuccess: () => {
      setConfirmDelete(false);
      void utils.workloadList.invalidate();
      void qc.invalidateQueries();
    },
  });

  return (
    <div
      className="p-3 border rounded bg-surface-1 border-border"
      data-testid={`workloads-row-${row.name}`}
      data-phase={row.phase}
      data-node={row.node}
    >
      <div className="flex items-baseline justify-between gap-4">
        <div className="flex items-baseline gap-2">
          <Badge variant="default" className="font-mono text-sm text-primary">
            {row.name}
          </Badge>
          <span className="flex items-center gap-1 px-1.5 py-0.5 border rounded border-border bg-surface-1 text-[10px] text-primary">
            <StatusDot
              tone={
                row.phase === "Running"
                  ? "ok"
                  : row.phase === "Mismatch"
                    ? "warn"
                    : row.phase === "Unreachable"
                      ? "err"
                      : "idle"
              }
            />
            {row.phase}
          </span>
          <span className="text-xs text-secondary">
            node <span className="font-mono">{row.node}</span>
          </span>
          {row.workerCount > 0 && <WorkersBadge count={row.workerCount} nodes={row.workerNodes} />}
        </div>
        <div className="flex gap-1 text-xs">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              setShowDescribe((v) => !v);
            }}
          >
            {showDescribe ? "Hide" : "Describe"}
          </Button>
          {confirmDelete ? (
            <ConfirmDeleteControls
              keepRunning={keepRunning}
              setKeepRunning={setKeepRunning}
              onConfirm={() => {
                del.mutate({ name: row.name, keepRunning });
              }}
              onCancel={() => {
                setConfirmDelete(false);
              }}
              busy={del.isPending}
            />
          ) : (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                setConfirmDelete(true);
              }}
            >
              Delete
            </Button>
          )}
        </div>
      </div>
      <div className="mt-1 text-xs text-secondary flex items-baseline gap-1">
        <span>rel: </span>
        <Badge variant="brand" className="font-mono">
          {row.rel}
        </Badge>
        {row.endpoint && (
          <>
            <span> · endpoint: </span>
            <a href={row.endpoint} target="_blank" rel="noreferrer" className="font-mono underline">
              {row.endpoint}
            </a>
          </>
        )}
      </div>
      {showDescribe && <WorkloadDescribePanel query={describe} />}
      {del.error && <div className="mt-2 text-xs text-err">{del.error.message}</div>}
      {del.data && del.data.stops.length > 0 && (
        <ul className="mt-1 text-[10px] text-secondary">
          {del.data.stops.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function WorkersBadge({ count, nodes }: { count: number; nodes: string[] }): React.JSX.Element {
  return (
    <span
      data-testid="workloads-row-workers-badge"
      title={`workers: ${nodes.join(", ")}`}
      className="inline-flex items-center gap-1 px-1.5 py-0.5 border rounded border-border bg-surface-2 text-[10px] text-secondary"
    >
      <Layers style={{ height: 12, width: 12 }} aria-hidden="true" />
      <span>
        {count} worker{count === 1 ? "" : "s"}
      </span>
    </span>
  );
}

function ConfirmDeleteControls({
  keepRunning,
  setKeepRunning,
  onConfirm,
  onCancel,
  busy,
}: {
  keepRunning: boolean;
  setKeepRunning: (v: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
}): React.JSX.Element {
  return (
    <>
      <label className="flex items-center gap-1 text-[10px] text-secondary">
        <input
          type="checkbox"
          checked={keepRunning}
          onChange={(e) => {
            setKeepRunning(e.target.checked);
          }}
        />
        keep server running
      </label>
      <Button
        type="button"
        variant="destructive"
        size="sm"
        onClick={() => {
          onConfirm();
        }}
        disabled={busy}
      >
        {busy ? "Deleting…" : "Confirm delete"}
      </Button>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => {
          onCancel();
        }}
      >
        Cancel
      </Button>
    </>
  );
}

function WorkloadDescribePanel({
  query,
}: {
  query: ReturnType<typeof trpc.workloadDescribe.useQuery>;
}): React.JSX.Element {
  const data = query.data as DescribeData | undefined;
  return (
    <div className="mt-2 p-2 border rounded bg-surface-2 border-border text-xs">
      {query.isLoading ? (
        <span className="text-secondary">Loading…</span>
      ) : query.error ? (
        <span className="text-err">{query.error.message}</span>
      ) : data ? (
        <div className="space-y-3 mt-2">
          <WorkersPanel workers={data.manifest.spec.workers ?? []} />
          <div>
            <div className="font-medium text-primary">Manifest</div>
            <pre className="mt-1 overflow-x-auto font-mono text-[10px] text-primary bg-surface-3 p-2 rounded">
              {YAML.stringify(data.manifest)}
            </pre>
          </div>
          <div>
            <div className="font-medium text-primary">Live status</div>
            <pre className="mt-1 overflow-x-auto font-mono text-[10px] text-primary bg-surface-3 p-2 rounded">
              {JSON.stringify(data.liveStatus, null, 2)}
            </pre>
          </div>
        </div>
      ) : null}
    </div>
  );
}
