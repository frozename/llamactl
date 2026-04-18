import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentConfig as agentConfigMod } from '@llamactl/remote';
import { makeTempRuntime, runCli } from './helpers.js';

function augment(env: NodeJS.ProcessEnv, devStorage: string): NodeJS.ProcessEnv {
  return {
    ...env,
    LLAMACTL_CONFIG: join(devStorage, 'config'),
    LLAMACTL_AGENT_DIR: join(devStorage, 'agent'),
  };
}

describe('llamactl ctx', () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  beforeEach(() => { temp = makeTempRuntime(); });
  afterEach(() => temp.cleanup());

  test('ctx current on fresh config → "default"', () => {
    const r = runCli(['ctx', 'current'], augment(temp.env, temp.devStorage));
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('default');
  });

  test('ctx use with unknown context fails', () => {
    const r = runCli(['ctx', 'use', 'no-such-ctx'], augment(temp.env, temp.devStorage));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('no context named');
  });

  test('ctx get prints valid config', () => {
    const r = runCli(['ctx', 'get'], augment(temp.env, temp.devStorage));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('llamactl/v1');
  });

  test('ctx nodes is an alias for node ls', () => {
    const r = runCli(['ctx', 'nodes'], augment(temp.env, temp.devStorage));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('local');
  });
});

describe('llamactl node', () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  beforeEach(() => { temp = makeTempRuntime(); });
  afterEach(() => temp.cleanup());

  test('node ls on fresh config shows local (default)', () => {
    const r = runCli(['node', 'ls'], augment(temp.env, temp.devStorage));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('local');
    expect(r.stdout).toContain('default');
  });

  test('node rm local is refused', () => {
    const r = runCli(['node', 'rm', 'local'], augment(temp.env, temp.devStorage));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('refusing');
  });

  test('node add --bootstrap persists a remote entry', () => {
    const env = augment(temp.env, temp.devStorage);
    const blob = agentConfigMod.encodeBootstrap({
      url: 'https://fake.lan:7843',
      fingerprint: 'sha256:' + 'a'.repeat(64),
      token: 'll_agt_sampleToken',
      certificate: '-----BEGIN CERTIFICATE-----\nABCD\n-----END CERTIFICATE-----\n',
    });
    const add = runCli(['node', 'add', 'gpu1', '--bootstrap', blob], env);
    expect(add.code).toBe(0);
    expect(add.stdout).toContain("added node 'gpu1'");

    const ls = runCli(['node', 'ls'], env);
    expect(ls.code).toBe(0);
    expect(ls.stdout).toContain('gpu1');
    expect(ls.stdout).toContain('https://fake.lan:7843');

    const cfgRaw = readFileSync(env.LLAMACTL_CONFIG!, 'utf8');
    expect(cfgRaw).toContain('gpu1');
    expect(cfgRaw).toContain('certificateFingerprint');
  });

  test('node add with --server + --fingerprint + --token works without bootstrap', () => {
    const env = augment(temp.env, temp.devStorage);
    const r = runCli([
      'node', 'add', 'gpu2',
      '--server', 'https://gpu2.lan:7843',
      '--fingerprint', 'sha256:' + 'b'.repeat(64),
      '--token', 'll_agt_abc',
    ], env);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("added node 'gpu2'");
  });

  test('node add without required auth args fails', () => {
    const env = augment(temp.env, temp.devStorage);
    const r = runCli(['node', 'add', 'gpu3', '--server', 'https://x:1', '--fingerprint', 'sha256:aa'], env);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/--token|--token-file/);
  });

  test('node add then rm removes the entry', () => {
    const env = augment(temp.env, temp.devStorage);
    runCli([
      'node', 'add', 'gpu3',
      '--server', 'https://gpu3.lan:7843',
      '--fingerprint', 'sha256:' + 'c'.repeat(64),
      '--token', 'ok',
    ], env);
    const rm = runCli(['node', 'rm', 'gpu3'], env);
    expect(rm.code).toBe(0);
    const ls = runCli(['node', 'ls'], env);
    expect(ls.stdout).not.toContain('gpu3');
  });

  test('node test against non-existent node fails cleanly', () => {
    const r = runCli(['node', 'test', 'no-such'], augment(temp.env, temp.devStorage));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('not found');
  });
});

describe('llamactl agent', () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  beforeEach(() => { temp = makeTempRuntime(); });
  afterEach(() => temp.cleanup());

  test('agent init emits files + bootstrap line', () => {
    const env = augment(temp.env, temp.devStorage);
    const r = runCli([
      'agent', 'init',
      '--host=127.0.0.1',
      '--port=17849',
      '--name=probe',
      '--bind=127.0.0.1',
      '--san=127.0.0.1,localhost',
    ], env);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('llamactl node add probe --bootstrap ');
    const dir = env.LLAMACTL_AGENT_DIR!;
    expect(existsSync(join(dir, 'agent.yaml'))).toBe(true);
    expect(existsSync(join(dir, 'agent.crt'))).toBe(true);
    expect(existsSync(join(dir, 'agent.key'))).toBe(true);
  });

  test('agent init refuses to overwrite existing config', () => {
    const env = augment(temp.env, temp.devStorage);
    const args = [
      'agent', 'init',
      '--host=127.0.0.1', '--port=17850',
      '--name=probe', '--san=127.0.0.1',
    ];
    const first = runCli(args, env);
    expect(first.code).toBe(0);
    const second = runCli(args, env);
    expect(second.code).toBe(1);
    expect(second.stderr).toContain('already exists');
  });

  test('agent status reads the config and prints key fields', () => {
    const env = augment(temp.env, temp.devStorage);
    runCli([
      'agent', 'init',
      '--host=127.0.0.1', '--port=17851',
      '--name=probe', '--san=127.0.0.1',
    ], env);
    const r = runCli(['agent', 'status'], env);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('probe');
    expect(r.stdout).toContain('127.0.0.1:17851');
    expect(r.stdout).toContain('sha256:');
  });

  test('agent status with no config fails', () => {
    const r = runCli(['agent', 'status'], augment(temp.env, temp.devStorage));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('no agent config');
  });
});
