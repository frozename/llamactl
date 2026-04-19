import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { router } from '@llamactl/remote';
import { toTextContent } from '@nova/mcp-shared';

/**
 * M.1 — pipeline-tool pickup. Operators author pipelines in the
 * Electron app (K.6) and save them as
 * `~/.llamactl/mcp/pipelines/<slug>.json` via
 * `trpc.pipelineExportMcp`. At boot this module scans that directory
 * and registers each file as an MCP tool, so an external MCP client
 * can invoke the pipeline by name without the app being open.
 *
 * Override the scan path via `LLAMACTL_MCP_PIPELINES_DIR` (tests use
 * this to stay out of the real home directory).
 */

const PipelineToolSchema = z.object({
  apiVersion: z.literal('llamactl/v1'),
  kind: z.literal('PipelineTool'),
  name: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(''),
  inputSchema: z
    .object({
      type: z.literal('object'),
      properties: z.record(z.string(), z.unknown()).default({}),
      required: z.array(z.string()).default([]),
    })
    .passthrough(),
  stages: z
    .array(
      z.object({
        node: z.string().min(1),
        model: z.string().min(1),
        systemPrompt: z.string().default(''),
        capabilities: z.array(z.string()).default([]),
      }),
    )
    .min(1),
});
export type PipelineTool = z.infer<typeof PipelineToolSchema>;

function defaultPipelinesDir(): string {
  return (
    process.env.LLAMACTL_MCP_PIPELINES_DIR ??
    join(homedir(), '.llamactl', 'mcp', 'pipelines')
  );
}

/**
 * Read every `*.json` under `pipelinesDir`, parse it against
 * `PipelineToolSchema`, and return the successes. Malformed files are
 * skipped silently — a stray backup or partial write shouldn't crash
 * the server boot. Callers log warnings through the optional hook.
 */
export function discoverPipelineTools(opts?: {
  pipelinesDir?: string;
  onWarn?: (message: string) => void;
}): PipelineTool[] {
  const dir = opts?.pipelinesDir ?? defaultPipelinesDir();
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const out: PipelineTool[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const path = join(dir, file);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      opts?.onWarn?.(
        `pipeline-tool: skipped ${path} — invalid JSON: ${(err as Error).message}`,
      );
      continue;
    }
    const parsed = PipelineToolSchema.safeParse(raw);
    if (!parsed.success) {
      opts?.onWarn?.(
        `pipeline-tool: skipped ${path} — ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      );
      continue;
    }
    out.push(parsed.data);
  }
  return out;
}

interface ChatMessage {
  role: string;
  content: string;
}

/**
 * Run a pipeline's stages sequentially, feeding the previous stage's
 * final assistant message to the next as user content. Uses the tRPC
 * router's `chatComplete` mutation via `createCaller` — same dispatch
 * path the Electron Pipelines module uses, but without streaming.
 */
async function runPipeline(
  tool: PipelineTool,
  input: string,
): Promise<{ stages: Array<{ stage: number; output: string }>; finalOutput: string }> {
  const caller = router.createCaller({});
  let pending = input;
  const stages: Array<{ stage: number; output: string }> = [];

  for (let i = 0; i < tool.stages.length; i++) {
    const stage = tool.stages[i];
    if (!stage) continue;
    const messages: ChatMessage[] = [];
    if (stage.systemPrompt.trim().length > 0) {
      messages.push({ role: 'system', content: stage.systemPrompt });
    }
    messages.push({ role: 'user', content: pending });
    const request: {
      model: string;
      messages: ChatMessage[];
      providerOptions?: { capabilities: string[] };
    } = {
      model: stage.model,
      messages,
    };
    if (stage.capabilities.length > 0) {
      request.providerOptions = { capabilities: stage.capabilities };
    }

    const response = (await caller.chatComplete({
      node: stage.node,
      request,
    })) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const finalContent = response.choices?.[0]?.message?.content ?? '';
    stages.push({ stage: i, output: finalContent });
    pending = finalContent;
  }
  return { stages, finalOutput: pending };
}

/**
 * Register every PipelineTool found on disk as an MCP tool on the
 * given server. Returns the list of registered tool names for
 * telemetry/logging.
 */
export function registerPipelineTools(
  server: McpServer,
  opts?: {
    pipelinesDir?: string;
    onWarn?: (message: string) => void;
  },
): string[] {
  const tools = discoverPipelineTools(opts);
  const registered: string[] = [];
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description:
          tool.description ||
          `Multi-stage pipeline with ${tool.stages.length} stage${tool.stages.length === 1 ? '' : 's'}.`,
        inputSchema: {
          input: z.string().min(1).describe('Initial user content.'),
        },
      },
      async ({ input }) => {
        try {
          const result = await runPipeline(tool, input);
          return toTextContent({
            ok: true,
            finalOutput: result.finalOutput,
            stages: result.stages,
          });
        } catch (err) {
          return toTextContent({
            ok: false,
            error: (err as Error).message,
          });
        }
      },
    );
    registered.push(tool.name);
  }
  return registered;
}
