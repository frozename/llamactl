import { describe, test, expect, beforeEach } from 'bun:test';
import { useExplorerCollapse } from '../../src/stores/explorer-collapse-store';

beforeEach(() => {
  useExplorerCollapse.setState({ collapsed: {} });
});

describe('explorer-collapse-store', () => {
  test('isCollapsed returns false by default', () => {
    expect(useExplorerCollapse.getState().isCollapsed('workspace')).toBe(false);
  });

  test('toggle flips the flag', () => {
    useExplorerCollapse.getState().toggle('ops');
    expect(useExplorerCollapse.getState().isCollapsed('ops')).toBe(true);
    useExplorerCollapse.getState().toggle('ops');
    expect(useExplorerCollapse.getState().isCollapsed('ops')).toBe(false);
  });

  test('set overrides the flag', () => {
    useExplorerCollapse.getState().set('models', true);
    expect(useExplorerCollapse.getState().isCollapsed('models')).toBe(true);
    useExplorerCollapse.getState().set('models', false);
    expect(useExplorerCollapse.getState().isCollapsed('models')).toBe(false);
  });

  test('keys are independent', () => {
    useExplorerCollapse.getState().set('workspace', true);
    expect(useExplorerCollapse.getState().isCollapsed('workspace')).toBe(true);
    expect(useExplorerCollapse.getState().isCollapsed('ops')).toBe(false);
  });
});
