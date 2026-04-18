import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateToken } from '../src/server/auth.js';
import { discoverAgents } from '../src/server/mdns.js';
import { startAgentServer, type RunningAgent } from '../src/server/serve.js';
import { generateSelfSignedCert } from '../src/server/tls.js';

/**
 * Spin up two agents advertising over mDNS and confirm `discoverAgents`
 * surfaces both. Runs on the loopback interface so the advertisement
 * stays inside the test host's network stack and doesn't pollute the
 * real LAN.
 *
 * CI note: some hardened container hosts block multicast; in that
 * case the test will time out without finding anything. Skip there
 * by setting `LLAMACTL_SKIP_MDNS_TESTS=1`.
 */

const SKIP = process.env.LLAMACTL_SKIP_MDNS_TESTS === '1';

let tmp = '';
const agents: RunningAgent[] = [];

beforeAll(async () => {
  if (SKIP) return;
  tmp = mkdtempSync(join(tmpdir(), 'llamactl-mdns-'));

  for (const name of ['mdns-node-1', 'mdns-node-2']) {
    const dir = join(tmp, name);
    const cert = await generateSelfSignedCert({
      dir,
      commonName: '127.0.0.1',
      hostnames: ['127.0.0.1', 'localhost'],
    });
    const token = generateToken();
    const agent = startAgentServer({
      bindHost: '127.0.0.1',
      port: 0,
      tokenHash: token.hash,
      tls: { certPath: cert.certPath, keyPath: cert.keyPath },
      nodeName: name,
      version: '0.9.9',
      advertiseMdns: true,
    });
    agents.push(agent);
  }
});

afterAll(async () => {
  if (SKIP) return;
  for (const a of agents) await a.stop().catch(() => {});
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(SKIP)('mDNS agent discovery', () => {
  test('finds both advertised agents and carries node+fingerprint metadata', async () => {
    // Give the OS a moment to publish before we start browsing — some
    // Bonjour implementations defer the first multicast.
    await new Promise((r) => setTimeout(r, 500));
    const found = await discoverAgents(4000);
    const byNode = new Map(found.map((f) => [f.nodeName, f]));
    expect(byNode.has('mdns-node-1')).toBe(true);
    expect(byNode.has('mdns-node-2')).toBe(true);
    for (const name of ['mdns-node-1', 'mdns-node-2']) {
      const svc = byNode.get(name)!;
      expect(svc.port).toBeGreaterThan(0);
      expect(svc.version).toBe('0.9.9');
      expect(svc.fingerprint).toBeTruthy();
      expect(svc.fingerprint!.startsWith('sha256:')).toBe(true);
    }
  }, 20_000);
});
