import * as React from 'react';
import { StatusDot, TreeItem } from '@/ui';
import { APP_MODULES } from '@/modules/registry';
import { trpc } from '@/lib/trpc';
import { useTabStore, type TabEntry } from '@/stores/tab-store';
import { useExplorerCollapse } from '@/stores/explorer-collapse-store';
import { buildExplorerTree, type DynamicInstance, type ExplorerLeaf } from './registry-view';

/**
 * Renders the Workspace tree. Static leaves open a module tab; dynamic
 * leaves expand to show live instances (each a workload / node tab).
 * Collapse state is persisted per-user via useExplorerCollapse.
 */
export function ExplorerTree(): React.JSX.Element {
  const workloads = trpc.workloadList.useQuery(undefined, { refetchInterval: 10_000 });
  const nodes = trpc.nodeList.useQuery(undefined, { refetchInterval: 30_000 });

  const wlInstances: DynamicInstance[] = React.useMemo(() => {
    const rows = (workloads.data ?? []) as Array<{ name?: string; phase?: string; modelRef?: string }>;
    return rows.map((w) => ({
      id: w.name ?? 'unknown',
      title: `${w.name ?? '—'}${w.modelRef ? ` · ${w.modelRef}` : ''}`,
      tone: w.phase === 'Running' ? 'ok' : w.phase === 'Failed' ? 'err' : 'warn',
    }));
  }, [workloads.data]);

  const nodeInstances: DynamicInstance[] = React.useMemo(() => {
    const rows = (nodes.data?.nodes ?? []) as Array<{ name: string; effectiveKind?: string }>;
    return rows.map((n) => ({
      id: n.name,
      title: `${n.name} · ${n.effectiveKind ?? 'agent'}`,
      tone: 'ok',
    }));
  }, [nodes.data]);

  const tree = React.useMemo(
    () => buildExplorerTree(APP_MODULES, { workloads: wlInstances, nodes: nodeInstances }),
    [wlInstances, nodeInstances],
  );

  const collapsed = useExplorerCollapse((s) => s.collapsed);
  const toggleCollapse = useExplorerCollapse((s) => s.toggle);
  const activeTabKey = useTabStore((s) => s.activeKey);
  const open = useTabStore((s) => s.open);

  const openLeaf = (leaf: ExplorerLeaf): void => {
    const entry: TabEntry = {
      tabKey: `module:${leaf.id}`,
      title: leaf.title,
      kind: 'module',
      openedAt: Date.now(),
    };
    open(entry);
  };

  const openInstance = (leaf: ExplorerLeaf, inst: DynamicInstance): void => {
    const kind = leaf.id === 'workloads' ? 'workload' : leaf.id === 'nodes' ? 'node' : 'module';
    const entry: TabEntry = {
      tabKey: `${kind}:${inst.id}`,
      title: inst.title,
      kind: kind as TabEntry['kind'],
      instanceId: inst.id,
      openedAt: Date.now(),
    };
    open(entry);
  };

  return (
    <div role="tree" style={{ overflowY: 'auto', flex: 1 }}>
      {tree.map((group) => {
        const isCollapsed = collapsed[group.id] === true;
        return (
          <div key={group.id}>
            <button
              type="button"
              data-testid={`explorer-group-${group.id}`}
              onClick={() => toggleCollapse(group.id)}
              style={{
                all: 'unset',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '10px 18px 4px',
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                color: 'var(--color-text-tertiary)',
                cursor: 'pointer',
                width: '100%',
              }}
            >
              <span style={{ transition: 'transform 160ms', transform: isCollapsed ? 'rotate(-90deg)' : 'none' }}>▾</span>
              {group.label}
            </button>
            {!isCollapsed && group.leaves.map((leaf) => (
              <React.Fragment key={leaf.id}>
                <div
                  {...(leaf.kind === 'static' ? { 'data-testid': `explorer-leaf-${leaf.id}` } : {})}
                >
                  <TreeItem
                    label={leaf.title}
                    active={activeTabKey === `module:${leaf.id}`}
                    onClick={() => openLeaf(leaf)}
                    collapsed={leaf.kind === 'dynamic-group' ? (collapsed[`${group.id}/${leaf.id}`] ?? false) : undefined}
                    onDoubleClick={() => {
                      if (leaf.kind === 'dynamic-group') {
                        toggleCollapse(`${group.id}/${leaf.id}`);
                      }
                    }}
                  />
                </div>
                {leaf.kind === 'dynamic-group' && !(collapsed[`${group.id}/${leaf.id}`] ?? false) &&
                  (leaf.instances ?? []).map((inst) => (
                    <TreeItem
                      key={inst.id}
                      indent={1}
                      label={inst.title}
                      trailing={<StatusDot tone={inst.tone ?? 'idle'} />}
                      active={activeTabKey === `${leaf.id === 'workloads' ? 'workload' : 'node'}:${inst.id}`}
                      onClick={() => openInstance(leaf, inst)}
                    />
                  ))}
              </React.Fragment>
            ))}
          </div>
        );
      })}
    </div>
  );
}
