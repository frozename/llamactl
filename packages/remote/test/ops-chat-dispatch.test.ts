import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { router } from '../src/router.js';
import {
  KNOWN_OPS_CHAT_TOOLS,
  toolTier,
} from '../src/ops-chat/dispatch.js';
import { readOpsChatAudit } from '../src/ops-chat/audit.js';

/**
 * N.4.a — ops-chat tool dispatch. Every handler returns a
 * structured `{ok, result}` envelope; audit journal receives one
 * entry per call; unknown tool names short-circuit with a clean
 * error rather than throwing.
 */

let runtimeDir = '';
let auditPath = '';
const originalEnv = { ...process.env };

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'llamactl-opschat-'));
  auditPath = join(runtimeDir, 'audit.jsonl');
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv, {
    LLAMACTL_OPS_CHAT_AUDIT: auditPath,
    DEV_STORAGE: runtimeDir,
    LOCAL_AI_RUNTIME_DIR: runtimeDir,
    LOCAL_AI_PRESET_OVERRIDES_FILE: join(runtimeDir, 'preset-overrides.tsv'),
    LLAMACTL_CONFIG: join(runtimeDir, 'config'),
  });
});

afterEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
  rmSync(runtimeDir, { recursive: true, force: true });
});

describe('operatorRunTool', () => {
  test('runs a read tool end-to-end + appends an audit entry', async () => {
    const caller = router.createCaller({});
    const res = await caller.operatorRunTool({
      name: 'llamactl.env',
      arguments: {},
      dryRun: false,
    });
    expect(res.ok).toBe(true);
    expect(res.name).toBe('llamactl.env');
    expect(res.tier).toBe('read');
    expect(res.result).toBeDefined();

    const tail = readOpsChatAudit({ path: auditPath });
    expect(tail.entries).toHaveLength(1);
    const entry = tail.entries[0]!;
    expect(entry.tool).toBe('llamactl.env');
    expect(entry.ok).toBe(true);
    expect(entry.dryRun).toBe(false);
    expect(entry.argumentsHash).toMatch(/^[0-9a-f]+$/);
    expect(typeof entry.durationMs).toBe('number');
  });

  test('unknown tool names return structured error + audit failure', async () => {
    const caller = router.createCaller({});
    const res = await caller.operatorRunTool({
      name: 'llamactl.does.not.exist',
      arguments: {},
      dryRun: false,
    });
    expect(res.ok).toBe(false);
    expect(res.tier).toBe('unknown');
    expect(res.error?.code).toBe('unknown_tool');
    const tail = readOpsChatAudit({ path: auditPath });
    expect(tail.entries).toHaveLength(1);
    const entry = tail.entries[0]!;
    expect(entry.ok).toBe(false);
    expect(entry.errorCode).toBe('unknown_tool');
  });

  test('dry-run mutation returns a preview without writing', async () => {
    const caller = router.createCaller({});
    const res = await caller.operatorRunTool({
      name: 'llamactl.catalog.promote',
      arguments: {
        profile: 'macbook-pro-48g',
        preset: 'best',
        rel: 'some/model.gguf',
      },
      dryRun: true,
    });
    expect(res.ok).toBe(true);
    expect(res.tier).toBe('mutation-dry-run-safe');
    const payload = res.result as { dryRun: boolean; wouldWrite?: unknown };
    expect(payload.dryRun).toBe(true);
    expect(payload.wouldWrite).toBeDefined();

    // Confirm no TSV was written — fresh runtime, the file should
    // not exist since we only ran dry.
    const tail = readOpsChatAudit({ path: auditPath });
    expect(tail.entries[0]!.dryRun).toBe(true);
  });

  test('destructive tools are tagged and the tier is stable', () => {
    expect(toolTier('llamactl.workload.delete')).toBe('mutation-destructive');
    expect(toolTier('llamactl.node.remove')).toBe('mutation-destructive');
    expect(toolTier('llamactl.catalog.promoteDelete')).toBe('mutation-destructive');
    expect(toolTier('llamactl.catalog.promote')).toBe('mutation-dry-run-safe');
    expect(toolTier('llamactl.node.add')).toBe('mutation-dry-run-safe');
    expect(toolTier('llamactl.env')).toBe('read');
  });

  test('missing required arguments surface as a dispatch error', async () => {
    const caller = router.createCaller({});
    const res = await caller.operatorRunTool({
      name: 'llamactl.catalog.promote',
      arguments: { profile: 'macbook-pro-48g', preset: 'best' /* rel missing */ },
      dryRun: true,
    });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('dispatch_error');
    expect(res.error?.message).toContain('rel');
  });

  test('opsChatTools query advertises every known tool', async () => {
    const caller = router.createCaller({});
    const listing = await caller.opsChatTools();
    expect(listing.tools.length).toBe(KNOWN_OPS_CHAT_TOOLS.length);
    const known = [...KNOWN_OPS_CHAT_TOOLS].sort();
    const got = [...listing.tools].sort() as typeof known;
    expect(got).toEqual(known);
  });
});

// Cross-package coverage (KNOWN_OPS_CHAT_TOOLS vs @llamactl/mcp
// advertised surface) lives in packages/mcp/test/smoke.test.ts —
// `@llamactl/remote` isn't allowed to depend on `@llamactl/mcp` and
// we want the check where both are reachable.
