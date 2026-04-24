import * as React from 'react';
import { Suspense, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { stringify as yamlStringify } from 'yaml';
import type { bench, schemas } from '@llamactl/core';
import { trpc } from '@/lib/trpc';
import { EditorialHero } from '@/ui';
import { ThemedNodeMap } from './ThemedNodeMap';

type BenchCompareRow = bench.BenchCompareRow;
type PresetOverride = schemas.PresetOverride;

/**
 * "Expose a model" shortcut — wraps the CLI's `llamactl expose <rel>`
 * flow in a form. Builds a ModelRun manifest from (name, node, rel),
 * applies it via workloadApply, and surfaces the advertised URL so
 * other LAN hosts can hit the llama-server immediately.
 */
function ExposePanel(): React.JSX.Element {
  const qc = useQueryClient();
  const utils = trpc.useUtils();
  const nodes = trpc.nodeList.useQuery();
  const catalog = trpc.catalogList.useQuery();
  const [name, setName] = useState('');
  const [node, setNode] = useState('local');
  const [rel, setRel] = useState('');
  const [status, setStatus] = useState<
    | { kind: 'idle' }
    | { kind: 'error'; message: string }
    | { kind: 'ok'; name: string; action: string; endpoint: string | null }
  >({ kind: 'idle' });

  const apply = trpc.workloadApply.useMutation({
    onSuccess: (result) => {
      setStatus({
        kind: 'ok',
        name: result.name,
        action: result.action,
        endpoint: result.status?.endpoint ?? null,
      });
      void utils.workloadList.invalidate();
      void qc.invalidateQueries();
    },
    onError: (err) => setStatus({ kind: 'error', message: err.message }),
  });

  function onSubmit(): void {
    setStatus({ kind: 'idle' });
    if (!name.trim() || !rel.trim() || !node.trim()) {
      setStatus({ kind: 'error', message: 'name, node, and rel are required' });
      return;
    }
    const manifest = {
      apiVersion: 'llamactl/v1' as const,
      kind: 'ModelRun' as const,
      metadata: { name: name.trim(), labels: {} },
      spec: {
        node: node.trim(),
        target: { kind: 'rel' as const, value: rel.trim() },
        extraArgs: [],
        timeoutSeconds: 60,
        workers: [],
      },
    };
    apply.mutate({ yaml: yamlStringify(manifest) });
  }

  // Only agent-kind nodes can host a ModelRun workload. Gateways
  // (sirius, embersynth), cloud providers, and RAG nodes have no
  // llama-server to apply the manifest to — surfacing them in the
  // picker silently creates a workload phase=Failed when the
  // reconciler finds no agent behind the target.
  const nodeOptions = (nodes.data?.nodes ?? [])
    .filter((n) => (n.effectiveKind ?? 'agent') === 'agent')
    .map((n) => n.name);
  if (nodeOptions.length === 0) nodeOptions.push('local');
  const catalogRels = useMemo(() => {
    if (!catalog.data) return [] as string[];
    const rows = catalog.data as Array<{ rel?: string; name?: string }>;
    return rows
      .map((r) => r.rel)
      .filter((s): s is string => typeof s === 'string' && s.length > 0);
  }, [catalog.data]);
  const canSubmit = name.trim().length > 0 && rel.trim().length > 0 && node.trim().length > 0;
  const submitTitle = !canSubmit
    ? 'Fill in name and rel before exposing.'
    : `Apply ModelRun "${name.trim()}" on node ${node.trim()}.`;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      data-testid="dashboard-expose"
      className="mt-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-4"
    >
      <div className="mb-2 text-sm font-medium text-[color:var(--color-text)]">Expose a model</div>
      <div className="flex flex-wrap items-end gap-2 text-xs">
        <div className="flex flex-col">
          <label className="text-[color:var(--color-text-secondary)]">name</label>
          <input
            type="text"
            placeholder="gemma-qa"
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-testid="dashboard-expose-name"
            className="w-40 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-[color:var(--color-text)]"
          />
        </div>
        <div className="flex flex-col">
          <label className="text-[color:var(--color-text-secondary)]">node</label>
          <select
            value={node}
            onChange={(e) => setNode(e.target.value)}
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
          <label className="text-[color:var(--color-text-secondary)]">rel</label>
          <input
            type="text"
            placeholder="gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf"
            list="dashboard-rel-suggestions"
            value={rel}
            onChange={(e) => setRel(e.target.value)}
            className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 font-mono text-[color:var(--color-text)]"
          />
          <datalist id="dashboard-rel-suggestions">
            {catalogRels.map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
        </div>
        <button
          type="submit"
          disabled={apply.isPending || !canSubmit}
          data-testid="dashboard-expose-submit"
          title={submitTitle}
          className="rounded border border-[var(--color-border)] bg-[var(--color-brand)] px-3 py-1 font-medium text-[color:var(--color-brand-contrast)] shadow-sm disabled:cursor-not-allowed disabled:opacity-40"
        >
          {apply.isPending ? 'Exposing…' : 'Expose'}
        </button>
      </div>
      {status.kind === 'error' && (
        <div className="mt-2 text-xs text-[color:var(--color-err)]">{status.message}</div>
      )}
      {status.kind === 'ok' && (
        <div className="mt-2 text-xs text-[color:var(--color-ok)]">
          {status.action} {status.name}
          {status.endpoint && (
            <>
              {' · '}
              <a href={status.endpoint} target="_blank" rel="noreferrer" className="font-mono underline">
                {status.endpoint}
              </a>
            </>
          )}
        </div>
      )}
    </form>
  );
}

function ExposedWorkloads(): React.JSX.Element {
  const list = trpc.workloadList.useQuery(undefined, { refetchInterval: 5000 });
  const rows = (list.data ?? []) as Array<{
    name: string;
    node: string;
    rel: string;
    phase: string;
    endpoint: string | null;
  }>;
  const running = rows.filter((r) => r.phase === 'Running' && r.endpoint);
  if (running.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-[var(--color-border)] p-4 text-[color:var(--color-text-secondary)]">
        No workloads currently serving. Use "Expose a model" above to start one.
      </div>
    );
  }
  return (
    <ul className="space-y-1 mono text-sm">
      {running.map((w) => (
        <li
          key={w.name}
          className="flex items-center justify-between rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-2"
        >
          <div>
            <span className="text-[color:var(--color-brand)]">{w.name}</span>
            <span className="mx-1 text-[color:var(--color-text-secondary)]">·</span>
            <span className="text-[color:var(--color-text-secondary)]">{w.node}</span>
            <span className="mx-1 text-[color:var(--color-text-secondary)]">·</span>
            <span>{w.rel}</span>
          </div>
          {w.endpoint && (
            <a
              href={w.endpoint}
              target="_blank"
              rel="noreferrer"
              className="text-[color:var(--color-ok)] underline"
            >
              {w.endpoint}
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

function StatusCard({ title, body }: { title: string; body: string }): React.JSX.Element {
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-4">
      <div className="text-xs uppercase tracking-wide text-[color:var(--color-text-secondary)]">
        {title}
      </div>
      <div className="mt-1 mono text-sm break-all text-[color:var(--color-text)]">{body}</div>
    </div>
  );
}

function fmtTps(raw: string | undefined | null): string {
  if (raw == null) return '—';
  const n = typeof raw === 'number' ? raw : Number.parseFloat(raw);
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(1);
}

function DashboardBody(): React.JSX.Element {
  const envQuery = trpc.env.useQuery();
  const compareQuery = trpc.benchCompare.useQuery();
  const promotionsQuery = trpc.promotions.useQuery();
  // Poll alongside the Server module so "Active Model" reflects the
  // llama-server's actually-loaded rel rather than the LOCAL_AI_MODEL
  // env var (which defaults to a node alias when unset).
  const serverStatusQuery = trpc.serverStatus.useQuery(undefined, { refetchInterval: 5000 });

  if (envQuery.isLoading || compareQuery.isLoading || promotionsQuery.isLoading) {
    return <div className="p-6 text-[color:var(--color-text-secondary)]">Loading…</div>;
  }

  const env = envQuery.data;
  const rows = compareQuery.data ?? [];
  const promotions = promotionsQuery.data ?? [];
  const serverStatus = serverStatusQuery.data;
  const activeModel =
    serverStatus?.state === 'up' && serverStatus.rel ? serverStatus.rel : 'none';
  const topBench = [...rows]
    .filter((row: BenchCompareRow) => row.tuned)
    .sort((a: BenchCompareRow, b: BenchCompareRow) => {
      if (!a.tuned || !b.tuned) return 0;
      return Number.parseFloat(b.tuned.gen_tps) - Number.parseFloat(a.tuned.gen_tps);
    })
    .slice(0, 5);

  return (
    <div className="h-full overflow-auto p-6" data-testid="dashboard-root">
      <EditorialHero
        eyebrow="Dashboard"
        title="Your fleet"
        titleAccent="at a glance"
        lede="Nodes, workloads, and cost — in one view. Pin a workload or open a specific node from the Explorer to dig in."
        pills={[
          { label: 'healthy', tone: 'ok' },
          { label: 'Beacon', tone: 'info' },
        ]}
        style={{ marginBottom: 32 }}
      />


      {/* Cluster map is the dashboard's centerpiece — switching active
          nodes happens by clicking a bubble + "Set as active node" in
          the popover, which makes the topology + the routing target
          visible in one view (the title-bar dropdown is the legacy
          quick-jump fallback). */}
      <section className="mb-8" data-testid="dashboard-node-map-section">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
          Cluster map
        </h2>
        <ThemedNodeMap />
      </section>

      <div className="grid grid-cols-3 gap-3">
        <StatusCard title="Profile" body={env?.LLAMA_CPP_MACHINE_PROFILE ?? '—'} />
        <StatusCard title="Provider" body={env?.LOCAL_AI_PROVIDER ?? '—'} />
        <StatusCard title="Default Model" body={env?.LLAMA_CPP_DEFAULT_MODEL ?? '—'} />
        <StatusCard title="Active Model" body={activeModel} />
        <StatusCard title="Context Length" body={env?.LOCAL_AI_CONTEXT_LENGTH ?? '—'} />
        <StatusCard title="Provider URL" body={env?.LOCAL_AI_PROVIDER_URL ?? '—'} />
      </div>

      <section className="mt-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
          Exposed workloads
        </h2>
        <ExposedWorkloads />
        <ExposePanel />
      </section>

      <section className="mt-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
          Top benches (gen tps)
        </h2>
        {topBench.length === 0 ? (
          <div className="rounded-md border border-dashed border-[var(--color-border)] p-4 text-[color:var(--color-text-secondary)]">
            No tuned records yet.
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border border-[var(--color-border)]">
            <table className="w-full mono text-sm">
              <thead className="bg-[var(--color-surface-1)] text-left text-[color:var(--color-text-secondary)]">
                <tr>
                  <th className="px-3 py-2 font-medium">Model</th>
                  <th className="px-3 py-2 font-medium">Class</th>
                  <th className="px-3 py-2 text-right font-medium">Gen tps</th>
                  <th className="px-3 py-2 text-right font-medium">Prompt tps</th>
                  <th className="px-3 py-2 font-medium">Mode/Ctx</th>
                </tr>
              </thead>
              <tbody>
                {topBench.map((row: BenchCompareRow) => (
                  <tr
                    key={row.rel}
                    className="border-t border-[var(--color-border)] bg-[var(--color-surface-1)]"
                  >
                    <td className="px-3 py-2">{row.label}</td>
                    <td className="px-3 py-2 text-[color:var(--color-text-secondary)]">{row.class}</td>
                    <td className="px-3 py-2 text-right text-[color:var(--color-ok)]">
                      {fmtTps(row.tuned?.gen_tps)}
                    </td>
                    <td className="px-3 py-2 text-right">{fmtTps(row.tuned?.prompt_tps)}</td>
                    <td className="px-3 py-2 text-[color:var(--color-text-secondary)]">
                      {row.mode} / {row.ctx}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mt-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
          Preset promotions ({promotions.length})
        </h2>
        {promotions.length === 0 ? (
          <div className="rounded-md border border-dashed border-[var(--color-border)] p-4 text-[color:var(--color-text-secondary)]">
            No preset overrides active.
          </div>
        ) : (
          <ul className="space-y-1 mono text-sm">
            {promotions.map((p: PresetOverride) => (
              <li
                key={`${p.profile}:${p.preset}`}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-2"
              >
                <span className="text-[color:var(--color-brand)]">{p.profile}</span>
                <span className="mx-1 text-[color:var(--color-text-secondary)]">·</span>
                <span>{p.preset}</span>
                <span className="mx-2 text-[color:var(--color-text-secondary)]">→</span>
                <span className="text-[color:var(--color-ok)]">{p.rel}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export default function Dashboard(): React.JSX.Element {
  return (
    <Suspense
      fallback={<div className="p-6 text-[color:var(--color-text-secondary)]">Loading…</div>}
    >
      <DashboardBody />
    </Suspense>
  );
}
