import * as React from 'react';
import { useMemo, useState } from 'react';
import { trpc } from '@/lib/trpc';

/**
 * Three mock node-map aesthetics rendered side-by-side so an operator
 * can pick a direction before we commit to one. Each mock uses the
 * same live `trpc.nodeList` data; the differences are purely visual.
 *
 *  A — Tailscale / Vercel: minimalist glass cards, soft shadows, thin
 *       animated edges, gradient accent on active. Professional +
 *       boring by design.
 *  B — Cyberpunk terminal: pitch-black canvas, monospace labels, neon
 *       health accents, bracket-style nodes, scanline overlay. Loud +
 *       distinctive.
 *  C — Datadog hex grid: hexagonal tiles each carrying name + status
 *       pill + mini-metrics. Information-dense; reads like a NOC.
 *
 * This file is intentionally self-contained so we can delete it once a
 * direction is chosen.
 */

type NodeKind = 'agent' | 'gateway' | 'provider' | 'rag';
interface N {
  name: string;
  endpoint: string;
  effectiveKind: NodeKind;
  isLocal?: boolean;
}

export function useMockNodes(): N[] {
  const list = trpc.nodeList.useQuery();
  return useMemo(() => {
    const raw = list.data?.nodes ?? [];
    const out: N[] = raw.map((n) => ({
      name: n.name,
      endpoint: n.endpoint,
      effectiveKind: (n.effectiveKind ?? 'agent') as NodeKind,
      isLocal: n.name === 'local',
    }));
    if (!out.some((n) => n.name === 'local')) {
      out.unshift({ name: 'local', endpoint: 'inproc://local', effectiveKind: 'agent', isLocal: true });
    }
    return out;
  }, [list.data]);
}

/* ────────────── A · Tailscale / Vercel glass cards ────────────── */

function TailscaleCard({ node, active }: { node: N; active: boolean }): React.JSX.Element {
  const kindLabel: Record<NodeKind, string> = {
    agent: 'Agent',
    gateway: 'Gateway',
    provider: 'Provider',
    rag: 'RAG',
  };
  return (
    <div
      className="relative rounded-lg border bg-[var(--color-surface-1)] px-3 py-2.5 shadow-sm transition-all hover:shadow-md"
      style={{
        borderColor: active ? 'var(--color-accent)' : 'var(--color-border)',
        boxShadow: active
          ? '0 0 0 1px var(--color-accent), 0 4px 12px -4px color-mix(in srgb, var(--color-accent) 40%, transparent)'
          : '0 1px 2px rgba(0,0,0,0.05)',
        minWidth: 150,
      }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-sm text-[color:var(--color-fg)]">{node.name}</span>
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: node.isLocal ? 'var(--color-accent)' : '#34d399' }}
        />
      </div>
      <div className="mt-1 text-[10px] uppercase tracking-wider text-[color:var(--color-fg-muted)]">
        {kindLabel[node.effectiveKind]}
        {node.isLocal ? ' · this host' : ''}
      </div>
    </div>
  );
}

export function NodeMapTailscale({ nodes }: { nodes: N[] }): React.JSX.Element {
  const agents = nodes.filter((n) => n.effectiveKind === 'agent');
  const gateways = nodes.filter((n) => n.effectiveKind === 'gateway');
  const providers = nodes.filter((n) => n.effectiveKind === 'provider');
  const rags = nodes.filter((n) => n.effectiveKind === 'rag');
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-0)] p-5">
      <Section label="Agents" accent="#34d399">
        {agents.map((n) => <TailscaleCard key={n.name} node={n} active={!!n.isLocal} />)}
      </Section>
      {gateways.map((g) => {
        const children = providers.filter((p) => p.name.startsWith(`${g.name}.`));
        return (
          <Section key={g.name} label={g.name} accent="#fbbf24">
            <TailscaleCard node={g} active={false} />
            {children.map((p) => <TailscaleCard key={p.name} node={p} active={false} />)}
          </Section>
        );
      })}
      {rags.length > 0 && (
        <Section label="Retrieval" accent="#a78bfa">
          {rags.map((n) => <TailscaleCard key={n.name} node={n} active={false} />)}
        </Section>
      )}
    </div>
  );
}

function Section({ label, accent, children }: { label: string; accent: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="mb-5 last:mb-0">
      <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-widest text-[color:var(--color-fg-muted)]">
        <span className="inline-block h-0.5 w-4 rounded-full" style={{ background: accent }} />
        {label}
      </div>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

/* ────────────── B · Cyberpunk terminal ────────────── */

function CyberpunkBubble({ node, active }: { node: N; active: boolean }): React.JSX.Element {
  const color = node.isLocal
    ? '#00e5ff'
    : node.effectiveKind === 'gateway'
      ? '#ff00c8'
      : node.effectiveKind === 'rag'
        ? '#b388ff'
        : node.effectiveKind === 'provider'
          ? '#8c8c8c'
          : '#00ff9f';
  return (
    <div
      className="relative inline-flex items-center gap-1.5 font-mono text-xs"
      style={{
        color,
        textShadow: `0 0 4px ${color}60`,
        padding: '4px 8px',
        border: `1px solid ${color}`,
        background: active ? `${color}14` : 'transparent',
        boxShadow: active ? `0 0 12px ${color}80, inset 0 0 12px ${color}20` : `inset 0 0 6px ${color}20`,
      }}
    >
      <span className="opacity-60">[</span>
      <span>{node.name}</span>
      {active && (
        <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full" style={{ background: color, animation: 'pulse 1.5s ease-in-out infinite' }} />
      )}
      <span className="opacity-60">]</span>
      <span className="ml-1 opacity-50 text-[10px]">{node.effectiveKind.slice(0, 3).toUpperCase()}</span>
    </div>
  );
}

export function NodeMapCyberpunk({ nodes }: { nodes: N[] }): React.JSX.Element {
  const agents = nodes.filter((n) => n.effectiveKind === 'agent');
  const gateways = nodes.filter((n) => n.effectiveKind === 'gateway');
  const providers = nodes.filter((n) => n.effectiveKind === 'provider');
  const rags = nodes.filter((n) => n.effectiveKind === 'rag');
  return (
    <div
      className="relative rounded-xl border p-5 font-mono"
      style={{
        background: 'radial-gradient(ellipse at top left, #101218 0%, #05060a 70%)',
        borderColor: '#1a1f2e',
        color: '#00ff9f',
        overflow: 'hidden',
      }}
    >
      {/* scanlines */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            'repeating-linear-gradient(0deg, rgba(0,255,159,0.04) 0 1px, transparent 1px 3px)',
          mixBlendMode: 'screen',
        }}
      />
      <div className="relative">
        <div className="mb-3 text-[10px] uppercase tracking-[0.3em] opacity-60">// fleet.map ::agents</div>
        <div className="flex flex-wrap gap-2">
          {agents.map((n) => <CyberpunkBubble key={n.name} node={n} active={!!n.isLocal} />)}
        </div>
        {gateways.map((g) => {
          const children = providers.filter((p) => p.name.startsWith(`${g.name}.`));
          return (
            <div key={g.name} className="mt-5">
              <div className="mb-2 text-[10px] uppercase tracking-[0.3em] opacity-60">// gateway :: {g.name}</div>
              <div className="flex flex-wrap items-center gap-2">
                <CyberpunkBubble node={g} active={false} />
                <span className="opacity-40" style={{ color: '#ff00c8' }}>──┐</span>
                {children.map((p, i) => (
                  <React.Fragment key={p.name}>
                    <CyberpunkBubble node={p} active={false} />
                    {i < children.length - 1 && <span className="opacity-40">·</span>}
                  </React.Fragment>
                ))}
              </div>
            </div>
          );
        })}
        {rags.length > 0 && (
          <div className="mt-5">
            <div className="mb-2 text-[10px] uppercase tracking-[0.3em] opacity-60">// retrieval</div>
            <div className="flex flex-wrap gap-2">
              {rags.map((n) => <CyberpunkBubble key={n.name} node={n} active={false} />)}
            </div>
          </div>
        )}
      </div>
      <style>{`@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }`}</style>
    </div>
  );
}

/* ────────────── C · Datadog hex grid ────────────── */

function Hex({ node, active }: { node: N; active: boolean }): React.JSX.Element {
  const color = node.effectiveKind === 'gateway'
    ? '#fbbf24'
    : node.effectiveKind === 'rag'
      ? '#a78bfa'
      : node.effectiveKind === 'provider'
        ? '#9ca3af'
        : '#34d399';
  return (
    <div
      className="relative flex flex-col items-center justify-center text-center"
      style={{
        width: 136,
        height: 156,
        clipPath: 'polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%)',
        background: active
          ? `linear-gradient(135deg, ${color}40 0%, ${color}10 100%)`
          : 'var(--color-surface-1)',
        border: `1px solid ${active ? color : 'var(--color-border)'}`,
      }}
    >
      <div className="font-mono text-[11px] font-medium text-[color:var(--color-fg)] px-2">{node.name}</div>
      <div className="mt-0.5 flex items-center gap-1 text-[9px] uppercase tracking-widest text-[color:var(--color-fg-muted)]">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
        {node.effectiveKind}
      </div>
      <div className="mt-2 flex flex-col gap-0.5 text-[9px] text-[color:var(--color-fg-muted)]">
        <Pill label="load" value={node.isLocal ? '12%' : '—'} />
        <Pill label="rt" value={node.effectiveKind === 'agent' ? '28 tk/s' : '—'} />
      </div>
    </div>
  );
}

function Pill({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <span className="rounded bg-[color:var(--color-surface-2)] px-1.5 py-0.5">
      <span className="opacity-60">{label}</span> <span className="font-mono text-[color:var(--color-fg)]">{value}</span>
    </span>
  );
}

export function NodeMapDatadog({ nodes }: { nodes: N[] }): React.JSX.Element {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-0)] p-5">
      <div
        className="grid"
        style={{
          gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
          gap: '16px 8px',
          justifyItems: 'center',
        }}
      >
        {nodes.map((n, i) => (
          <div key={n.name} style={{ transform: i % 2 === 1 ? 'translateY(40px)' : 'none' }}>
            <Hex node={n} active={!!n.isLocal} />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ────────────── Preview shell ────────────── */

export function NodeMapPreviews(): React.JSX.Element {
  const nodes = useMockNodes();
  const [pick, setPick] = useState<'A' | 'B' | 'C'>('B');
  return (
    <div data-testid="node-map-previews">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-[color:var(--color-fg-muted)]">preview style:</span>
        {(['A', 'B', 'C'] as const).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPick(p)}
            className="rounded border px-2 py-1"
            style={{
              borderColor: pick === p ? 'var(--color-accent)' : 'var(--color-border)',
              background: pick === p ? 'color-mix(in srgb, var(--color-accent) 15%, transparent)' : 'var(--color-surface-1)',
              color: 'var(--color-fg)',
            }}
          >
            {p === 'A' ? 'A · glass cards' : p === 'B' ? 'B · cyberpunk' : 'C · hex grid'}
          </button>
        ))}
      </div>
      {pick === 'A' && <NodeMapTailscale nodes={nodes} />}
      {pick === 'B' && <NodeMapCyberpunk nodes={nodes} />}
      {pick === 'C' && <NodeMapDatadog nodes={nodes} />}
    </div>
  );
}
