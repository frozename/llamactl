import * as React from 'react';
import { Suspense, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { stringify as yamlStringify } from 'yaml';
import type { bench, schemas } from '@llamactl/core';
import { trpc } from '@/lib/trpc';
import { EditorialHero, StatCard, Button } from '@/ui';
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
      style={{ marginTop: 8, borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', background: 'var(--color-surface-1)', padding: 16 }}
    >
      <div style={{ marginBottom: 8, fontSize: 14, fontWeight: 500, color: 'var(--color-text)' }}>Expose a model</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 8, fontSize: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <label style={{ color: 'var(--color-text-secondary)' }}>name</label>
          <input
            type="text"
            placeholder="gemma-qa"
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-testid="dashboard-expose-name"
            style={{ width: 160, borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', background: 'var(--color-surface-2)', padding: '4px 8px', color: 'var(--color-text)' }}
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <label style={{ color: 'var(--color-text-secondary)' }}>node</label>
          <select
            value={node}
            onChange={(e) => setNode(e.target.value)}
            style={{ width: 128, borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', background: 'var(--color-surface-2)', padding: '4px 8px', color: 'var(--color-text)' }}
          >
            {nodeOptions.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <div style={{ display: 'flex', flex: 1, flexDirection: 'column' }}>
          <label style={{ color: 'var(--color-text-secondary)' }}>rel</label>
          <input
            type="text"
            placeholder="gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf"
            list="dashboard-rel-suggestions"
            value={rel}
            onChange={(e) => setRel(e.target.value)}
            style={{ width: '100%', borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', background: 'var(--color-surface-2)', padding: '4px 8px', fontFamily: 'var(--font-mono)', color: 'var(--color-text)' }}
          />
          <datalist id="dashboard-rel-suggestions">
            {catalogRels.map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
        </div>
        <Button
          type="submit"
          disabled={apply.isPending || !canSubmit}
          data-testid="dashboard-expose-submit"
          title={submitTitle}
          style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', background: 'var(--color-brand)', padding: '4px 12px', fontWeight: 500, color: 'var(--color-brand-contrast)', boxShadow: '0 1px 2px rgba(0,0,0,0.05)', cursor: (apply.isPending || !canSubmit) ? 'not-allowed' : 'pointer', opacity: (apply.isPending || !canSubmit) ? 0.4 : 1 }}
        >
          {apply.isPending ? 'Exposing…' : 'Expose'}
        </Button>
      </div>
      {status.kind === 'error' && (
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--color-err)' }}>{status.message}</div>
      )}
      {status.kind === 'ok' && (
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--color-ok)' }}>
          {status.action} {status.name}
          {status.endpoint && (
            <>
              {' · '}
              <a href={status.endpoint} target="_blank" rel="noreferrer" style={{ fontFamily: 'var(--font-mono)', textDecoration: 'underline' }}>
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
      <div style={{ borderRadius: 'var(--r-md)', border: '1px dashed var(--color-border)', padding: 16, color: 'var(--color-text-secondary)' }}>
        No workloads currently serving. Use "Expose a model" above to start one.
      </div>
    );
  }
  return (
    <ul style={{ display: 'flex', flexDirection: 'column', gap: 4, fontFamily: 'var(--font-mono)', fontSize: 14, margin: 0, padding: 0, listStyle: 'none' }}>
      {running.map((w) => (
        <li
          key={w.name}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', background: 'var(--color-surface-1)', padding: '8px 12px' }}
        >
          <div>
            <span style={{ color: 'var(--color-brand)' }}>{w.name}</span>
            <span style={{ margin: '0 4px', color: 'var(--color-text-secondary)' }}>·</span>
            <span style={{ color: 'var(--color-text-secondary)' }}>{w.node}</span>
            <span style={{ margin: '0 4px', color: 'var(--color-text-secondary)' }}>·</span>
            <span>{w.rel}</span>
          </div>
          {w.endpoint && (
            <a
              href={w.endpoint}
              target="_blank"
              rel="noreferrer"
              style={{ color: 'var(--color-ok)', textDecoration: 'underline' }}
            >
              {w.endpoint}
            </a>
          )}
        </li>
      ))}
    </ul>
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
  const serverStatusQuery = trpc.serverStatus.useQuery(undefined, { refetchInterval: 5000 });

  if (envQuery.isLoading || compareQuery.isLoading || promotionsQuery.isLoading) {
    return <div style={{ padding: 24, color: 'var(--color-text-secondary)' }}>Loading…</div>;
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
    <div style={{ height: '100%', overflow: 'auto', padding: 24 }}>
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

      <section style={{ marginBottom: 32 }} data-testid="dashboard-node-map-section">
        <h2 style={{ marginBottom: 12, fontSize: 14, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-secondary)' }}>
          Cluster map
        </h2>
        <ThemedNodeMap />
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
        <StatCard label="Profile" value={env?.LLAMA_CPP_MACHINE_PROFILE ?? '—'} />
        <StatCard label="Provider" value={env?.LOCAL_AI_PROVIDER ?? '—'} />
        <StatCard label="Default Model" value={env?.LLAMA_CPP_DEFAULT_MODEL ?? '—'} />
        <StatCard label="Active Model" value={activeModel} />
        <StatCard label="Context Length" value={env?.LOCAL_AI_CONTEXT_LENGTH ?? '—'} />
        <StatCard label="Provider URL" value={env?.LOCAL_AI_PROVIDER_URL ?? '—'} />
      </div>

      <section style={{ marginTop: 32 }}>
        <h2 style={{ marginBottom: 12, fontSize: 14, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-secondary)' }}>
          Exposed workloads
        </h2>
        <ExposedWorkloads />
        <ExposePanel />
      </section>

      <section style={{ marginTop: 32 }}>
        <h2 style={{ marginBottom: 12, fontSize: 14, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-secondary)' }}>
          Top benches (gen tps)
        </h2>
        {topBench.length === 0 ? (
          <div style={{ borderRadius: 'var(--r-md)', border: '1px dashed var(--color-border)', padding: 16, color: 'var(--color-text-secondary)' }}>
            No tuned records yet.
          </div>
        ) : (
          <div style={{ overflow: 'hidden', borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)' }}>
            <table style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 14, borderCollapse: 'collapse' }}>
              <thead style={{ background: 'var(--color-surface-1)', textAlign: 'left', color: 'var(--color-text-secondary)' }}>
                <tr>
                  <th style={{ padding: '8px 12px', fontWeight: 500 }}>Model</th>
                  <th style={{ padding: '8px 12px', fontWeight: 500 }}>Class</th>
                  <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 500 }}>Gen tps</th>
                  <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 500 }}>Prompt tps</th>
                  <th style={{ padding: '8px 12px', fontWeight: 500 }}>Mode/Ctx</th>
                </tr>
              </thead>
              <tbody>
                {topBench.map((row: BenchCompareRow) => (
                  <tr
                    key={row.rel}
                    style={{ borderTop: '1px solid var(--color-border)', background: 'var(--color-surface-1)' }}
                  >
                    <td style={{ padding: '8px 12px' }}>{row.label}</td>
                    <td style={{ padding: '8px 12px', color: 'var(--color-text-secondary)' }}>{row.class}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--color-ok)' }}>
                      {fmtTps(row.tuned?.gen_tps)}
                    </td>
                    <td style={{ padding: '8px 12px', textAlign: 'right' }}>{fmtTps(row.tuned?.prompt_tps)}</td>
                    <td style={{ padding: '8px 12px', color: 'var(--color-text-secondary)' }}>
                      {row.mode} / {row.ctx}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section style={{ marginTop: 32 }}>
        <h2 style={{ marginBottom: 12, fontSize: 14, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-secondary)' }}>
          Preset promotions ({promotions.length})
        </h2>
        {promotions.length === 0 ? (
          <div style={{ borderRadius: 'var(--r-md)', border: '1px dashed var(--color-border)', padding: 16, color: 'var(--color-text-secondary)' }}>
            No preset overrides active.
          </div>
        ) : (
          <ul style={{ display: 'flex', flexDirection: 'column', gap: 4, fontFamily: 'var(--font-mono)', fontSize: 14, margin: 0, padding: 0, listStyle: 'none' }}>
            {promotions.map((p: PresetOverride) => (
              <li
                key={`${p.profile}:${p.preset}`}
                style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', background: 'var(--color-surface-1)', padding: '8px 12px' }}
              >
                <span style={{ color: 'var(--color-brand)' }}>{p.profile}</span>
                <span style={{ margin: '0 4px', color: 'var(--color-text-secondary)' }}>·</span>
                <span>{p.preset}</span>
                <span style={{ margin: '0 8px', color: 'var(--color-text-secondary)' }}>→</span>
                <span style={{ color: 'var(--color-ok)' }}>{p.rel}</span>
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
    <div style={{ height: '100%' }} data-testid="dashboard-root">
      <Suspense
        fallback={<div style={{ padding: 24, color: 'var(--color-text-secondary)' }}>Loading…</div>}
      >
        <DashboardBody />
      </Suspense>
    </div>
  );
}
