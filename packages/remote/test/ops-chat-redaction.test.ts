import { describe, expect, test } from 'bun:test';
import { redactResult } from '../src/ops-chat/sessions/redaction';

describe('redactResult', () => {
  test('llamactl.secrets.read → omitted, value undefined', () => {
    const r = redactResult('llamactl.secrets.read', { token: 'abc' });
    expect(r.value).toBeUndefined();
    expect(r.redacted).toBe('omitted');
  });

  test('llamactl.fs.read → truncates body > 4096 chars', () => {
    const big = 'x'.repeat(10_000);
    const r = redactResult('llamactl.fs.read', { content: big });
    expect(r.redacted).toBe('truncated');
    expect(JSON.stringify(r.value).length).toBeLessThanOrEqual(4096 + 64);
  });

  test('llamactl.fs.read → small body passes through', () => {
    const r = redactResult('llamactl.fs.read', { content: 'small' });
    expect(r.redacted).toBeUndefined();
    expect(r.value).toEqual({ content: 'small' });
  });

  test('default tool → full passthrough', () => {
    const r = redactResult('llamactl.workload.list', { workloads: [{ id: 'a' }] });
    expect(r.redacted).toBeUndefined();
    expect(r.value).toEqual({ workloads: [{ id: 'a' }] });
  });
});
