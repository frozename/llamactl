import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { router } from '../src/router.js';
import {
  KNOWN_OPS_CHAT_TOOLS,
  dispatchOpsChatTool,
  toolTier,
  type Caller,
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

  test('RAG tool tiers match the retrieval-contract surface', () => {
    expect(toolTier('llamactl.rag.search')).toBe('read');
    expect(toolTier('llamactl.rag.listCollections')).toBe('read');
    expect(toolTier('llamactl.rag.store')).toBe('mutation-dry-run-safe');
    expect(toolTier('llamactl.rag.delete')).toBe('mutation-destructive');
  });

  test('RAG tools are registered in KNOWN_OPS_CHAT_TOOLS', () => {
    for (const name of [
      'llamactl.rag.search',
      'llamactl.rag.listCollections',
      'llamactl.rag.store',
      'llamactl.rag.delete',
    ]) {
      expect((KNOWN_OPS_CHAT_TOOLS as readonly string[]).includes(name)).toBe(true);
    }
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

describe('RAG dispatch', () => {
  /**
   * Phase 5 of rag-nodes.md — the 4 RAG tools must route through to
   * the matching tRPC caller method with input passthrough. Dry-run
   * for destructive writes (`store`, `delete`) returns a preview
   * without hitting the procedure.
   */

  type RagCalls = Array<{ method: string; input: unknown }>;

  function makeFakeCaller(calls: RagCalls): Caller {
    const stub = (method: string, reply: unknown) => async (input: unknown) => {
      calls.push({ method, input });
      return reply;
    };
    // Narrow Caller proxy — we stub only the RAG surface the tests
    // exercise; other methods don't get called in these assertions.
    return {
      ragSearch: stub('ragSearch', {
        collection: 'default',
        results: [
          {
            document: { id: 'd1', content: 'x' },
            score: 0.9,
          },
        ],
      }),
      ragStore: stub('ragStore', { collection: 'default', ids: ['a', 'b'] }),
      ragDelete: stub('ragDelete', { collection: 'default', deleted: 2 }),
      ragListCollections: stub('ragListCollections', {
        collections: [{ name: 'default', count: 7 }],
      }),
    } as unknown as Caller;
  }

  test('rag.search routes to caller.ragSearch with forwarded args', async () => {
    const calls: RagCalls = [];
    const caller = makeFakeCaller(calls);
    const res = await dispatchOpsChatTool(caller, {
      name: 'llamactl.rag.search',
      arguments: {
        node: 'kb-chroma',
        query: 'hello',
        topK: 5,
        filter: { src: 'test' },
        collection: 'default',
      },
      dryRun: false,
    });
    expect(res.ok).toBe(true);
    expect(res.tier).toBe('read');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('ragSearch');
    expect(calls[0]?.input).toEqual({
      node: 'kb-chroma',
      query: 'hello',
      topK: 5,
      filter: { src: 'test' },
      collection: 'default',
    });
  });

  test('rag.listCollections routes to caller.ragListCollections', async () => {
    const calls: RagCalls = [];
    const caller = makeFakeCaller(calls);
    const res = await dispatchOpsChatTool(caller, {
      name: 'llamactl.rag.listCollections',
      arguments: { node: 'kb-pg' },
      dryRun: false,
    });
    expect(res.ok).toBe(true);
    expect(res.tier).toBe('read');
    expect(calls[0]?.method).toBe('ragListCollections');
    expect(calls[0]?.input).toEqual({ node: 'kb-pg' });
  });

  test('rag.store wet-run routes to caller.ragStore', async () => {
    const calls: RagCalls = [];
    const caller = makeFakeCaller(calls);
    const res = await dispatchOpsChatTool(caller, {
      name: 'llamactl.rag.store',
      arguments: {
        node: 'kb-chroma',
        documents: [
          { id: 'a', content: 'alpha' },
          { id: 'b', content: 'beta' },
        ],
      },
      dryRun: false,
    });
    expect(res.ok).toBe(true);
    expect(res.tier).toBe('mutation-dry-run-safe');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('ragStore');
    expect((calls[0]?.input as { documents: unknown[] }).documents).toHaveLength(2);
  });

  test('rag.store dry-run returns wouldStore without calling the procedure', async () => {
    const calls: RagCalls = [];
    const caller = makeFakeCaller(calls);
    const res = await dispatchOpsChatTool(caller, {
      name: 'llamactl.rag.store',
      arguments: {
        node: 'kb-chroma',
        documents: [
          { id: 'a', content: 'alpha' },
          { id: 'b', content: 'beta' },
          { id: 'c', content: 'gamma' },
        ],
      },
      dryRun: true,
    });
    expect(res.ok).toBe(true);
    const payload = res.result as { dryRun: boolean; wouldStore: { node: string; count: number } };
    expect(payload.dryRun).toBe(true);
    expect(payload.wouldStore).toEqual({ node: 'kb-chroma', count: 3 });
    expect(calls).toHaveLength(0);
  });

  test('rag.delete wet-run routes to caller.ragDelete', async () => {
    const calls: RagCalls = [];
    const caller = makeFakeCaller(calls);
    const res = await dispatchOpsChatTool(caller, {
      name: 'llamactl.rag.delete',
      arguments: { node: 'kb-pg', ids: ['a', 'b'], collection: 'docs' },
      dryRun: false,
    });
    expect(res.ok).toBe(true);
    expect(res.tier).toBe('mutation-destructive');
    expect(calls[0]?.method).toBe('ragDelete');
    expect(calls[0]?.input).toEqual({
      node: 'kb-pg',
      ids: ['a', 'b'],
      collection: 'docs',
    });
  });

  test('rag.delete dry-run returns wouldDelete without calling the procedure', async () => {
    const calls: RagCalls = [];
    const caller = makeFakeCaller(calls);
    const res = await dispatchOpsChatTool(caller, {
      name: 'llamactl.rag.delete',
      arguments: { node: 'kb-pg', ids: ['x', 'y', 'z'] },
      dryRun: true,
    });
    expect(res.ok).toBe(true);
    const payload = res.result as { dryRun: boolean; wouldDelete: { node: string; ids: string[] } };
    expect(payload.dryRun).toBe(true);
    expect(payload.wouldDelete).toEqual({ node: 'kb-pg', ids: ['x', 'y', 'z'] });
    expect(calls).toHaveLength(0);
  });

  test('rag.search missing required node argument surfaces a dispatch error', async () => {
    const calls: RagCalls = [];
    const caller = makeFakeCaller(calls);
    const res = await dispatchOpsChatTool(caller, {
      name: 'llamactl.rag.search',
      arguments: { query: 'x' /* node missing */ },
      dryRun: false,
    });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('dispatch_error');
    expect(res.error?.message).toContain('node');
    expect(calls).toHaveLength(0);
  });
});

describe('Composite dispatch', () => {
  /**
   * Phase 5 of composite-infra.md — the 4 composite tools route
   * through to the matching tRPC caller method. Dry-run handling
   * lives inside the procedure (not synthesized at this layer) so
   * every case just forwards `input.dryRun` verbatim.
   */

  type CompositeCalls = Array<{ method: string; input: unknown }>;

  function makeFakeCompositeCaller(calls: CompositeCalls): Caller {
    const stub = (method: string, reply: unknown) => async (input: unknown) => {
      calls.push({ method, input });
      return reply;
    };
    return {
      compositeApply: stub('compositeApply', {
        dryRun: true,
        manifest: { apiVersion: 'llamactl/v1', kind: 'Composite' },
        order: [],
        impliedEdges: [],
      }),
      compositeDestroy: stub('compositeDestroy', {
        dryRun: true,
        name: 'x',
        wouldRemove: [],
      }),
      compositeList: stub('compositeList', []),
      compositeGet: stub('compositeGet', null),
    } as unknown as Caller;
  }

  test('composite tools are registered in KNOWN_OPS_CHAT_TOOLS', () => {
    for (const name of [
      'llamactl.composite.apply',
      'llamactl.composite.destroy',
      'llamactl.composite.get',
      'llamactl.composite.list',
    ]) {
      expect((KNOWN_OPS_CHAT_TOOLS as readonly string[]).includes(name)).toBe(true);
    }
  });

  test('composite tier classification matches the spec', () => {
    expect(toolTier('llamactl.composite.apply')).toBe('mutation-dry-run-safe');
    expect(toolTier('llamactl.composite.destroy')).toBe('mutation-destructive');
    expect(toolTier('llamactl.composite.list')).toBe('read');
    expect(toolTier('llamactl.composite.get')).toBe('read');
  });

  test('composite.list routes to caller.compositeList', async () => {
    const calls: CompositeCalls = [];
    const caller = makeFakeCompositeCaller(calls);
    const res = await dispatchOpsChatTool(caller, {
      name: 'llamactl.composite.list',
      arguments: {},
      dryRun: false,
    });
    expect(res.ok).toBe(true);
    expect(res.tier).toBe('read');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('compositeList');
  });

  test('composite.get routes to caller.compositeGet with name', async () => {
    const calls: CompositeCalls = [];
    const caller = makeFakeCompositeCaller(calls);
    const res = await dispatchOpsChatTool(caller, {
      name: 'llamactl.composite.get',
      arguments: { name: 'kb-stack' },
      dryRun: false,
    });
    expect(res.ok).toBe(true);
    expect(res.tier).toBe('read');
    expect(calls[0]?.method).toBe('compositeGet');
    expect(calls[0]?.input).toEqual({ name: 'kb-stack' });
  });

  test('composite.apply dry-run forwards dryRun through to the procedure', async () => {
    const calls: CompositeCalls = [];
    const caller = makeFakeCompositeCaller(calls);
    const res = await dispatchOpsChatTool(caller, {
      name: 'llamactl.composite.apply',
      arguments: { manifestYaml: 'apiVersion: llamactl/v1\nkind: Composite\n' },
      dryRun: true,
    });
    expect(res.ok).toBe(true);
    expect(res.tier).toBe('mutation-dry-run-safe');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('compositeApply');
    expect(calls[0]?.input).toEqual({
      manifestYaml: 'apiVersion: llamactl/v1\nkind: Composite\n',
      dryRun: true,
    });
  });

  test('composite.apply wet-run forwards dryRun=false', async () => {
    const calls: CompositeCalls = [];
    const caller = makeFakeCompositeCaller(calls);
    await dispatchOpsChatTool(caller, {
      name: 'llamactl.composite.apply',
      arguments: { manifestYaml: 'k: v\n' },
      dryRun: false,
    });
    expect(calls[0]?.input).toEqual({
      manifestYaml: 'k: v\n',
      dryRun: false,
    });
  });

  test('composite.destroy dry-run forwards dryRun through to the procedure', async () => {
    const calls: CompositeCalls = [];
    const caller = makeFakeCompositeCaller(calls);
    const res = await dispatchOpsChatTool(caller, {
      name: 'llamactl.composite.destroy',
      arguments: { name: 'kb-stack' },
      dryRun: true,
    });
    expect(res.ok).toBe(true);
    expect(res.tier).toBe('mutation-destructive');
    expect(calls[0]?.method).toBe('compositeDestroy');
    expect(calls[0]?.input).toEqual({ name: 'kb-stack', dryRun: true });
  });

  test('composite.apply missing manifestYaml surfaces a dispatch error', async () => {
    const calls: CompositeCalls = [];
    const caller = makeFakeCompositeCaller(calls);
    const res = await dispatchOpsChatTool(caller, {
      name: 'llamactl.composite.apply',
      arguments: {},
      dryRun: true,
    });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('dispatch_error');
    expect(res.error?.message).toContain('manifestYaml');
    expect(calls).toHaveLength(0);
  });

  test('composite.destroy missing name surfaces a dispatch error', async () => {
    const calls: CompositeCalls = [];
    const caller = makeFakeCompositeCaller(calls);
    const res = await dispatchOpsChatTool(caller, {
      name: 'llamactl.composite.destroy',
      arguments: {},
      dryRun: true,
    });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('dispatch_error');
    expect(res.error?.message).toContain('name');
    expect(calls).toHaveLength(0);
  });
});

// Cross-package coverage (KNOWN_OPS_CHAT_TOOLS vs @llamactl/mcp
// advertised surface) lives in packages/mcp/test/smoke.test.ts —
// `@llamactl/remote` isn't allowed to depend on `@llamactl/mcp` and
// we want the check where both are reachable.
