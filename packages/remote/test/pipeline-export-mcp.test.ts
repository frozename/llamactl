import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { router } from '../src/router.js';

/**
 * K.6 — `pipelineExportMcp` writes a JSON stub to the configured
 * pipelines dir. Scopes the write under a tempdir via
 * LLAMACTL_MCP_PIPELINES_DIR so the suite never touches
 * ~/.llamactl/mcp/pipelines/.
 */
let tmp = '';
const originalEnv = { ...process.env };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'llamactl-pipeline-export-'));
  Object.assign(process.env, { LLAMACTL_MCP_PIPELINES_DIR: tmp });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
});

describe('pipelineExportMcp', () => {
  test('writes a PipelineTool stub with a slugged basename', async () => {
    const caller = router.createCaller({});
    const result = await caller.pipelineExportMcp({
      name: 'Summarize & Review',
      description: 'two-stage pipeline for editorial workflows',
      stages: [
        { node: 'local', model: 'gemma-4-e4b', systemPrompt: '', capabilities: [] },
        {
          node: 'sirius-primary',
          model: 'claude-opus-4',
          systemPrompt: 'You are an editor.',
          capabilities: ['reasoning'],
        },
      ],
      overwrite: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slug).toBe('summarize-review');
    expect(result.toolName).toBe('llamactl.pipeline.summarize-review');
    expect(result.stageCount).toBe(2);
    expect(result.path).toBe(join(tmp, 'summarize-review.json'));
    expect(existsSync(result.path)).toBe(true);

    const contents = JSON.parse(readFileSync(result.path, 'utf8')) as {
      apiVersion: string;
      kind: string;
      name: string;
      title: string;
      description: string;
      inputSchema: { properties: { input: { type: string } }; required: string[] };
      stages: Array<{ node: string; model: string }>;
    };
    expect(contents.apiVersion).toBe('llamactl/v1');
    expect(contents.kind).toBe('PipelineTool');
    expect(contents.name).toBe('llamactl.pipeline.summarize-review');
    expect(contents.title).toBe('Summarize & Review');
    expect(contents.inputSchema.required).toEqual(['input']);
    expect(contents.stages).toHaveLength(2);
    expect(contents.stages[1]!.model).toBe('claude-opus-4');
  });

  test('refuses to clobber by default; overwrite:true succeeds', async () => {
    const caller = router.createCaller({});
    const first = await caller.pipelineExportMcp({
      name: 'draft-cascade',
      stages: [{ node: 'local', model: 'm1', systemPrompt: '', capabilities: [] }],
      overwrite: false,
    });
    expect(first.ok).toBe(true);

    const second = await caller.pipelineExportMcp({
      name: 'draft-cascade',
      stages: [{ node: 'local', model: 'm1', systemPrompt: '', capabilities: [] }],
      overwrite: false,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('exists');

    const third = await caller.pipelineExportMcp({
      name: 'draft-cascade',
      stages: [
        { node: 'local', model: 'm1', systemPrompt: '', capabilities: [] },
        { node: 'gpu1', model: 'm2', systemPrompt: '', capabilities: [] },
      ],
      overwrite: true,
    });
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    const contents = JSON.parse(readFileSync(third.path, 'utf8')) as {
      stages: unknown[];
    };
    expect(contents.stages).toHaveLength(2);
  });

  test('rejects empty pipelines', async () => {
    const caller = router.createCaller({});
    await expect(
      caller.pipelineExportMcp({
        name: 'empty',
        stages: [],
        overwrite: false,
      }),
    ).rejects.toThrow(/at least one stage/i);
  });
});
