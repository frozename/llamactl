import { describe, it, expect } from 'bun:test';
import { PressureWindow, detectPressure } from '../src/policy.js';
import type { NodeMemSnapshot, WorkloadSnapshot } from '../src/types.js';

const THRESHOLDS = { headroomMinMb: 512, compressorWarnMb: 2048, consecutiveTicks: 3 };

const HIGH: NodeMemSnapshot = {
  free_mb: 30, compressor_mb: 4000,
  active_mb: 0, inactive_mb: 0, wired_mb: 0, swap_in: 0, swap_out: 0,
};
const NORMAL: NodeMemSnapshot = {
  free_mb: 4096, compressor_mb: 200,
  active_mb: 0, inactive_mb: 0, wired_mb: 0, swap_in: 0, swap_out: 0,
};

const WLS: WorkloadSnapshot[] = [
  {
    name: 'gains-host-35b-local', kind: 'ModelHost', priority: 50, endpoint: 'http://127.0.0.1:8096',
    rss_mb: 36864, reachable: true, consecutiveErrors: 0,
    request_rate_5m: 2, error_rate_5m: 0, p50_ms: 240, p95_ms: 480, models: [],
  },
  {
    name: 'granite-3b-local', kind: 'ModelHost', priority: 50, endpoint: 'http://127.0.0.1:8083',
    rss_mb: 4096, reachable: true, consecutiveErrors: 0,
    request_rate_5m: 1, error_rate_5m: 0, p50_ms: 100, p95_ms: 200, models: [],
  },
];

describe('detectPressure', () => {
  it('3 consecutive HIGH ticks → level HIGH + evict largest RSS', () => {
    const window = new PressureWindow(3);
    for (let i = 0; i < 3; i++) window.push(HIGH, WLS);
    const result = detectPressure(window, THRESHOLDS);
    expect(result).not.toBeNull();
    expect(result!.level).toBe('HIGH');
    expect(result!.proposal.action.type).toBe('evict');
    if (result!.proposal.action.type === 'evict') {
      expect(result!.proposal.action.workload).toBe('gains-host-35b-local');
    }
  });

  it('returns null under normal pressure', () => {
    const window = new PressureWindow(3);
    for (let i = 0; i < 3; i++) window.push(NORMAL, WLS);
    expect(detectPressure(window, THRESHOLDS)).toBeNull();
  });

  it('returns null with only 2 consecutive HIGH ticks (not yet N=3)', () => {
    const window = new PressureWindow(3);
    window.push(NORMAL, WLS);
    window.push(HIGH, WLS);
    window.push(HIGH, WLS);
    expect(detectPressure(window, THRESHOLDS)).toBeNull();
  });

  it('tie-break: equal RSS → alphabetical name', () => {
    const window = new PressureWindow(3);
    const tied: WorkloadSnapshot[] = [
      { ...WLS[1]!, name: 'zzz', rss_mb: 8192 },
      { ...WLS[1]!, name: 'aaa', rss_mb: 8192 },
      { ...WLS[1]!, name: 'mmm', rss_mb: 8192 },
    ];
    for (let i = 0; i < 3; i++) window.push(HIGH, tied);
    const result = detectPressure(window, THRESHOLDS);
    expect(result).not.toBeNull();
    if (result!.proposal.action.type === 'evict') {
      expect(result!.proposal.action.workload).toBe('aaa');
    }
  });

  it('priority overrides RSS: lower-priority workload evicted first even if smaller', () => {
    const window = new PressureWindow(3);
    const mixed: WorkloadSnapshot[] = [
      { ...WLS[0]!, name: 'protected-large', rss_mb: 36864, priority: 90 },
      { ...WLS[1]!, name: 'sacrificial-small', rss_mb: 1024, priority: 10 },
    ];
    for (let i = 0; i < 3; i++) window.push(HIGH, mixed);
    const result = detectPressure(window, THRESHOLDS);
    expect(result).not.toBeNull();
    if (result!.proposal.action.type === 'evict') {
      expect(result!.proposal.action.workload).toBe('sacrificial-small');
    }
  });

  it('ignores unreachable workloads when picking eviction target', () => {
    const window = new PressureWindow(3);
    const mixed: WorkloadSnapshot[] = [
      { ...WLS[0]!, rss_mb: 100000, reachable: false },
      { ...WLS[1]!, rss_mb: 4096, reachable: true },
    ];
    for (let i = 0; i < 3; i++) window.push(HIGH, mixed);
    const result = detectPressure(window, THRESHOLDS);
    expect(result).not.toBeNull();
    if (result!.proposal.action.type === 'evict') {
      expect(result!.proposal.action.workload).toBe('granite-3b-local');
    }
  });
});
