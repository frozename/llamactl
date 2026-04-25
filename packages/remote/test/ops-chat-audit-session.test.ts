// packages/remote/test/ops-chat-audit-session.test.ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendOpsChatAudit,
  readOpsChatAudit,
} from '../src/ops-chat/audit';

describe('audit sessionId', () => {
  let tmp: string;
  let path: string;
  let prev: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ops-audit-'));
    path = join(tmp, 'audit.jsonl');
    prev = process.env.LLAMACTL_OPS_CHAT_AUDIT;
    process.env.LLAMACTL_OPS_CHAT_AUDIT = path;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.LLAMACTL_OPS_CHAT_AUDIT;
    else process.env.LLAMACTL_OPS_CHAT_AUDIT = prev;
    rmSync(tmp, { recursive: true, force: true });
  });

  test('sessionId persists round-trip', () => {
    appendOpsChatAudit({
      ts: '2026-04-25T00:00:00.000Z',
      tool: 't',
      dryRun: false,
      argumentsHash: 'abc',
      ok: true,
      durationMs: 1,
      sessionId: 'sess-99',
    });
    const { entries } = readOpsChatAudit({ path });
    expect(entries[0]!.sessionId).toBe('sess-99');
  });

  test('sessionId undefined when omitted', () => {
    appendOpsChatAudit({
      ts: '2026-04-25T00:00:00.000Z',
      tool: 't',
      dryRun: false,
      argumentsHash: 'abc',
      ok: true,
      durationMs: 1,
    });
    const { entries } = readOpsChatAudit({ path });
    expect(entries[0]!.sessionId).toBeUndefined();
  });
});
