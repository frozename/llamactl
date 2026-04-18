import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { runSirius } from '../src/commands/sirius.js';

/**
 * `llamactl sirius export` reads the kubeconfig and emits a
 * sirius-compatible `LLAMACTL_NODES` payload. Tests cover the three
 * output formats (json/yaml/env), token placeholder vs inline, and
 * the cloud/local skip rules.
 */

let tmp = '';
const originalEnv = { ...process.env };

function writeConfig(nodes: Array<Record<string, unknown>>, user: { name: string; token?: string }): string {
  const cfg = {
    apiVersion: 'llamactl/v1',
    kind: 'Config',
    currentContext: 'default',
    contexts: [{ name: 'default', cluster: 'home', user: user.name, defaultNode: 'local' }],
    clusters: [{ name: 'home', nodes }],
    users: [user],
  };
  const path = join(tmp, 'config');
  writeFileSync(path, stringifyYaml(cfg));
  return path;
}

let captured = '';
const originalWrite = process.stdout.write.bind(process.stdout);

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'llamactl-sirius-'));
  captured = '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stdout.write = ((chunk: any) => {
    captured += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
});

afterEach(() => {
  process.stdout.write = originalWrite;
  rmSync(tmp, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

describe('llamactl sirius export', () => {
  test('emits a JSON entry per agent node with token placeholders', async () => {
    process.env.LLAMACTL_CONFIG = writeConfig(
      [
        { name: 'local', endpoint: 'inproc://local' },
        {
          name: 'gpu1',
          endpoint: 'https://gpu1.lan:7843',
          certificateFingerprint: 'sha256:aa',
        },
      ],
      { name: 'me', token: 'super-secret-token' },
    );
    const code = await runSirius(['export']);
    expect(code).toBe(0);
    const parsed = JSON.parse(captured) as Array<{ name: string; baseUrl: string; apiKey: string }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.name).toBe('gpu1');
    expect(parsed[0]!.baseUrl).toBe('https://gpu1.lan:7843/v1');
    expect(parsed[0]!.apiKey).toBe('${LLAMACTL_TOKEN_GPU1}');
  });

  test('--token-inline resolves the actual token', async () => {
    process.env.LLAMACTL_CONFIG = writeConfig(
      [{ name: 'gpu1', endpoint: 'https://gpu1.lan:7843', certificateFingerprint: 'sha256:aa' }],
      { name: 'me', token: 'super-secret' },
    );
    const code = await runSirius(['export', '--token-inline']);
    expect(code).toBe(0);
    const parsed = JSON.parse(captured) as Array<{ apiKey: string }>;
    expect(parsed[0]!.apiKey).toBe('super-secret');
  });

  test('--format env emits a shell-quoted export line', async () => {
    process.env.LLAMACTL_CONFIG = writeConfig(
      [{ name: 'gpu1', endpoint: 'https://gpu1.lan:7843', certificateFingerprint: 'sha256:aa' }],
      { name: 'me', token: 'x' },
    );
    const code = await runSirius(['export', '--format', 'env']);
    expect(code).toBe(0);
    expect(captured.startsWith("export LLAMACTL_NODES='")).toBe(true);
    expect(captured).toContain('"name":"gpu1"');
    expect(captured).toContain('"baseUrl":"https://gpu1.lan:7843/v1"');
  });

  test('--format yaml emits a llamactlNodes block', async () => {
    process.env.LLAMACTL_CONFIG = writeConfig(
      [{ name: 'gpu1', endpoint: 'https://gpu1.lan:7843', certificateFingerprint: 'sha256:aa' }],
      { name: 'me', token: 'x' },
    );
    const code = await runSirius(['export', '--format', 'yaml']);
    expect(code).toBe(0);
    expect(captured).toContain('llamactlNodes:');
    expect(captured).toContain('name: gpu1');
  });

  test('add-provider writes YAML and list-providers reads it back', async () => {
    process.env.DEV_STORAGE = tmp;
    process.env.LLAMACTL_SIRIUS_PROVIDERS = join(tmp, 'providers.yaml');
    const addCode = await runSirius([
      'add-provider',
      'openai',
      '--api-key-ref',
      '$OPENAI_API_KEY',
    ]);
    expect(addCode).toBe(0);
    expect(captured).toContain("registered sirius provider 'openai'");

    captured = '';
    const listCode = await runSirius(['list-providers']);
    expect(listCode).toBe(0);
    const parsed = JSON.parse(captured) as Array<{ name: string; kind: string; baseUrl: string }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.name).toBe('openai');
    expect(parsed[0]!.kind).toBe('openai');
    expect(parsed[0]!.baseUrl).toBe('https://api.openai.com/v1');
  });

  test('add-provider rejects a named provider without --api-key-ref', async () => {
    process.env.DEV_STORAGE = tmp;
    process.env.LLAMACTL_SIRIUS_PROVIDERS = join(tmp, 'providers.yaml');
    const code = await runSirius(['add-provider', 'anthropic']);
    expect(code).toBe(1);
  });

  test('add-provider openai-compatible allows anonymous (no --api-key-ref)', async () => {
    process.env.DEV_STORAGE = tmp;
    process.env.LLAMACTL_SIRIUS_PROVIDERS = join(tmp, 'providers.yaml');
    const code = await runSirius([
      'add-provider',
      'openai-compatible',
      '--name',
      'vllm',
      '--base-url',
      'http://gpu.lan:8000/v1',
    ]);
    expect(code).toBe(0);
    expect(captured).toContain("registered sirius provider 'vllm'");
  });

  test('remove-provider deletes entries by name', async () => {
    process.env.DEV_STORAGE = tmp;
    process.env.LLAMACTL_SIRIUS_PROVIDERS = join(tmp, 'providers.yaml');
    await runSirius(['add-provider', 'openai', '--api-key-ref', '$X']);
    captured = '';
    const removeCode = await runSirius(['remove-provider', 'openai']);
    expect(removeCode).toBe(0);
    expect(captured).toContain("removed sirius provider 'openai'");
    captured = '';
    await runSirius(['list-providers']);
    expect(JSON.parse(captured)).toEqual([]);
  });

  test('skips non-agent nodes', async () => {
    // Gateway nodes (sirius, openai-compat aggregators) are sirius's
    // own upstreams — they must not be re-exported to sirius as
    // llamactl agents. Only `kind: agent` nodes show up.
    process.env.LLAMACTL_CONFIG = writeConfig(
      [
        {
          name: 'sirius',
          endpoint: '',
          kind: 'gateway',
          cloud: {
            provider: 'sirius',
            baseUrl: 'http://localhost:3000/v1',
          },
        },
        { name: 'gpu1', endpoint: 'https://gpu1.lan:7843', certificateFingerprint: 'sha256:aa' },
      ],
      { name: 'me', token: 'x' },
    );
    const code = await runSirius(['export']);
    expect(code).toBe(0);
    const parsed = JSON.parse(captured) as Array<{ name: string }>;
    expect(parsed.map((p) => p.name)).toEqual(['gpu1']);
  });
});
