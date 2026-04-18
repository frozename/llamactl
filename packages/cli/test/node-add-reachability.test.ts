import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  agentConfig as agentConfigMod,
  auth,
  startAgentServer,
  tls,
  type RunningAgent,
} from '@llamactl/remote';

/**
 * Targeted tests for Phase G.1: `node add` now probes the node for
 * reachability + TLS + auth before persisting. The happy-path uses a
 * real hermetic agent; the sad-paths use fabricated bootstrap blobs
 * that point at nothing.
 *
 * Uses async spawn (not spawnSync) for the CLI subprocess so the
 * in-process agent's event loop stays live to answer the probe.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = join(__dirname, '..', 'src', 'bin.ts');

interface CliResult { code: number; stdout: string; stderr: string; }
function runCliAsync(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 15_000): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn('bun', [CLI_ENTRY, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const killer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(killer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

let tmp: string;
let agent: RunningAgent | null = null;
let certPem = '';
let fingerprint = '';
let tokenValue = '';
const origEnv = { ...process.env };

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'llamactl-g1-'));
  const cert = await tls.generateSelfSignedCert({
    dir: tmp, commonName: '127.0.0.1', hostnames: ['127.0.0.1'],
  });
  certPem = cert.certPem;
  fingerprint = cert.fingerprint;
  const tok = auth.generateToken();
  tokenValue = tok.token;
  agent = startAgentServer({
    bindHost: '127.0.0.1', port: 0, tokenHash: tok.hash,
    tls: { certPath: cert.certPath, keyPath: cert.keyPath },
  });
});

afterEach(async () => {
  if (agent) { await agent.stop(); agent = null; }
  process.env = { ...origEnv };
  rmSync(tmp, { recursive: true, force: true });
});

function testEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LLAMACTL_CONFIG: join(tmp, 'kubeconfig'),
  };
}

describe('node add — reachability check', () => {
  test('real agent: probe succeeds, prints profile + platform', async () => {
    const blob = agentConfigMod.encodeBootstrap({
      url: agent!.url,
      fingerprint,
      token: tokenValue,
      certificate: certPem,
    });
    const r = await runCliAsync(['node', 'add', 'real', '--bootstrap', blob], testEnv());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("added node 'real'");
    expect(r.stdout).toContain('profile:');
    expect(r.stdout).toContain('platform:');
    expect(r.stdout).toContain('advertised:');
  }, 20_000);

  test('bogus URL: probe fails, refuses to persist, exit 1', async () => {
    const blob = agentConfigMod.encodeBootstrap({
      url: 'https://127.0.0.1:59999',                // dead port
      fingerprint: 'sha256:' + 'a'.repeat(64),
      token: 'bogus-token',
      certificate: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n',
    });
    const r = await runCliAsync(['node', 'add', 'dead', '--bootstrap', blob], testEnv());
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('reachability check failed');
    expect(r.stderr).toContain('--force');
  }, 20_000);

  test('bogus URL + --force: persists as unverified, exit 0', async () => {
    const blob = agentConfigMod.encodeBootstrap({
      url: 'https://127.0.0.1:59998',
      fingerprint: 'sha256:' + 'a'.repeat(64),
      token: 'bogus-token',
      certificate: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n',
    });
    const r = await runCliAsync(
      ['node', 'add', 'forced', '--bootstrap', blob, '--force'],
      testEnv(),
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("added node 'forced'");
    expect(r.stdout).toContain('[unverified]');
  }, 20_000);

  test('real URL but wrong fingerprint: probe fails with specific error', async () => {
    const blob = agentConfigMod.encodeBootstrap({
      url: agent!.url,
      fingerprint: 'sha256:' + 'b'.repeat(64),       // intentionally mismatched
      token: tokenValue,
      certificate: certPem,
    });
    const r = await runCliAsync(
      ['node', 'add', 'mismatched', '--bootstrap', blob],
      testEnv(),
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/fingerprint/i);
  }, 20_000);
});
