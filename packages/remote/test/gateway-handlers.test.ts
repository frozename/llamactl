import { describe, expect, test } from 'bun:test';
import type { ClusterNode } from '../src/config/schema.js';
import { applyOne, type ApplyEvent, type WorkloadClient } from '../src/workload/apply.js';
import {
  AGENT_GATEWAY_HANDLER_KIND,
  DEFAULT_GATEWAY_HANDLERS,
  dispatchGatewayApply,
  agentGatewayHandler,
  embersynthHandler,
  siriusHandler,
  type GatewayHandler,
} from '../src/workload/gateway-handlers/index.js';
import type { ModelRun } from '../src/workload/schema.js';

function gatewayManifest(node: string, target = 'openai/gpt-4o'): ModelRun {
  return {
    apiVersion: 'llamactl/v1',
    kind: 'ModelRun',
    metadata: { name: `register-${node}`, labels: {} },
    spec: {
      node,
      gateway: true,
      target: { kind: 'rel', value: target },
      extraArgs: [],
      workers: [],
      restartPolicy: 'Always',
      timeoutSeconds: 60,
    },
  };
}

function siriusNode(name = 'sirius-primary'): ClusterNode {
  return {
    name,
    endpoint: '',
    kind: 'gateway',
    cloud: { provider: 'sirius', baseUrl: 'https://sirius.example:3000/v1' },
  };
}

function embersynthNode(name = 'embersynth-primary'): ClusterNode {
  return {
    name,
    endpoint: '',
    kind: 'gateway',
    cloud: { provider: 'embersynth', baseUrl: 'https://embersynth.example:7777/v1' },
  };
}

function agentNode(name = 'gpu1'): ClusterNode {
  return { name, endpoint: 'https://gpu1.lan:7843', kind: 'agent' };
}

describe('canHandle predicates', () => {
  test('siriusHandler only matches gateway-kind sirius nodes', () => {
    expect(siriusHandler.canHandle(siriusNode())).toBe(true);
    expect(siriusHandler.canHandle(embersynthNode())).toBe(false);
    expect(siriusHandler.canHandle(agentNode())).toBe(false);
  });
  test('embersynthHandler only matches gateway-kind embersynth nodes', () => {
    expect(embersynthHandler.canHandle(embersynthNode())).toBe(true);
    expect(embersynthHandler.canHandle(siriusNode())).toBe(false);
    expect(embersynthHandler.canHandle(agentNode())).toBe(false);
  });
  test('agentGatewayHandler matches any agent-kind node', () => {
    expect(agentGatewayHandler.canHandle(agentNode())).toBe(true);
    expect(agentGatewayHandler.canHandle(siriusNode())).toBe(false);
  });
  test('default registry order routes gateway-kind nodes before the agent fallback', () => {
    const kinds = DEFAULT_GATEWAY_HANDLERS.map((h) => h.kind);
    expect(kinds[0]).toBe('sirius');
    expect(kinds[1]).toBe('embersynth');
    expect(kinds[kinds.length - 1]).toBe(AGENT_GATEWAY_HANDLER_KIND);
  });
});

describe('dispatchGatewayApply', () => {
  const noopClient = (): WorkloadClient => {
    throw new Error('should not be called in dispatch tests');
  };

  test('routes sirius-kind node to siriusHandler; no upstream = Pending + SiriusUpstreamMissing', async () => {
    // `target.value` is `openai/gpt-4o`. With no sirius-providers.yaml
    // (or an empty one) the handler cannot resolve the `openai`
    // upstream and returns Pending so the operator can
    // `llamactl sirius add-provider` first.
    const node = siriusNode();
    const manifest = gatewayManifest(node.name);
    const result = await dispatchGatewayApply({
      manifest,
      getClient: noopClient,
      resolveNode: () => node,
    });
    expect(result).not.toBeNull();
    expect(result!.action).toBe('pending');
    expect(result!.statusSection.phase).toBe('Pending');
    expect(result!.statusSection.conditions[0]?.reason).toBe('SiriusUpstreamMissing');
  });

  test('routes embersynth-kind node to embersynthHandler; missing config = Pending', async () => {
    // No embersynth.yaml in the test's sandbox, so the handler halts
    // at the "load config" step with a clear actionable reason.
    const node = embersynthNode();
    const manifest = gatewayManifest(node.name, 'fusion-vision');
    const result = await dispatchGatewayApply({
      manifest,
      getClient: noopClient,
      resolveNode: () => node,
    });
    const reason = result!.statusSection.conditions[0]?.reason;
    expect(
      reason === 'EmbersynthConfigMissing' || reason === 'EmbersynthSyntheticMissing',
    ).toBe(true);
  });

  test('agent-kind node returns null — caller must fall through to serverStart', async () => {
    const node = agentNode();
    const manifest = gatewayManifest(node.name);
    const result = await dispatchGatewayApply({
      manifest,
      getClient: noopClient,
      resolveNode: () => node,
    });
    expect(result).toBeNull();
  });

  test('unknown node returns Pending with GatewayNodeUnknown', async () => {
    const manifest = gatewayManifest('ghost-node');
    const events: ApplyEvent[] = [];
    const result = await dispatchGatewayApply({
      manifest,
      getClient: noopClient,
      resolveNode: () => undefined,
      onEvent: (e) => events.push(e),
    });
    expect(result!.statusSection.conditions[0]?.reason).toBe('GatewayNodeUnknown');
    expect(events[0]?.type).toBe('gateway-pending');
  });

  test('unhandled node kind returns Pending with GatewayHandlerNotFound', async () => {
    const weird: ClusterNode = {
      name: 'weird',
      endpoint: '',
      kind: 'gateway',
      cloud: { provider: 'openai', baseUrl: 'https://api.openai.com/v1' },
    };
    const manifest = gatewayManifest(weird.name);
    // Registry with ONLY sirius + embersynth handlers — no catch-all.
    const handlers: GatewayHandler[] = [siriusHandler, embersynthHandler];
    const result = await dispatchGatewayApply({
      manifest,
      getClient: noopClient,
      resolveNode: () => weird,
      handlers,
    });
    expect(result!.statusSection.conditions[0]?.reason).toBe('GatewayHandlerNotFound');
  });

  test('respects deny override when caller passes a custom handler list', async () => {
    const node = siriusNode();
    const manifest = gatewayManifest(node.name);
    // Replace the sirius handler with a canned one; verifies the
    // registry is not hardcoded.
    const customHandler: GatewayHandler = {
      kind: 'sirius',
      canHandle: (n) => n.cloud?.provider === 'sirius',
      async apply() {
        const now = new Date().toISOString();
        return {
          action: 'pending',
          statusSection: {
            phase: 'Pending',
            serverPid: null,
            endpoint: null,
            lastTransitionTime: now,
            conditions: [
              {
                type: 'Applied',
                status: 'False',
                reason: 'CustomHandlerMarker',
                lastTransitionTime: now,
              },
            ],
          },
        };
      },
    };
    const result = await dispatchGatewayApply({
      manifest,
      getClient: noopClient,
      resolveNode: () => node,
      handlers: [customHandler],
    });
    expect(result!.statusSection.conditions[0]?.reason).toBe('CustomHandlerMarker');
  });
});

describe('applyOne + gatewayDispatch integration', () => {
  const noopClient: WorkloadClient = {
    serverStatus: {
      async query() {
        throw new Error('serverStatus should not be called on a gateway workload');
      },
    },
    serverStop: {
      async mutate() {
        throw new Error('serverStop should not be called on a gateway workload');
      },
    },
    serverStart: {
      subscribe() {
        throw new Error('serverStart should not be called on a gateway workload');
      },
    },
    rpcServerStart: {
      subscribe() {
        throw new Error('rpcServerStart should not be called');
      },
    },
    rpcServerStop: {
      async mutate() {
        throw new Error('rpcServerStop should not be called');
      },
    },
  };

  test('invokes the injected gatewayDispatch and returns its result', async () => {
    const manifest = gatewayManifest('sirius-primary');
    let dispatchCalled = 0;
    const result = await applyOne(
      manifest,
      () => noopClient,
      undefined,
      async () => {
        dispatchCalled++;
        const now = new Date().toISOString();
        return {
          action: 'pending',
          statusSection: {
            phase: 'Pending',
            serverPid: null,
            endpoint: null,
            lastTransitionTime: now,
            conditions: [
              {
                type: 'Applied',
                status: 'False',
                reason: 'DispatchedFake',
                lastTransitionTime: now,
              },
            ],
          },
        };
      },
    );
    expect(dispatchCalled).toBe(1);
    expect(result.statusSection.conditions[0]?.reason).toBe('DispatchedFake');
  });

  test('absent gatewayDispatch preserves the legacy GatewayRegistrationPending behavior', async () => {
    const manifest = gatewayManifest('sirius-primary');
    const result = await applyOne(manifest, () => noopClient);
    expect(result.action).toBe('pending');
    expect(result.statusSection.conditions[0]?.reason).toBe('GatewayRegistrationPending');
  });

  test('null dispatch result falls through to the regular serverStart path', async () => {
    // Build an agent-kind manifest that normally succeeds. We use a
    // fake client that returns "already running" so applyOne short-
    // circuits to `unchanged` — proves we fell through the gateway
    // branch and hit the regular code path.
    const manifest: ModelRun = {
      ...gatewayManifest('gpu1', 'some/model.gguf'),
      spec: {
        ...gatewayManifest('gpu1', 'some/model.gguf').spec,
      },
    };
    const liveClient: WorkloadClient = {
      serverStatus: {
        async query() {
          return {
            state: 'up',
            rel: 'some/model.gguf',
            extraArgs: [],
            pid: 4242,
            endpoint: 'http://gpu1.lan:8080',
          };
        },
      },
      serverStop: noopClient.serverStop,
      serverStart: noopClient.serverStart,
      rpcServerStart: noopClient.rpcServerStart,
      rpcServerStop: noopClient.rpcServerStop,
    };
    const result = await applyOne(
      manifest,
      () => liveClient,
      undefined,
      async () => null, // fallthrough sentinel
    );
    expect(result.action).toBe('unchanged');
    expect(result.statusSection.phase).toBe('Running');
    expect(result.statusSection.serverPid).toBe(4242);
  });
});
