import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendFleetJournal, readCurrentLeaseHolder } from '../src/journal.js';
import type { FleetSnapshotEntry } from '../src/types.js';

describe('appendFleetJournal', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('fleet-snapshot written to disk and parses back correctly', () => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-journal-test-'));
    const path = join(dir, 'journal.jsonl');
    const entry: FleetSnapshotEntry = {
      kind: 'fleet-snapshot',
      ts: '2026-05-22T17:00:00.000Z',
      node: 'local',
      node_mem: { free_mb: 1031, active_mb: 912, inactive_mb: 839,
                  wired_mb: 320, compressor_mb: 2600, swap_in: 0, swap_out: 0 },
      workloads: [{ name: 'qwen-host', kind: 'ModelHost', endpoint: 'http://127.0.0.1:8090',
                    priority: 50,
                    rss_mb: null, request_rate_5m: null, error_rate_5m: 0,
                    p50_ms: 240, p95_ms: 480, models: ['Qwen3-8B'], reachable: true,
                    consecutiveErrors: 0 }],
    };
    appendFleetJournal(entry, path);
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.kind).toBe('fleet-snapshot');
    expect(parsed.node).toBe('local');
    expect(parsed.workloads[0].name).toBe('qwen-host');
    expect(parsed.node_mem.compressor_mb).toBe(2600);
  });

  it('readCurrentLeaseHolder returns latest fleet-lease-election holder', () => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-journal-test-'));
    const path = join(dir, 'journal.jsonl');
    appendFleetJournal({
      kind: 'fleet-lease-election',
      ts: '2026-05-26T00:00:00.000Z',
      node: 'node-a',
      holder: 'node-a',
    }, path);
    appendFleetJournal({
      kind: 'fleet-lease-election',
      ts: '2026-05-26T00:00:01.000Z',
      node: 'node-b',
      holder: 'node-b',
    }, path);

    expect(readCurrentLeaseHolder(path)).toBe('node-b');
  });

  it('readCurrentLeaseHolder returns null for empty journal', () => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-journal-test-'));
    const path = join(dir, 'journal.jsonl');
    writeFileSync(path, '', 'utf8');
    expect(readCurrentLeaseHolder(path)).toBeNull();
  });
});
