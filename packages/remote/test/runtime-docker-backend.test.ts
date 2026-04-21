import { describe, expect, test } from 'bun:test';
import {
  DockerBackend,
  createDockerBackend,
} from '../src/runtime/docker/backend.js';
import { RuntimeError } from '../src/runtime/errors.js';
import { LABEL_KEYS, MANAGED_BY_VALUE } from '../src/runtime/labels.js';
import type { ServiceDeployment } from '../src/runtime/backend.js';

/**
 * Phase 1 runtime-docker-backend tests — mock fetch at the transport
 * level and assert the HTTP call sequence for each lifecycle.
 *
 * The daemon is intentionally **not** spawned — the E2E test in
 * Phase 8 exercises a live daemon skip-gated on
 * `LLAMACTL_COMPOSITE_E2E=1`.
 */

interface Recorded {
  url: string;
  method: string;
  body?: string;
  unix?: string;
}

interface MockResponse {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

type Responder = (req: Recorded) => MockResponse;

function makeMockFetch(responder: Responder, recorded: Recorded[]): typeof fetch {
  const impl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const body = init?.body ? String(init.body) : undefined;
    const method = init?.method ?? 'GET';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const unix = (init as any)?.unix as string | undefined;
    const rec: Recorded = { url, method, body, unix };
    recorded.push(rec);
    const r = responder(rec);
    return new Response(r.body, { status: r.status, headers: r.headers });
  };
  // Bun's fetch type requires a `preconnect` method. Tests don't need
  // it — shim as a no-op so the cast typechecks cleanly.
  (impl as unknown as { preconnect: (url: string) => void }).preconnect = () => {};
  return impl as unknown as typeof fetch;
}

function jsonBody(obj: unknown): string {
  return JSON.stringify(obj);
}

function inspectBody(overrides: {
  running?: boolean;
  specHash?: string | null;
  health?: 'healthy' | 'unhealthy' | 'starting' | 'none';
  hostPort?: number;
  createdAt?: string;
} = {}): string {
  const labels: Record<string, string> = {
    [LABEL_KEYS.managedBy]: MANAGED_BY_VALUE,
  };
  if (overrides.specHash !== null && overrides.specHash !== undefined) {
    labels[LABEL_KEYS.specHash] = overrides.specHash;
  }
  return jsonBody({
    Id: 'c123',
    Name: '/test-service',
    Created: overrides.createdAt ?? '2026-04-20T15:00:00Z',
    State: {
      Running: overrides.running ?? true,
      Health: overrides.health ? { Status: overrides.health } : undefined,
    },
    Config: { Labels: labels },
    NetworkSettings: {
      Ports: {
        '8000/tcp': overrides.hostPort
          ? [{ HostIp: '0.0.0.0', HostPort: String(overrides.hostPort) }]
          : null,
      },
    },
  });
}

function sampleSpec(overrides: Partial<ServiceDeployment> = {}): ServiceDeployment {
  return {
    name: 'test-service',
    image: { repository: 'chromadb/chroma', tag: '1.5.8' },
    specHash: 'hash-v1',
    ports: [{ containerPort: 8000 }],
    ...overrides,
  };
}

describe('DockerBackend.ping', () => {
  test('ping succeeds when daemon returns OK', async () => {
    const recorded: Recorded[] = [];
    const backend = new DockerBackend({
      fetch: makeMockFetch(() => ({ status: 200, body: 'OK' }), recorded),
    });
    await backend.ping();
    expect(recorded[0]?.url).toContain('/v1.54/_ping');
  });

  test('ping surfaces backend-unreachable on transport failure', async () => {
    const rejectingFetch = (async () => {
      throw new Error('ENOENT: no such socket');
    }) as unknown as typeof fetch;
    const backend = new DockerBackend({ fetch: rejectingFetch });
    await expect(backend.ping()).rejects.toThrow(/unreachable/);
  });

  test('ping surfaces backend-unreachable on 500', async () => {
    const backend = new DockerBackend({
      fetch: makeMockFetch(
        () => ({ status: 500, body: jsonBody({ message: 'daemon crashed' }) }),
        [],
      ),
    });
    await expect(backend.ping()).rejects.toThrow(/docker ping failed/);
  });
});

describe('DockerBackend.ensureService — happy path (create fresh)', () => {
  test('inspect 404 → pull → create → start → re-inspect', async () => {
    const recorded: Recorded[] = [];
    let inspectCalls = 0;
    const responder: Responder = (req) => {
      if (req.url.includes('/containers/test-service/json')) {
        inspectCalls++;
        if (inspectCalls === 1) return { status: 404, body: jsonBody({ message: 'No such container' }) };
        return { status: 200, body: inspectBody({ specHash: 'hash-v1', hostPort: 8000 }) };
      }
      if (req.url.includes('/images/') && req.url.endsWith('/json')) {
        if (req.url.includes('chromadb%2Fchroma%3A1.5.8')) {
          // First call: image not present locally → 404. After pull:
          // 200 with arch/os matching the host.
          const calls = recorded.filter((r) => r.url.includes(req.url)).length;
          if (calls === 1) return { status: 404, body: '' };
          return {
            status: 200,
            body: jsonBody({ Architecture: 'amd64', Os: 'linux' }),
          };
        }
      }
      if (req.url.includes('/images/create') && req.method === 'POST') {
        return { status: 200, body: '{"status":"Downloading"}\n{"status":"Complete"}' };
      }
      if (req.url.includes('/containers/create') && req.method === 'POST') {
        return { status: 201, body: jsonBody({ Id: 'c123' }) };
      }
      if (req.url.match(/\/containers\/c123\/start/) && req.method === 'POST') {
        return { status: 204, body: '' };
      }
      throw new Error(`unexpected request: ${req.method} ${req.url}`);
    };
    const backend = new DockerBackend({
      fetch: makeMockFetch(responder, recorded),
      hostArch: 'amd64',
      hostOs: 'linux',
    });
    const instance = await backend.ensureService(sampleSpec());
    expect(instance.running).toBe(true);
    expect(instance.specHash).toBe('hash-v1');
    expect(instance.endpoint).toEqual({ host: '127.0.0.1', port: 8000 });

    // Assert the call sequence.
    const calls = recorded.map((r) => `${r.method} ${r.url}`);
    expect(calls.some((c) => c.includes('/containers/test-service/json'))).toBe(true);
    expect(calls.some((c) => c.includes('/images/create'))).toBe(true);
    expect(calls.some((c) => c.includes('/containers/create') && c.startsWith('POST'))).toBe(true);
    expect(calls.some((c) => c.includes('/containers/c123/start'))).toBe(true);
  });
});

describe('DockerBackend.ensureService — hash match (skip)', () => {
  test('running container with matching specHash → no-op', async () => {
    const recorded: Recorded[] = [];
    const backend = new DockerBackend({
      fetch: makeMockFetch((req) => {
        if (req.url.includes('/containers/test-service/json')) {
          return { status: 200, body: inspectBody({ specHash: 'hash-v1', hostPort: 8000 }) };
        }
        throw new Error(`unexpected ${req.method} ${req.url}`);
      }, recorded),
    });
    const instance = await backend.ensureService(sampleSpec());
    expect(instance.specHash).toBe('hash-v1');
    // Exactly one call — the inspect. No create, no start, no pull.
    expect(recorded).toHaveLength(1);
  });
});

describe('DockerBackend.ensureService — hash drift (recreate)', () => {
  test('running container with stale hash → stop + remove + recreate', async () => {
    const recorded: Recorded[] = [];
    let inspectCalls = 0;
    const responder: Responder = (req) => {
      if (req.url.includes('/containers/test-service/json')) {
        inspectCalls++;
        if (inspectCalls === 1) {
          // First inspect: stale hash on the running container.
          return { status: 200, body: inspectBody({ specHash: 'hash-OLD', hostPort: 8000 }) };
        }
        // After stop+remove+create+start.
        return { status: 200, body: inspectBody({ specHash: 'hash-v2', hostPort: 8000 }) };
      }
      if (req.url.includes('/stop') && req.method === 'POST') {
        return { status: 204, body: '' };
      }
      if (req.url.match(/DELETE/) || (req.method === 'DELETE' && req.url.includes('/containers/'))) {
        return { status: 204, body: '' };
      }
      if (req.url.includes('/images/') && req.url.endsWith('/json')) {
        return { status: 200, body: jsonBody({ Architecture: 'amd64', Os: 'linux' }) };
      }
      if (req.url.includes('/containers/create')) {
        return { status: 201, body: jsonBody({ Id: 'c456' }) };
      }
      if (req.url.includes('/containers/c456/start')) {
        return { status: 204, body: '' };
      }
      throw new Error(`unexpected ${req.method} ${req.url}`);
    };
    const backend = new DockerBackend({
      fetch: makeMockFetch(responder, recorded),
      hostArch: 'amd64',
      hostOs: 'linux',
    });
    const instance = await backend.ensureService(sampleSpec({ specHash: 'hash-v2' }));
    expect(instance.specHash).toBe('hash-v2');

    // Call sequence includes stop, delete, create, start.
    const methodsAndPaths = recorded.map((r) => `${r.method} ${new URL(r.url).pathname}`);
    expect(methodsAndPaths).toContain('POST /v1.54/containers/test-service/stop');
    expect(methodsAndPaths).toContain('DELETE /v1.54/containers/test-service');
    expect(methodsAndPaths).toContain('POST /v1.54/containers/create');
    expect(methodsAndPaths).toContain('POST /v1.54/containers/c456/start');
  });
});

describe('DockerBackend.ensureService — validation', () => {
  test('empty image tag → spec-invalid', async () => {
    const backend = new DockerBackend({ fetch: makeMockFetch(() => ({ status: 200, body: '{}' }), []) });
    await expect(
      backend.ensureService(sampleSpec({ image: { repository: 'chromadb/chroma', tag: '' } })),
    ).rejects.toThrow(/image\.tag is required/);
  });
});

describe('DockerBackend.ensureService — secrets', () => {
  test('resolves env-ref secrets and merges them into the container env', async () => {
    process.env.DOCKER_BACKEND_TEST_SECRET = 's3cr3t';
    const recorded: Recorded[] = [];
    let inspectCalls = 0;
    const responder: Responder = (req) => {
      if (req.url.includes('/containers/test-service/json')) {
        inspectCalls++;
        if (inspectCalls === 1) return { status: 404, body: '' };
        return { status: 200, body: inspectBody({ specHash: 'hash-v1', hostPort: 8000 }) };
      }
      if (req.url.includes('/images/') && req.url.endsWith('/json')) {
        return { status: 200, body: jsonBody({ Architecture: 'amd64', Os: 'linux' }) };
      }
      if (req.url.includes('/images/create')) return { status: 200, body: '{}' };
      if (req.url.includes('/containers/create')) return { status: 201, body: jsonBody({ Id: 'c1' }) };
      if (req.url.includes('/containers/c1/start')) return { status: 204, body: '' };
      throw new Error(`unexpected ${req.method} ${req.url}`);
    };
    const backend = new DockerBackend({
      fetch: makeMockFetch(responder, recorded),
      hostArch: 'amd64',
      hostOs: 'linux',
    });

    await backend.ensureService({
      ...sampleSpec(),
      env: { OTHER: 'plain' },
      secrets: {
        POSTGRES_PASSWORD: { ref: 'env:DOCKER_BACKEND_TEST_SECRET' },
      },
    });

    const createCall = recorded.find(
      (r) => r.method === 'POST' && r.url.includes('/containers/create'),
    );
    expect(createCall).toBeDefined();
    const body = JSON.parse(createCall!.body ?? '{}') as { Env?: string[] };
    expect(body.Env).toContain('OTHER=plain');
    expect(body.Env).toContain('POSTGRES_PASSWORD=s3cr3t');
    delete process.env.DOCKER_BACKEND_TEST_SECRET;
  });

  test('missing secret ref surfaces spec-invalid naming the env var', async () => {
    delete process.env.DOCKER_BACKEND_TEST_MISSING;
    const backend = new DockerBackend({
      fetch: makeMockFetch(
        (req) => {
          if (req.url.includes('/containers/test-service/json')) {
            return { status: 404, body: '' };
          }
          if (req.url.includes('/images/') && req.url.endsWith('/json')) {
            return { status: 200, body: jsonBody({ Architecture: 'amd64', Os: 'linux' }) };
          }
          if (req.url.includes('/images/create')) return { status: 200, body: '{}' };
          throw new Error(`unexpected ${req.method} ${req.url}`);
        },
        [],
      ),
      hostArch: 'amd64',
      hostOs: 'linux',
    });

    await expect(
      backend.ensureService({
        ...sampleSpec(),
        secrets: {
          POSTGRES_PASSWORD: { ref: 'env:DOCKER_BACKEND_TEST_MISSING' },
        },
      }),
    ).rejects.toThrow(/DOCKER_BACKEND_TEST_MISSING/);
  });
});

describe('DockerBackend.ensureService — configMap mounts rejected', () => {
  test('configMap volume → spec-invalid pointing operators at hostPath / name', async () => {
    const recorded: Recorded[] = [];
    const responder: Responder = (req) => {
      if (req.url.includes('/containers/test-service/json')) {
        return { status: 404, body: '' };
      }
      if (req.url.includes('/images/') && req.url.endsWith('/json')) {
        return {
          status: 200,
          body: jsonBody({ Architecture: 'amd64', Os: 'linux' }),
        };
      }
      if (req.url.includes('/images/create')) return { status: 200, body: '{}' };
      throw new Error(`unexpected ${req.method} ${req.url}`);
    };
    const backend = new DockerBackend({
      fetch: makeMockFetch(responder, recorded),
      hostArch: 'amd64',
      hostOs: 'linux',
    });

    await expect(
      backend.ensureService({
        ...sampleSpec(),
        volumes: [
          {
            configMap: { name: 'sirius-config', data: { 'a.yaml': 'x' } },
            containerPath: '/config',
          },
        ],
      }),
    ).rejects.toThrow(
      /volumes\[0\]: configMap mounts require runtime: kubernetes; use hostPath or name for docker/,
    );
  });
});

describe('DockerBackend.pullImage — NDJSON parsing', () => {
  test('drains progress lines and completes', async () => {
    const backend = new DockerBackend({
      fetch: makeMockFetch(
        () => ({
          status: 200,
          body:
            '{"status":"Pulling"}\n' +
            '{"status":"Downloading","progressDetail":{"current":100}}\n' +
            '{"status":"Complete"}\n',
        }),
        [],
      ),
    });
    await backend.pullImage({ repository: 'chromadb/chroma', tag: '1.5.8' });
  });

  test('error line in NDJSON → image-pull-failed', async () => {
    const backend = new DockerBackend({
      fetch: makeMockFetch(
        () => ({
          status: 200,
          body: '{"status":"Pulling"}\n{"error":"manifest unknown"}\n',
        }),
        [],
      ),
    });
    await expect(
      backend.pullImage({ repository: 'example/nope', tag: 'bogus' }),
    ).rejects.toThrow(/manifest unknown/);
  });

  test('non-200 response surfaces image-pull-failed', async () => {
    const backend = new DockerBackend({
      fetch: makeMockFetch(
        () => ({ status: 404, body: jsonBody({ message: 'no such image' }) }),
        [],
      ),
    });
    await expect(
      backend.pullImage({ repository: 'example/nope', tag: 'bogus' }),
    ).rejects.toThrow(RuntimeError);
  });
});

describe('DockerBackend — platform-mismatch', () => {
  test('arm64 host + amd64-only image → platform-mismatch error', async () => {
    const recorded: Recorded[] = [];
    const responder: Responder = (req) => {
      if (req.url.includes('/containers/test-service/json')) {
        return { status: 404, body: '' };
      }
      if (req.url.includes('/images/') && req.url.endsWith('/json')) {
        return {
          status: 200,
          body: jsonBody({ Architecture: 'amd64', Os: 'linux' }),
        };
      }
      throw new Error(`unexpected ${req.method} ${req.url}`);
    };
    const backend = new DockerBackend({
      fetch: makeMockFetch(responder, recorded),
      hostArch: 'arm64',
      hostOs: 'linux',
    });
    await expect(backend.ensureService(sampleSpec())).rejects.toThrow(
      /linux\/amd64.*arm64/,
    );
  });
});

describe('DockerBackend.removeService — 404 tolerant', () => {
  test('stop 404 + delete 404 resolves cleanly', async () => {
    const recorded: Recorded[] = [];
    const backend = new DockerBackend({
      fetch: makeMockFetch(
        () => ({ status: 404, body: jsonBody({ message: 'no such container' }) }),
        recorded,
      ),
    });
    await backend.removeService({ name: 'missing' });
    expect(recorded).toHaveLength(2);
    expect(recorded[0]?.method).toBe('POST');
    expect(recorded[1]?.method).toBe('DELETE');
  });

  test('stop succeeds then delete runs', async () => {
    const recorded: Recorded[] = [];
    const backend = new DockerBackend({
      fetch: makeMockFetch((req) => {
        if (req.method === 'POST' && req.url.includes('/stop')) {
          return { status: 204, body: '' };
        }
        if (req.method === 'DELETE') {
          return { status: 204, body: '' };
        }
        throw new Error(`unexpected ${req.method} ${req.url}`);
      }, recorded),
    });
    await backend.removeService({ name: 'running-service' });
    expect(recorded).toHaveLength(2);
  });
});

describe('DockerBackend.removeService — purgeVolumes flag', () => {
  test('default (no opts) sends v=false on DELETE', async () => {
    const recorded: Recorded[] = [];
    const backend = new DockerBackend({
      fetch: makeMockFetch(() => ({ status: 204, body: '' }), recorded),
    });
    await backend.removeService({ name: 'svc' });
    const delCall = recorded.find((r) => r.method === 'DELETE');
    expect(delCall).toBeDefined();
    expect(delCall!.url).toContain('v=false');
    expect(delCall!.url).toContain('force=true');
  });

  test('{ purgeVolumes: false } also sends v=false', async () => {
    const recorded: Recorded[] = [];
    const backend = new DockerBackend({
      fetch: makeMockFetch(() => ({ status: 204, body: '' }), recorded),
    });
    await backend.removeService({ name: 'svc' }, { purgeVolumes: false });
    const delCall = recorded.find((r) => r.method === 'DELETE');
    expect(delCall).toBeDefined();
    expect(delCall!.url).toContain('v=false');
  });

  test('{ purgeVolumes: true } flips DELETE to v=true', async () => {
    const recorded: Recorded[] = [];
    const backend = new DockerBackend({
      fetch: makeMockFetch(() => ({ status: 204, body: '' }), recorded),
    });
    await backend.removeService({ name: 'svc' }, { purgeVolumes: true });
    const delCall = recorded.find((r) => r.method === 'DELETE');
    expect(delCall).toBeDefined();
    expect(delCall!.url).toContain('v=true');
    expect(delCall!.url).toContain('force=true');
  });
});

describe('DockerBackend.inspectService', () => {
  test('404 → null (not an error)', async () => {
    const backend = new DockerBackend({
      fetch: makeMockFetch(() => ({ status: 404, body: '' }), []),
    });
    const res = await backend.inspectService({ name: 'nope' });
    expect(res).toBeNull();
  });

  test('200 → ServiceInstance with endpoint + health', async () => {
    const backend = new DockerBackend({
      fetch: makeMockFetch(
        () => ({ status: 200, body: inspectBody({ specHash: 'hash-v1', health: 'healthy', hostPort: 9000 }) }),
        [],
      ),
    });
    const res = await backend.inspectService({ name: 'test-service' });
    expect(res?.running).toBe(true);
    expect(res?.specHash).toBe('hash-v1');
    expect(res?.health).toBe('healthy');
    expect(res?.endpoint).toEqual({ host: '127.0.0.1', port: 9000 });
  });

  test('no llamactl label → specHash null', async () => {
    const backend = new DockerBackend({
      fetch: makeMockFetch(
        () => ({
          status: 200,
          body: jsonBody({
            Id: 'c', Name: '/x', Created: '2026-01-01T00:00:00Z',
            State: { Running: true },
            Config: { Labels: {} },
            NetworkSettings: { Ports: null },
          }),
        }),
        [],
      ),
    });
    const res = await backend.inspectService({ name: 'x' });
    expect(res?.specHash).toBeNull();
    expect(res?.endpoint).toBeNull();
  });
});

describe('DockerBackend.listServices', () => {
  test('filters by llamactl.managed-by and inspects each match', async () => {
    const recorded: Recorded[] = [];
    const backend = new DockerBackend({
      fetch: makeMockFetch((req) => {
        if (req.url.includes('/containers/json') && !req.url.includes('/test-')) {
          // list endpoint
          return {
            status: 200,
            body: jsonBody([
              { Id: 'c1', Names: ['/test-a'], Labels: { [LABEL_KEYS.managedBy]: MANAGED_BY_VALUE } },
              { Id: 'c2', Names: ['/test-b'], Labels: { [LABEL_KEYS.managedBy]: MANAGED_BY_VALUE } },
            ]),
          };
        }
        if (req.url.includes('/containers/test-a/json')) {
          return { status: 200, body: inspectBody({ specHash: 'a', hostPort: 8000 }) };
        }
        if (req.url.includes('/containers/test-b/json')) {
          return { status: 200, body: inspectBody({ specHash: 'b', hostPort: 8001 }) };
        }
        throw new Error(`unexpected ${req.method} ${req.url}`);
      }, recorded),
    });
    const list = await backend.listServices();
    expect(list).toHaveLength(2);
    // list call + two inspect calls
    expect(recorded).toHaveLength(3);
    // Filter encoded as `label=llamactl.managed-by=llamactl`
    const listCall = recorded[0];
    expect(listCall?.url).toContain('filters=');
    expect(decodeURIComponent(listCall?.url ?? '')).toContain(LABEL_KEYS.managedBy);
  });
});

describe('createDockerBackend factory', () => {
  test('returns a DockerBackend instance with kind=docker', async () => {
    const backend = createDockerBackend({
      fetch: makeMockFetch(() => ({ status: 200, body: 'OK' }), []),
    });
    expect(backend.kind).toBe('docker');
    await backend.ping();
  });
});
