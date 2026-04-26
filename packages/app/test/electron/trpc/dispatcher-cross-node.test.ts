import { describe, expect, test, afterEach, beforeEach, spyOn, mock } from 'bun:test';
import { config as kubecfg } from '@llamactl/remote';
import {
  buildDispatcherRouter,
  __setPeerClientFactoryForTests,
  __resetPeerClientFactoryForTests,
  __resetActiveNodeOverrideForTests,
} from '../../../electron/trpc/dispatcher.js';

describe('UI Cross-Node Dispatcher Procedures', () => {
  beforeEach(() => {
    __resetPeerClientFactoryForTests();
    __resetActiveNodeOverrideForTests();
    spyOn(kubecfg, 'loadConfig').mockReturnValue({
      apiVersion: 'llamactl/v1',
      kind: 'Config',
      currentContext: 'default',
      contexts: [{ name: 'default', cluster: 'home', user: 'me', defaultNode: 'local' }],
      clusters: [
        {
          name: 'home',
          nodes: [
            { name: 'local', endpoint: 'https://127.0.0.1:7843' },
            { name: 'mac-mini', endpoint: 'https://192.168.68.76:7843', kind: 'agent' },
            { name: 'linux-box', endpoint: 'https://192.168.68.77:7843', kind: 'agent' },
          ],
        },
      ],
      users: [{ name: 'me', token: 'abc' }],
    } as any);
  });

  afterEach(() => {
    __resetPeerClientFactoryForTests();
    __resetActiveNodeOverrideForTests();
    mock.restore();
  });

  test('uiCrossNodeOpsSessionSearch fans out to remote agent nodes', async () => {
    const hitsCalled: string[] = [];
    
    __setPeerClientFactoryForTests((node: any) => {
      const nodeName = node.name;
      return {
        opsSessionSearch: {
          query: async (input: any) => {
            hitsCalled.push(nodeName);
            return { hits: [{ id: `session-${nodeName}` }] };
          }
        }
      } as any;
    });

    const router = buildDispatcherRouter();
    const caller = router.createCaller({});
    
    const result = await caller.uiCrossNodeOpsSessionSearch({ query: 'test' });
    
    expect(hitsCalled.sort()).toEqual(['linux-box', 'mac-mini']);
    expect(result.hits).toHaveLength(2);
    expect(result.hits.map((h: any) => h.id).sort()).toEqual(['session-linux-box', 'session-mac-mini']);
    expect(result.unreachableNodes).toEqual([]);
  });

  test('uiCrossNodeLogsSearch fans out to remote agent nodes', async () => {
    const hitsCalled: string[] = [];
    
    __setPeerClientFactoryForTests((node: any) => {
      const nodeName = node.name;
      return {
        logsSearch: {
          query: async (input: any) => {
            hitsCalled.push(nodeName);
            return { hits: [{ line: `log-${nodeName}` }] };
          }
        }
      } as any;
    });

    const router = buildDispatcherRouter();
    const caller = router.createCaller({});
    
    const result = await caller.uiCrossNodeLogsSearch({ query: 'error' });
    
    expect(hitsCalled.sort()).toEqual(['linux-box', 'mac-mini']);
    expect(result.hits).toHaveLength(2);
    expect(result.hits.map((h: any) => h.line).sort()).toEqual(['log-linux-box', 'log-mac-mini']);
    expect(result.unreachableNodes).toEqual([]);
  });
});