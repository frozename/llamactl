import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultOpsChatAuditPath } from '../src/ops-chat/paths.js';

/**
 * State-isolation fix — ops-chat audit path must honour `$DEV_STORAGE`
 * so hermetic `$LLAMACTL_TEST_PROFILE` audits (which re-root
 * `DEV_STORAGE` via `env.resolveEnv`) don't read/write the operator's
 * real `~/.llamactl/ops-chat/audit.jsonl`. Mirrors the cascade every
 * other llamactl data-path helper already implements.
 */

let tmp = '';
const originalEnv = { ...process.env };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'llamactl-opschat-paths-'));
  for (const k of Object.keys(process.env)) delete process.env[k];
});

afterEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
  rmSync(tmp, { recursive: true, force: true });
});

describe('defaultOpsChatAuditPath', () => {
  test('LLAMACTL_OPS_CHAT_AUDIT override wins over every cascade step', () => {
    const custom = join(tmp, 'custom-audit.jsonl');
    const env = {
      LLAMACTL_OPS_CHAT_AUDIT: custom,
      DEV_STORAGE: join(tmp, 'dev-storage'),
    } as NodeJS.ProcessEnv;
    expect(defaultOpsChatAuditPath(env)).toBe(custom);
  });

  test('DEV_STORAGE re-roots the audit dir when set', () => {
    const devStorage = join(tmp, 'dev-storage');
    const env = { DEV_STORAGE: devStorage } as NodeJS.ProcessEnv;
    expect(defaultOpsChatAuditPath(env)).toBe(
      join(devStorage, 'ops-chat', 'audit.jsonl'),
    );
  });

  test('falls back to homedir when neither override nor DEV_STORAGE set', () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(defaultOpsChatAuditPath(env)).toBe(
      join(homedir(), '.llamactl', 'ops-chat', 'audit.jsonl'),
    );
  });

  test('empty string DEV_STORAGE falls through to homedir', () => {
    const env = { DEV_STORAGE: '   ' } as NodeJS.ProcessEnv;
    expect(defaultOpsChatAuditPath(env)).toBe(
      join(homedir(), '.llamactl', 'ops-chat', 'audit.jsonl'),
    );
  });

  test('reads process.env by default', () => {
    const devStorage = join(tmp, 'dev-storage-proc');
    process.env.DEV_STORAGE = devStorage;
    expect(defaultOpsChatAuditPath()).toBe(
      join(devStorage, 'ops-chat', 'audit.jsonl'),
    );
  });
});
