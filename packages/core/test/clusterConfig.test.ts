import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readClusterConfig } from '../../remote/src/config/cluster.js';

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'llamactl-cluster-config-'));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('T1: parses peers + caPemPath from valid YAML', () => {
  const t = tempDir();
  try {
    const path = join(t.dir, 'cluster.yaml');
    writeFileSync(
      path,
      [
        'peers:',
        '  - id: mac-mini',
        '    endpoint: https://macmini.ai:7843',
        '    caPemPath: ~/.llamactl/certs/mac-mini-ca.pem',
      ].join('\n'),
    );
    expect(readClusterConfig(path)).toEqual({
      peers: [
        {
          id: 'mac-mini',
          endpoint: 'https://macmini.ai:7843',
          caPemPath: '~/.llamactl/certs/mac-mini-ca.pem',
        },
      ],
    });
  } finally {
    t.cleanup();
  }
});

test('T2: missing file returns { peers: [] } and does not throw', () => {
  const t = tempDir();
  try {
    expect(readClusterConfig(join(t.dir, 'does-not-exist.yaml'))).toEqual({ peers: [] });
  } finally {
    t.cleanup();
  }
});

test('T3: malformed YAML throws', () => {
  const t = tempDir();
  try {
    const path = join(t.dir, 'cluster.yaml');
    writeFileSync(path, 'peers:\n  - id: bad\n    endpoint: [');
    expect(() => readClusterConfig(path)).toThrow();
  } finally {
    t.cleanup();
  }
});
