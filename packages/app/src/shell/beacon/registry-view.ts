import type { AppModule } from '@/modules/registry';

export type ExplorerGroupId = 'workspace' | 'ops' | 'models' | 'knowledge' | 'observability';

export interface DynamicInstance {
  id: string;
  title: string;
  tone?: 'ok' | 'warn' | 'err' | 'idle';
}

export interface ExplorerLeaf {
  /** Source module id (e.g. 'workloads'). */
  id: string;
  title: string;
  kind: 'static' | 'dynamic-group';
  order: number;
  /** Populated when kind === 'dynamic-group' and the live data query
   *  yielded instances for this leaf. */
  instances?: DynamicInstance[];
}

export interface ExplorerGroup {
  id: ExplorerGroupId;
  label: string;
  leaves: ExplorerLeaf[];
}

export interface DynamicSources {
  workloads: DynamicInstance[];
  nodes: DynamicInstance[];
}

const GROUP_ORDER: ExplorerGroupId[] = ['workspace', 'ops', 'models', 'knowledge', 'observability'];

const GROUP_LABELS: Record<ExplorerGroupId, string> = {
  workspace: 'Workspace',
  ops: 'Ops',
  models: 'Models',
  knowledge: 'Knowledge',
  observability: 'Observability',
};

/** Map a dynamic-group leaf id to the sources key. */
function dynamicSourceFor(leafId: string): keyof DynamicSources | undefined {
  if (leafId === 'workloads') return 'workloads';
  if (leafId === 'nodes') return 'nodes';
  return undefined;
}

/**
 * Build the Explorer tree from the static registry + live dynamic
 * sources (workloads, nodes). Pure — no side effects, easy to test.
 * Hidden-group leaves are filtered out; empty groups are dropped.
 */
export function buildExplorerTree(
  modules: readonly AppModule[],
  sources: DynamicSources,
): ExplorerGroup[] {
  const byGroup = new Map<ExplorerGroupId, ExplorerLeaf[]>();
  for (const g of GROUP_ORDER) byGroup.set(g, []);

  for (const mod of modules) {
    const g = mod.beaconGroup;
    if (!g || g === 'hidden' || g === 'settings') continue;
    if (!GROUP_ORDER.includes(g as ExplorerGroupId)) continue;
    const leaf: ExplorerLeaf = {
      id: mod.id,
      title: mod.labelKey,
      kind: mod.beaconKind ?? 'static',
      order: mod.beaconOrder ?? 1000,
    };
    if (leaf.kind === 'dynamic-group') {
      const src = dynamicSourceFor(leaf.id);
      leaf.instances = src ? sources[src] : [];
    }
    byGroup.get(g as ExplorerGroupId)!.push(leaf);
  }

  return GROUP_ORDER
    .map((id) => {
      const leaves = (byGroup.get(id) ?? [])
        .slice()
        .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
      return { id, label: GROUP_LABELS[id], leaves };
    })
    .filter((g) => g.leaves.length > 0);
}
