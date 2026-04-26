import { describe, expect, test } from 'bun:test';
import {
  CompositeSchema,
  CompositeSpecSchema,
} from '../src/composite/schema.js';

function minimalRaw() {
  return {
    apiVersion: 'llamactl/v1' as const,
    kind: 'Composite' as const,
    metadata: { name: 'minimal' },
    spec: {},
  };
}

describe('CompositeSchema — valid shapes', () => {
  test('minimal composite (just metadata + empty spec) parses', () => {
    const raw = {
      apiVersion: 'llamactl/v1',
      kind: 'Composite',
      metadata: { name: 'empty' },
      spec: {},
    };
    const m = CompositeSchema.parse(raw);
    expect(m.metadata.name).toBe('empty');
    expect(m.spec.services).toEqual([]);
    expect(m.spec.workloads).toEqual([]);
    expect(m.spec.ragNodes).toEqual([]);
    expect(m.spec.gateways).toEqual([]);
    expect(m.spec.dependencies).toEqual([]);
  });

  test('defaults: onFailure=rollback, dependencies=[]', () => {
    const m = CompositeSchema.parse({
      apiVersion: 'llamactl/v1',
      kind: 'Composite',
      metadata: { name: 'defaults' },
      spec: {},
    });
    expect(m.spec.onFailure).toBe('rollback');
    expect(m.spec.dependencies).toEqual([]);
  });

  test('composite with just a chroma service parses', () => {
    const m = CompositeSchema.parse({
      apiVersion: 'llamactl/v1',
      kind: 'Composite',
      metadata: { name: 'chroma-only' },
      spec: {
        services: [
          { kind: 'chroma', name: 'kb', node: 'local' },
        ],
      },
    });
    expect(m.spec.services.length).toBe(1);
    expect(m.spec.services[0]?.kind).toBe('chroma');
  });

  test('full composite (service + workload + rag + gateway + deps) parses', () => {
    const m = CompositeSchema.parse({
      apiVersion: 'llamactl/v1',
      kind: 'Composite',
      metadata: { name: 'full', labels: { env: 'dev' } },
      spec: {
        services: [
          { kind: 'chroma', name: 'kb', node: 'local' },
          {
            kind: 'pgvector',
            name: 'pg',
            node: 'local',
            passwordEnv: 'PG_PASSWORD',
          },
        ],
        workloads: [
          {
            node: 'local',
            target: { kind: 'rel', value: 'models/7b.gguf' },
          },
        ],
        ragNodes: [
          {
            name: 'kb-node',
            node: 'local',
            binding: {
              provider: 'chroma',
              endpoint: 'http://localhost:8000',
            },
            backingService: 'kb',
          },
        ],
        gateways: [
          {
            name: 'gw',
            node: 'local',
            provider: 'sirius',
            upstreamWorkloads: ['local'],
            providerConfig: { extra: { route: '/v1' } },
          },
        ],
        dependencies: [
          {
            from: { kind: 'rag', name: 'kb-node' },
            to: { kind: 'service', name: 'kb' },
          },
        ],
      },
    });
    expect(m.spec.services.length).toBe(2);
    expect(m.spec.workloads.length).toBe(1);
    expect(m.spec.ragNodes.length).toBe(1);
    expect(m.spec.gateways.length).toBe(1);
    expect(m.spec.dependencies.length).toBe(1);
  });

  test('ragBinding inside an entry parses with all fields', () => {
    const m = CompositeSchema.parse({
      apiVersion: 'llamactl/v1',
      kind: 'Composite',
      metadata: { name: 'rag-full' },
      spec: {
        services: [{ kind: 'chroma', name: 'kb', node: 'local' }],
        ragNodes: [
          {
            name: 'kb-node',
            node: 'local',
            binding: {
              provider: 'chroma',
              endpoint: 'http://localhost:8000',
              collection: 'docs',
              auth: { tokenEnv: 'CHROMA_TOKEN' },
              embedModel: 'bge-small',
              extraArgs: ['--log-level=debug'],
            },
            backingService: 'kb',
          },
        ],
      },
    });
    const rn = m.spec.ragNodes[0]!;
    expect(rn.binding.collection).toBe('docs');
    expect(rn.binding.auth?.tokenEnv).toBe('CHROMA_TOKEN');
    expect(rn.binding.embedModel).toBe('bge-small');
    expect(rn.binding.extraArgs).toEqual(['--log-level=debug']);
  });
});

describe('CompositeSchema — metadata validation', () => {
  test('metadata.name with uppercase is rejected', () => {
    expect(() =>
      CompositeSchema.parse({
        apiVersion: 'llamactl/v1',
        kind: 'Composite',
        metadata: { name: 'Uppercase' },
        spec: {},
      }),
    ).toThrow();
  });

  test('metadata.name with spaces is rejected', () => {
    expect(() =>
      CompositeSchema.parse({
        apiVersion: 'llamactl/v1',
        kind: 'Composite',
        metadata: { name: 'with space' },
        spec: {},
      }),
    ).toThrow();
  });

  test('metadata.name with underscore is rejected', () => {
    expect(() =>
      CompositeSchema.parse({
        apiVersion: 'llamactl/v1',
        kind: 'Composite',
        metadata: { name: 'snake_case' },
        spec: {},
      }),
    ).toThrow();
  });

  test('metadata.name lowercase-alphanumeric-hyphens accepted', () => {
    const m = CompositeSchema.parse({
      apiVersion: 'llamactl/v1',
      kind: 'Composite',
      metadata: { name: 'stack-7b-rag-2' },
      spec: {},
    });
    expect(m.metadata.name).toBe('stack-7b-rag-2');
  });

  test('kind !== Composite is rejected', () => {
    expect(() =>
      CompositeSchema.parse({
        apiVersion: 'llamactl/v1',
        kind: 'ModelRun',
        metadata: { name: 'bogus' },
        spec: {},
      }),
    ).toThrow();
  });
});

describe('CompositeSchema — cross-component validation', () => {
  test('duplicate service names rejected', () => {
    expect(() =>
      CompositeSchema.parse({
        apiVersion: 'llamactl/v1',
        kind: 'Composite',
        metadata: { name: 'dup-svc' },
        spec: {
          services: [
            { kind: 'chroma', name: 'kb', node: 'local' },
            { kind: 'pgvector', name: 'kb', node: 'local' },
          ],
        },
      }),
    ).toThrow(/duplicate service component name/);
  });

  test('duplicate rag-node names rejected', () => {
    expect(() =>
      CompositeSchema.parse({
        apiVersion: 'llamactl/v1',
        kind: 'Composite',
        metadata: { name: 'dup-rag' },
        spec: {
          services: [{ kind: 'chroma', name: 'kb', node: 'local' }],
          ragNodes: [
            {
              name: 'same',
              node: 'local',
              binding: { provider: 'chroma', endpoint: 'http://a' },
            },
            {
              name: 'same',
              node: 'local',
              binding: { provider: 'chroma', endpoint: 'http://b' },
            },
          ],
        },
      }),
    ).toThrow(/duplicate rag component name/);
  });

  test('duplicate gateway names rejected', () => {
    expect(() =>
      CompositeSchema.parse({
        apiVersion: 'llamactl/v1',
        kind: 'Composite',
        metadata: { name: 'dup-gw' },
        spec: {
          gateways: [
            { name: 'gw', node: 'local', provider: 'sirius' },
            { name: 'gw', node: 'local', provider: 'embersynth' },
          ],
        },
      }),
    ).toThrow(/duplicate gateway component name/);
  });

  test('same name across different kinds is OK', () => {
    const m = CompositeSchema.parse({
      apiVersion: 'llamactl/v1',
      kind: 'Composite',
      metadata: { name: 'shared' },
      spec: {
        services: [{ kind: 'chroma', name: 'shared', node: 'local' }],
        ragNodes: [
          {
            name: 'shared',
            node: 'local',
            binding: { provider: 'chroma', endpoint: 'http://x' },
          },
        ],
      },
    });
    expect(m.spec.services[0]?.name).toBe('shared');
    expect(m.spec.ragNodes[0]?.name).toBe('shared');
  });

  test('dependency.from referencing missing component rejected', () => {
    expect(() =>
      CompositeSchema.parse({
        apiVersion: 'llamactl/v1',
        kind: 'Composite',
        metadata: { name: 'bad-dep-from' },
        spec: {
          services: [{ kind: 'chroma', name: 'kb', node: 'local' }],
          dependencies: [
            {
              from: { kind: 'rag', name: 'missing' },
              to: { kind: 'service', name: 'kb' },
            },
          ],
        },
      }),
    ).toThrow(/unknown rag 'missing'/);
  });

  test('dependency.to referencing missing component rejected', () => {
    expect(() =>
      CompositeSchema.parse({
        apiVersion: 'llamactl/v1',
        kind: 'Composite',
        metadata: { name: 'bad-dep-to' },
        spec: {
          services: [{ kind: 'chroma', name: 'kb', node: 'local' }],
          ragNodes: [
            {
              name: 'kb-node',
              node: 'local',
              binding: { provider: 'chroma', endpoint: 'http://a' },
            },
          ],
          dependencies: [
            {
              from: { kind: 'rag', name: 'kb-node' },
              to: { kind: 'service', name: 'missing' },
            },
          ],
        },
      }),
    ).toThrow(/unknown service 'missing'/);
  });

  test('ragNode.backingService pointing at missing service rejected', () => {
    expect(() =>
      CompositeSchema.parse({
        apiVersion: 'llamactl/v1',
        kind: 'Composite',
        metadata: { name: 'bad-backing' },
        spec: {
          ragNodes: [
            {
              name: 'kb-node',
              node: 'local',
              binding: { provider: 'chroma', endpoint: 'http://a' },
              backingService: 'ghost',
            },
          ],
        },
      }),
    ).toThrow(/unknown backingService 'ghost'/);
  });

  test('ragNode without backingService is fine', () => {
    const m = CompositeSchema.parse({
      apiVersion: 'llamactl/v1',
      kind: 'Composite',
      metadata: { name: 'external-rag' },
      spec: {
        ragNodes: [
          {
            name: 'kb-node',
            node: 'local',
            binding: {
              provider: 'chroma',
              endpoint: 'http://external:8000',
            },
          },
        ],
      },
    });
    expect(m.spec.ragNodes[0]?.backingService).toBeUndefined();
  });

  test('gateway.upstreamWorkloads pointing at missing workload rejected', () => {
    expect(() =>
      CompositeSchema.parse({
        apiVersion: 'llamactl/v1',
        kind: 'Composite',
        metadata: { name: 'bad-upstream' },
        spec: {
          gateways: [
            {
              name: 'gw',
              node: 'local',
              provider: 'sirius',
              upstreamWorkloads: ['nope'],
            },
          ],
        },
      }),
    ).toThrow(/unknown upstream workload 'nope'/);
  });

  test('minimal CompositeSpec (no fields) parses directly', () => {
    const s = CompositeSpecSchema.parse({});
    expect(s.services).toEqual([]);
    expect(s.dependencies).toEqual([]);
    expect(s.onFailure).toBe('rollback');
  });

  test('minimalRaw() helper passes the refine', () => {
    const m = CompositeSchema.parse(minimalRaw());
    expect(m.metadata.name).toBe('minimal');
  });
});
