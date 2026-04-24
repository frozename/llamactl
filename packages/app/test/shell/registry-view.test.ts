import { describe, test, expect } from 'bun:test';
import { buildExplorerTree, type ExplorerLeaf, type DynamicInstance } from '../../src/shell/beacon/registry-view';
import type { AppModule } from '../../src/modules/registry';

// A minimal stand-in for AppModule without the lazy Component.
function m(id: string, beaconGroup: string, beaconKind: 'static' | 'dynamic-group' = 'static', beaconOrder = 0): AppModule {
  return {
    id,
    labelKey: id.slice(0, 1).toUpperCase() + id.slice(1),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    icon: (() => null) as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Component: (() => null) as any,
    activityBar: false,
    beaconGroup: beaconGroup as AppModule['beaconGroup'],
    beaconKind,
    beaconOrder,
  };
}

describe('buildExplorerTree', () => {
  test('groups leaves by beaconGroup, sorted by beaconOrder', () => {
    const modules = [
      m('a', 'ops', 'static', 20),
      m('b', 'workspace', 'static', 10),
      m('c', 'workspace', 'static', 20),
      m('d', 'ops', 'static', 10),
    ];
    const tree = buildExplorerTree(modules, { workloads: [], nodes: [] });
    expect(tree.map((g) => g.id)).toEqual(['workspace', 'ops']);
    expect(tree[0]?.leaves.map((l) => l.id)).toEqual(['b', 'c']);
    expect(tree[1]?.leaves.map((l) => l.id)).toEqual(['d', 'a']);
  });

  test('dynamic-group leaves expand with live instances', () => {
    const modules = [m('workloads', 'ops', 'dynamic-group', 20)];
    const tree = buildExplorerTree(modules, {
      workloads: [{ id: 'wl-a', title: 'wl-a · qwen', tone: 'ok' }],
      nodes: [],
    });
    const opsGroup = tree.find((g) => g.id === 'ops');
    expect(opsGroup).toBeDefined();
    const workloadsLeaf = opsGroup!.leaves.find((l) => l.id === 'workloads');
    expect(workloadsLeaf?.kind).toBe('dynamic-group');
    expect(workloadsLeaf?.instances).toHaveLength(1);
    expect(workloadsLeaf?.instances?.[0]?.id).toBe('wl-a');
  });

  test('hidden leaves are excluded', () => {
    const modules = [m('settings', 'hidden', 'static')];
    const tree = buildExplorerTree(modules, { workloads: [], nodes: [] });
    for (const group of tree) {
      expect(group.leaves).toHaveLength(0);
    }
  });

  test('groups with no leaves are dropped', () => {
    const modules = [m('a', 'workspace', 'static')];
    const tree = buildExplorerTree(modules, { workloads: [], nodes: [] });
    expect(tree.every((g) => g.leaves.length > 0)).toBe(true);
  });
});
