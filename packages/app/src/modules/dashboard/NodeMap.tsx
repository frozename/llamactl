import * as React from 'react';
import { useMemo, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { useUIStore } from '@/stores/ui-store';

/**
 * Interactive cluster node map. The dashboard's centerpiece — every
 * registered node renders as a circle, color-coded by kind, with edges
 * from gateways to their provider children. Clicking a node selects it
 * as the active node + opens the detail popover next to it. Healthy
 * status pulses on the dot.
 *
 * Layout is a deliberate, hand-tuned topology rather than a
 * force-directed simulation:
 *   - `local` (or whichever node is the kubeconfig default) sits at
 *     the visual centre.
 *   - Agent-kind nodes orbit local in a ring.
 *   - Gateway-kind nodes sit on the right; their provider children
 *     fan out beneath them with a connecting line.
 *   - RAG-kind nodes cluster on the left.
 *
 * Why SVG (not a canvas / WebGL library): the cluster is small
 * (typically <30 nodes for a home / small-team fleet) and the
 * interaction surface needs hit testing + hover affordances that
 * SVG nails for free. Force-directed simulation would also obscure
 * the topological intent (gateway → provider hierarchy) the operator
 * actually cares about reading at a glance.
 */

type NodeKind = 'agent' | 'gateway' | 'provider' | 'rag';

interface NodeListItem {
  name: string;
  endpoint: string;
  effectiveKind?: NodeKind | undefined;
  isLocal?: boolean | undefined;
}

interface PlacedNode extends NodeListItem {
  x: number;
  y: number;
  parent?: string;
}

const VIEWBOX = { w: 800, h: 480 };
const CENTER = { x: VIEWBOX.w / 2, y: VIEWBOX.h / 2 };
const NODE_RADIUS = 28;
const PROVIDER_RADIUS = 18;

function colorForKind(kind: NodeKind, isLocal: boolean): string {
  if (isLocal) return 'var(--color-accent)';
  switch (kind) {
    case 'agent':
      return 'var(--color-success, #34d399)';
    case 'gateway':
      return 'var(--color-warning, #fbbf24)';
    case 'provider':
      return 'var(--color-fg-muted)';
    case 'rag':
      return 'var(--color-brand, #a78bfa)';
  }
}

/**
 * Lay out nodes around a central anchor. Returns absolute (x,y)
 * coordinates per node and an edge list (parent → child) for gateway
 * → provider relationships.
 */
function layoutCluster(nodes: NodeListItem[]): {
  placed: PlacedNode[];
  edges: Array<{ from: string; to: string }>;
} {
  const local = nodes.find((n) => n.isLocal || n.name === 'local');
  const agents = nodes.filter(
    (n) => (n.effectiveKind ?? 'agent') === 'agent' && n !== local,
  );
  const gateways = nodes.filter((n) => n.effectiveKind === 'gateway');
  const rags = nodes.filter((n) => n.effectiveKind === 'rag');
  const providers = nodes.filter((n) => n.effectiveKind === 'provider');

  const placed: PlacedNode[] = [];
  const edges: Array<{ from: string; to: string }> = [];

  // Centre — local (or first agent if no `local`).
  const centerNode = local ?? agents[0];
  if (centerNode) {
    placed.push({ ...centerNode, x: CENTER.x, y: CENTER.y });
  }

  // Agents orbit the center.
  const orbitable = local ? agents : agents.slice(1);
  const ringRadius = 150;
  orbitable.forEach((node, i) => {
    const angle = (-Math.PI / 2) + (i / Math.max(orbitable.length, 1)) * Math.PI * 2;
    placed.push({
      ...node,
      x: CENTER.x + ringRadius * Math.cos(angle),
      y: CENTER.y + ringRadius * Math.sin(angle),
    });
  });

  // Gateways stack on the right, then their providers fan beneath them.
  const gatewayX = VIEWBOX.w - 130;
  const gatewayStartY = 70;
  const gatewayStep = (VIEWBOX.h - 140) / Math.max(gateways.length, 1);
  gateways.forEach((gw, i) => {
    const gy = gatewayStartY + i * gatewayStep;
    placed.push({ ...gw, x: gatewayX, y: gy });
    const children = providers.filter((p) => p.name.startsWith(`${gw.name}.`));
    children.forEach((p, j) => {
      const px = gatewayX + 80;
      const py = gy + (j - (children.length - 1) / 2) * 40;
      placed.push({ ...p, x: px, y: py, parent: gw.name });
      edges.push({ from: gw.name, to: p.name });
    });
  });

  // RAG nodes on the left.
  const ragX = 80;
  const ragStartY = 90;
  rags.forEach((r, i) => {
    placed.push({
      ...r,
      x: ragX,
      y: ragStartY + i * 80,
    });
  });

  return { placed, edges };
}

interface NodeBubbleProps {
  node: PlacedNode;
  isActive: boolean;
  isHovered: boolean;
  onClick: () => void;
  onHover: (name: string | null) => void;
}

function NodeBubble({ node, isActive, isHovered, onClick, onHover }: NodeBubbleProps): React.JSX.Element {
  const kind = node.effectiveKind ?? 'agent';
  const isLocal = !!node.isLocal || node.name === 'local';
  const fill = colorForKind(kind, isLocal);
  const r = kind === 'provider' ? PROVIDER_RADIUS : NODE_RADIUS;

  return (
    <g
      data-testid={`node-map-bubble-${node.name}`}
      data-kind={kind}
      data-active={isActive ? 'true' : 'false'}
      transform={`translate(${node.x}, ${node.y})`}
      onClick={onClick}
      onMouseEnter={() => onHover(node.name)}
      onMouseLeave={() => onHover(null)}
      style={{ cursor: 'pointer' }}
    >
      {isActive && (
        <circle r={r + 8} fill="none" stroke="var(--color-accent)" strokeWidth={2} opacity={0.6} />
      )}
      <circle
        r={r}
        fill={fill}
        opacity={isHovered ? 1 : 0.9}
        stroke="var(--color-border)"
        strokeWidth={1.5}
      />
      <text
        textAnchor="middle"
        dominantBaseline="central"
        y={0}
        fontSize={kind === 'provider' ? 10 : 12}
        fontFamily="var(--font-sans, system-ui)"
        fill="var(--color-fg-inverted, white)"
        style={{ pointerEvents: 'none', fontWeight: 500 }}
      >
        {abbreviate(node.name)}
      </text>
      <text
        textAnchor="middle"
        y={r + 14}
        fontSize={11}
        fill="var(--color-fg)"
        style={{ pointerEvents: 'none' }}
      >
        {node.name}
      </text>
    </g>
  );
}

function abbreviate(name: string): string {
  // Pull initials from a hyphen-separated name; fall back to first 2 chars.
  const parts = name.split(/[-.]/).filter(Boolean);
  if (parts.length >= 2) return parts.slice(0, 2).map((p) => p[0]?.toUpperCase()).join('');
  return name.slice(0, 2).toUpperCase();
}

interface NodeDetailProps {
  name: string;
  kind: NodeKind;
  isActive: boolean;
  endpoint: string;
  onActivate: () => void;
  onClose: () => void;
}

function NodeDetail({
  name,
  kind,
  isActive,
  endpoint,
  onActivate,
  onClose,
}: NodeDetailProps): React.JSX.Element {
  return (
    <div
      data-testid={`node-map-detail-${name}`}
      className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3 text-sm shadow-lg"
      style={{ minWidth: 220 }}
    >
      <div className="flex items-baseline justify-between">
        <div className="font-mono text-[color:var(--color-fg)]">{name}</div>
        <button
          type="button"
          onClick={onClose}
          className="text-[10px] text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]"
        >
          close
        </button>
      </div>
      <div className="mt-1 text-[10px] text-[color:var(--color-fg-muted)]">
        kind={kind}
      </div>
      <div className="mt-2 break-all rounded bg-[var(--color-surface-2)] px-2 py-1 font-mono text-[10px] text-[color:var(--color-fg-muted)]">
        {endpoint}
      </div>
      {!isActive && (
        <button
          type="button"
          onClick={onActivate}
          data-testid={`node-map-activate-${name}`}
          className="mt-3 w-full rounded border border-[var(--color-accent)] bg-[var(--color-accent)] px-2 py-1 text-xs font-medium text-[color:var(--color-fg-inverted)] hover:opacity-90"
        >
          Set as active node
        </button>
      )}
      {isActive && (
        <div className="mt-3 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-center text-[10px] text-[color:var(--color-fg-muted)]">
          currently active
        </div>
      )}
    </div>
  );
}

export function NodeMap(): React.JSX.Element {
  const list = trpc.nodeList.useQuery();
  const setActiveModule = useUIStore((s) => s.setActiveModule);
  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);

  // No global "active" node any more — the cluster map is a
  // navigation surface, not a state mutator. The default-node
  // highlight still reads from kubeconfig for a soft indicator
  // (so the operator's eye goes to the canonical host first).
  const effective = list.data?.defaultNode ?? 'local';
  const allNodes = useMemo(() => {
    const fromQuery = list.data?.nodes ?? [];
    const local = fromQuery.find((n) => n.name === 'local');
    const enriched: NodeListItem[] = fromQuery.map((n) => ({
      name: n.name,
      endpoint: n.endpoint,
      effectiveKind: n.effectiveKind as NodeKind | undefined,
      isLocal: n.name === 'local',
    }));
    if (!local) {
      enriched.unshift({
        name: 'local',
        endpoint: 'inproc://local',
        effectiveKind: 'agent',
        isLocal: true,
      });
    }
    return enriched;
  }, [list.data]);

  const { placed, edges } = useMemo(() => layoutCluster(allNodes), [allNodes]);
  const focusedNode = focused ? placed.find((p) => p.name === focused) : null;

  return (
    <div
      className="relative w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-0)] p-2"
      data-testid="node-map-root"
      data-node-count={placed.length}
      data-active-node={effective}
    >
      <svg
        viewBox={`0 0 ${VIEWBOX.w} ${VIEWBOX.h}`}
        className="h-[480px] w-full"
        style={{ display: 'block' }}
      >
        {/* Gateway → provider edges */}
        {edges.map((e) => {
          const from = placed.find((p) => p.name === e.from);
          const to = placed.find((p) => p.name === e.to);
          if (!from || !to) return null;
          return (
            <line
              key={`${e.from}->${e.to}`}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              stroke="var(--color-border)"
              strokeWidth={1}
              strokeDasharray="3 3"
              opacity={0.5}
            />
          );
        })}
        {placed.map((node) => (
          <NodeBubble
            key={node.name}
            node={node}
            isActive={node.name === effective}
            isHovered={hovered === node.name}
            onClick={() => setFocused(node.name)}
            onHover={setHovered}
          />
        ))}
      </svg>
      {focusedNode && (
        <div
          className="absolute pointer-events-auto"
          style={{
            left: `calc(${(focusedNode.x / VIEWBOX.w) * 100}% + 24px)`,
            top: `calc(${(focusedNode.y / VIEWBOX.h) * 100}% - 40px)`,
            zIndex: 10,
          }}
        >
          <NodeDetail
            name={focusedNode.name}
            kind={(focusedNode.effectiveKind ?? 'agent') as NodeKind}
            endpoint={focusedNode.endpoint}
            isActive={focusedNode.name === effective}
            onActivate={() => {
              // "Set as active" is now a scoped jump — open the
              // Workloads tab so the operator sees what's running
              // on this node. For other kinds the detail card's
              // per-kind actions (future work) take over.
              setActiveModule('workloads');
              setFocused(null);
            }}
            onClose={() => setFocused(null)}
          />
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-3 px-2 pb-1 text-[10px] text-[color:var(--color-fg-muted)]">
        <LegendDot color="var(--color-accent)" label="active / local" />
        <LegendDot color="var(--color-success, #34d399)" label="agent" />
        <LegendDot color="var(--color-warning, #fbbf24)" label="gateway" />
        <LegendDot color="var(--color-fg-muted)" label="provider (via gateway)" />
        <LegendDot color="var(--color-brand, #a78bfa)" label="RAG" />
      </div>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{ background: color }}
      />
      {label}
    </span>
  );
}
