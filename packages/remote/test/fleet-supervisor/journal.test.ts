import { describe, expect, test } from 'bun:test';
import { appendFleetSnapshot } from '../../../core/src/fleet-supervisor/journal.js';

describe('fleet supervisor journal', () => {
  test('writes kind=fleet-snapshot lines with node and workload payloads', async () => {
    const lines: string[] = [];
    await appendFleetSnapshot(
      {
        ts: '2026-05-22T17:00:00Z',
        kind: 'fleet-snapshot',
        node: 'local',
        node_mem: {
          free_mb: 122,
          compressor_mb: 4045,
          active_mb: 912,
          inactive_mb: 839,
          wired_mb: 320,
        },
        workloads: [],
      },
      { appendLine: async (line: string) => { lines.push(line); } },
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"kind":"fleet-snapshot"');
    expect(lines[0]).toContain('"node":"local"');
  });
});
