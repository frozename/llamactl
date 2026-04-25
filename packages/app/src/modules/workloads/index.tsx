import * as React from 'react';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Layers } from 'lucide-react';
import * as YAML from 'yaml';
import { trpc } from '@/lib/trpc';
import { Badge, Button, StatusDot, Input } from '@/ui';
import { WorkersPanel, type WorkerManifest } from './workers-panel';

/**
 * Workloads module. Drives the declarative `ModelRun` manifests stored
 * under `~/.llamactl/workloads/*.yaml`. Shows every manifest's live
 * phase (Running / Stopped / Mismatch / Unreachable) against the node
 * it targets, with one-click Apply / Describe / Delete.
 *
 * Apply accepts raw YAML. A "Template" button pre-fills a minimal
 * ModelRun skeleton for the currently selected node + rel so the user
 * doesn't have to remember the schema.
 */

type Phase = 'Running' | 'Stopped' | 'Mismatch' | 'Unreachable';

interface WorkloadRow {
  name: string;
  node: string;
  rel: string;
  phase: Phase;
  endpoint: string | null;
  status: unknown;
  /**
   * E.4 — multi-node summary. `workerCount === 0` means single-node;
   * no badge is rendered. `workerNodes` is a plain string[] shown on
   * hover / for compactness. Full per-worker detail comes from
   * `workloadDescribe` when the drawer opens.
   */
  workerCount: number;
  workerNodes: string[];
}

function ApplyPanel(props: { onDone: () => void }): React.JSX.Element {
  const qc = useQueryClient();
  const utils = trpc.useUtils();
  const nodes = trpc.nodeList.useQuery();
  const [yaml, setYaml] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Template inputs
  const [tplName, setTplName] = useState('');
  const [tplNode, setTplNode] = useState('local');
  const [tplTarget, setTplTarget] = useState('');

  const apply = trpc.workloadApply.useMutation({
    onSuccess: (res) => {
      setSuccess(`${res.action} ${res.name} on ${res.node}`);
      setError(null);
      setYaml('');
      void utils.workloadList.invalidate();
      void qc.invalidateQueries();
      props.onDone();
    },
    onError: (err) => {
      setError(err.message);
      setSuccess(null);
    },
  });

  const templateArgs = {
    name: tplName.trim(),
    node: tplNode.trim(),
    target: tplTarget.trim(),
    targetKind: 'rel' as const,
    extraArgs: [] as string[],
    timeoutSeconds: 60,
  };
  const template = trpc.workloadTemplate.useQuery(templateArgs, {
    enabled: false,
    retry: false,
  });

  const validate = trpc.workloadValidate.useQuery(
    { yaml },
    { enabled: false, retry: false },
  );

  async function onValidate(): Promise<void> {
    if (!yaml.trim()) {
      setError('YAML is empty.');
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
  }

  async function onTemplate(): Promise<void> {
    if (!tplName.trim() || !tplTarget.trim()) {
      setError('Fill template name, node, and target before generating.');
      return;
    }
    setError(null);
    const r = await template.refetch();
    if (r.data) {
      setYaml(YAML.stringify(r.data));
    } else if (r.error) {
      setError(r.error.message);
    }
  }

  function onSubmit(): void {
    setError(null);
    setSuccess(null);
    if (!yaml.trim()) {
      setError('YAML is required.');
      return;
    }
    apply.mutate({ yaml });
  }

  const nodeOptions = nodes.data?.nodes.map((n) => n.name) ?? ['local'];

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="mt-4 space-y-3 rounded border border-[var(--color-border)] bg-[var(--color-surface-1)] p-4"
    >
      <div className="font-medium text-[color:var(--color-text)]" style={{ fontSize: 14 }}>
        Apply a workload
      </div>
      <div className="flex flex-wrap items-end gap-2" style={{ fontSize: 12 }}>
        <div className="flex flex-col">
          <label className="text-[color:var(--color-text-secondary)]">name</label>
          <Input
            type="text"
            placeholder="gemma-qa"
            value={tplName}
            onChange={(e) => setTplName(e.target.value)}
          />
        </div>
        <div className="flex flex-col">
          <label className="text-[color:var(--color-text-secondary)]">node</label>
          <select
            value={tplNode}
            onChange={(e) => setTplNode(e.target.value)}
            className="w-32 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-[color:var(--color-text)]"
          >
            {nodeOptions.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-1 flex-col">
          <label className="text-[color:var(--color-text-secondary)]">target (rel path)</label>
          <Input
            type="text"
            placeholder="gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf"
            value={tplTarget}
            onChange={(e) => setTplTarget(e.target.value)}
          />
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => { void onTemplate(); }}
          disabled={template.isFetching}
        >
          {template.isFetching ? 'Generating…' : 'Generate YAML'}
        </Button>
      </div>
      <textarea
        placeholder="apiVersion: llamactl/v1&#10;kind: ModelRun&#10;metadata:&#10;  name: gemma-qa&#10;spec:&#10;  node: local&#10;  target:&#10;    kind: rel&#10;    value: …"
        value={yaml}
        onChange={(e) => setYaml(e.target.value)}
        className="h-48 w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 font-mono text-[color:var(--color-text)]"
        style={{ fontSize: 12 }}
      />
      <div className="flex items-center gap-2" style={{ fontSize: 14 }}>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={apply.isPending}
        >
          {apply.isPending ? 'Applying…' : 'Apply'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onValidate}
          disabled={validate.isFetching}
        >
          {validate.isFetching ? 'Validating…' : 'Validate'}
        </Button>
        {error && <span className="text-[color:var(--color-err)]" style={{ fontSize: 12 }}>{error}</span>}
        {success && <span className="text-[color:var(--color-ok)]" style={{ fontSize: 12 }}>{success}</span>}
      </div>
    </form>
  );
}

function WorkloadRow(props: { row: WorkloadRow }): React.JSX.Element {
  const qc = useQueryClient();
  const utils = trpc.useUtils();
  const { row } = props;
  const [showDescribe, setShowDescribe] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [keepRunning, setKeepRunning] = useState(false);
  const describe = trpc.workloadDescribe.useQuery(
    { name: row.name },
    { enabled: showDescribe },
  );
  const del = trpc.workloadDelete.useMutation({
    onSuccess: () => {
      setConfirmDelete(false);
      void utils.workloadList.invalidate();
      void qc.invalidateQueries();
    },
  });

  return (
    <div
      className="rounded border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3"
      data-testid={`workloads-row-${row.name}`}
      data-phase={row.phase}
      data-node={row.node}
    >
      <div className="flex items-baseline justify-between gap-4">
        <div className="flex items-baseline gap-2">
          <Badge variant="default" className="font-mono text-[color:var(--color-text)]" style={{ fontSize: 14 }}>{row.name}</Badge>
          <span className="flex items-center gap-1 rounded border border-[var(--color-border)] bg-[var(--color-surface-1)] px-1.5 py-0.5 text-[color:var(--color-text)]" style={{ fontSize: 10 }}>
            <StatusDot tone={row.phase === 'Running' ? 'ok' : row.phase === 'Mismatch' ? 'warn' : row.phase === 'Unreachable' ? 'err' : 'idle'} />
            {row.phase}
          </span>
          <span className="text-[color:var(--color-text-secondary)]" style={{ fontSize: 12 }}>
            node <span className="font-mono">{row.node}</span>
          </span>
          {row.workerCount > 0 && (
            <span
              data-testid="workloads-row-workers-badge"
              title={`workers: ${row.workerNodes.join(', ')}`}
              className="inline-flex items-center gap-1 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1.5 py-0.5 text-[color:var(--color-text-secondary)]"
              style={{ fontSize: 10 }}
            >
              <Layers className="h-3 w-3" aria-hidden="true" />
              <span>
                {row.workerCount} worker{row.workerCount === 1 ? '' : 's'}
              </span>
            </span>
          )}
        </div>
        <div className="flex gap-1" style={{ fontSize: 12 }}>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setShowDescribe((v) => !v)}
          >
            {showDescribe ? 'Hide' : 'Describe'}
          </Button>
          {confirmDelete ? (
            <>
              <label className="flex items-center gap-1 text-[color:var(--color-text-secondary)]" style={{ fontSize: 10 }}>
                <input
                  type="checkbox"
                  checked={keepRunning}
                  onChange={(e) => setKeepRunning(e.target.checked)}
                />
                keep server running
              </label>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => del.mutate({ name: row.name, keepRunning })}
                disabled={del.isPending}
              >
                {del.isPending ? 'Deleting…' : 'Confirm delete'}
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setConfirmDelete(false)}
              >
                Cancel
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setConfirmDelete(true)}
            >
              Delete
            </Button>
          )}
        </div>
      </div>
      <div className="mt-1 text-[color:var(--color-text-secondary)]" style={{ fontSize: 12 }}>
        <span>rel: </span>
        <Badge variant="brand" className="font-mono">{row.rel}</Badge>
        {row.endpoint && (
          <>
            <span> · endpoint: </span>
            <a
              href={row.endpoint}
              target="_blank"
              rel="noreferrer"
              className="font-mono underline"
            >
              {row.endpoint}
            </a>
          </>
        )}
      </div>
      {showDescribe && (
        <div className="mt-2 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2" style={{ fontSize: 12 }}>
          {describe.isLoading ? (
            <span className="text-[color:var(--color-text-secondary)]">Loading…</span>
          ) : describe.error ? (
            <span className="text-[color:var(--color-err)]">{describe.error.message}</span>
          ) : describe.data ? (
            <div className="space-y-2">
              <WorkersPanel
                workers={
                  (describe.data.manifest.spec.workers ?? []) as WorkerManifest[]
                }
              />
              <div>
                <div className="font-medium text-[color:var(--color-text)]">Manifest</div>
                <pre className="mt-1 overflow-x-auto whitespace-pre font-mono text-[color:var(--color-text)]" style={{ fontSize: 10 }}>
                  {YAML.stringify(describe.data.manifest)}
                </pre>
              </div>
              <div>
                <div className="font-medium text-[color:var(--color-text)]">Live status</div>
                <pre className="mt-1 overflow-x-auto whitespace-pre font-mono text-[color:var(--color-text)]" style={{ fontSize: 10 }}>
                  {JSON.stringify(describe.data.liveStatus, null, 2)}
                </pre>
              </div>
            </div>
          ) : null}
        </div>
      )}
      {del.error && (
        <div className="mt-2 text-[color:var(--color-err)]" style={{ fontSize: 12 }}>{del.error.message}</div>
      )}
      {del.data && del.data.stops.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-[color:var(--color-text-secondary)]" style={{ fontSize: 12 }}>
          {del.data.stops.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ReconcilerToolbar(): React.JSX.Element {
  const qc = useQueryClient();
  const utils = trpc.useUtils();
  const status = trpc.reconcilerStatus.useQuery(undefined, {
    refetchInterval: 5000,
  });
  const start = trpc.reconcilerStart.useMutation({
    onSuccess: () => {
      void utils.reconcilerStatus.invalidate();
      void utils.workloadList.invalidate();
    },
  });
  const stop = trpc.reconcilerStop.useMutation({
    onSuccess: () => {
      void utils.reconcilerStatus.invalidate();
    },
  });
  const kick = trpc.reconcilerKick.useMutation({
    onSuccess: () => {
      void utils.reconcilerStatus.invalidate();
      void utils.workloadList.invalidate();
      void qc.invalidateQueries();
    },
  });

  const running = status.data?.running ?? false;
  const intervalSec = status.data ? Math.round(status.data.intervalMs / 1000) : 10;
  const lastPass = status.data?.lastPassAt
    ? new Date(status.data.lastPassAt).toLocaleTimeString()
    : '—';
  const errors = status.data?.lastResult?.errors ?? 0;
  const reports = status.data?.lastResult?.reports ?? [];
  const actionCounts = reports.reduce<Record<string, number>>((acc, r) => {
    acc[r.action] = (acc[r.action] ?? 0) + 1;
    return acc;
  }, {});
  const summary =
    reports.length === 0
      ? 'no workloads reconciled yet'
      : Object.entries(actionCounts)
          .map(([k, v]) => `${k}:${v}`)
          .join(' · ');

  return (
    <div className="flex items-center justify-between rounded border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-2" style={{ fontSize: 12 }}>
      <div className="flex items-center gap-2">
        <StatusDot tone={running ? 'ok' : 'idle'} />
        <span className="text-[color:var(--color-text)]">
          auto-heal {running ? 'on' : 'off'}
        </span>
        <span className="text-[color:var(--color-text-secondary)]">
          · every {intervalSec}s · last {lastPass}
          {errors > 0 && (
            <>
              {' · '}
              <span className="text-[color:var(--color-err)]">{errors} errors</span>
            </>
          )}
          {' · '}
          <span>{summary}</span>
        </span>
      </div>
      <div className="flex gap-1">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => kick.mutate()}
          disabled={kick.isPending}
          title="run one reconcile pass now"
        >
          {kick.isPending ? '…' : 'Kick'}
        </Button>
        {running ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => stop.mutate()}
            disabled={stop.isPending}
          >
            Stop
          </Button>
        ) : (
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={() => start.mutate({ intervalSeconds: 10 })}
            disabled={start.isPending}
          >
            Start
          </Button>
        )}
      </div>
    </div>
  );
}

export default function Workloads(): React.JSX.Element {
  const list = trpc.workloadList.useQuery();
  // Server-resolved path the store actually scans — avoids hard-coding
  // `~/.llamactl/workloads/*.yaml` in the subheader when `$DEV_STORAGE`
  // or `$LLAMACTL_WORKLOADS_DIR` point elsewhere (e.g. hermetic audits).
  const workloadsDir = trpc.workloadsDir.useQuery();
  const [showApply, setShowApply] = useState(false);

  if (list.isLoading) {
    return (
      <div className="h-full" data-testid="workloads-model-runs-root">
        <div className="p-6 text-[color:var(--color-text-secondary)]" style={{ fontSize: 14 }}>Loading…</div>
      </div>
    );
  }
  if (list.error) {
    return (
      <div className="h-full" data-testid="workloads-model-runs-root">
        <div className="p-6 text-[color:var(--color-err)]" style={{ fontSize: 14 }}>
          Failed to load workloads: {list.error.message}
        </div>
      </div>
    );
  }

  const rows = (list.data ?? []) as WorkloadRow[];

  return (
    <div className="flex flex-col gap-4 p-6" data-testid="workloads-model-runs-root">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-lg font-semibold text-[color:var(--color-text)]">Workloads</h1>
          <div className="text-[color:var(--color-text-secondary)]" style={{ fontSize: 12 }}>
            Declarative ModelRun manifests (
            <span className="font-mono">
              {workloadsDir.data?.dir ?? '…'}/*.yaml
            </span>
            )
          </div>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => setShowApply((v) => !v)}
        >
          {showApply ? 'Cancel' : 'Apply workload'}
        </Button>
      </div>
      {showApply && <ApplyPanel onDone={() => setShowApply(false)} />}
      <ReconcilerToolbar />
      <div className="space-y-2">
        {rows.length === 0 && (
          <div
            data-testid="workloads-empty"
            className="rounded-md border border-dashed border-[var(--color-border)] bg-[var(--color-surface-1)] p-6"
          >
            <h2 className="font-semibold text-[color:var(--color-text)]" style={{ fontSize: 14 }}>
              Declare a workload to self-heal
            </h2>
            <p className="mt-1 text-[color:var(--color-text-secondary)]" style={{ fontSize: 12 }}>
              A <span className="font-mono">ModelRun</span> manifest pins a model
              to a node. The reconciler keeps it running, restarts it on crash,
              and corrects drift when extra args change. Use it for long-lived
              endpoints that shouldn't depend on someone typing{' '}
              <span className="font-mono">llamactl server start</span>.
            </p>
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={() => setShowApply(true)}
              data-testid="workloads-apply"
            >
              Apply workload
            </Button>
          </div>
        )}
        {rows.map((row) => (
          <WorkloadRow key={row.name} row={row} />
        ))}
      </div>
    </div>
  );
}
