import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '@llamactl/mcp';
import type {
  Runbook,
  RunbookContext,
  RunbookResult,
  RunbookToolClient,
  ToolCallInput,
} from './types.js';
import { RUNBOOKS } from './runbooks/index.js';

export interface RunRunbookOptions {
  dryRun?: boolean;
  log?: (message: string) => void;
  /** Override the tool client. Defaults to building @llamactl/mcp
   *  in-process and wiring it over InMemoryTransport — the same
   *  MCP surface a real client would see, without any subprocess. */
  toolClient?: RunbookToolClient;
}

async function defaultToolClient(): Promise<{ client: RunbookToolClient; dispose: () => Promise<void> }> {
  const server = buildMcpServer({ name: 'llamactl-runbook-harness' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcpClient = new Client({ name: 'llamactl-runbook-harness', version: '0.0.0' });
  await mcpClient.connect(clientTransport);
  const client: RunbookToolClient = {
    async callTool(input: ToolCallInput) {
      return mcpClient.callTool({ name: input.name, arguments: input.arguments });
    },
  };
  const dispose = async (): Promise<void> => {
    try { await mcpClient.close(); } catch { /* ignore */ }
    try { await server.close(); } catch { /* ignore */ }
  };
  return { client, dispose };
}

export async function runRunbook<Params>(
  name: string,
  params: Params,
  opts: RunRunbookOptions = {},
): Promise<RunbookResult> {
  const runbook = RUNBOOKS[name] as Runbook<Params> | undefined;
  if (!runbook) {
    throw new Error(`unknown runbook: ${name}`);
  }
  if (runbook.paramsSchema) {
    const parsed = runbook.paramsSchema.safeParse(params);
    if (!parsed.success) {
      throw new Error(`runbook ${name}: invalid params — ${parsed.error.message}`);
    }
    params = parsed.data as Params;
  }

  const log = opts.log ?? (() => {});
  const dryRun = opts.dryRun ?? false;

  let client = opts.toolClient;
  let dispose: (() => Promise<void>) | null = null;
  if (!client) {
    const built = await defaultToolClient();
    client = built.client;
    dispose = built.dispose;
  }

  const ctx: RunbookContext = { tools: client, dryRun, log };

  try {
    return await runbook.execute(ctx, params);
  } catch (err) {
    return {
      ok: false,
      steps: [],
      error: (err as Error).message,
    };
  } finally {
    if (dispose) await dispose();
  }
}
