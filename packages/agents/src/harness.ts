import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '@llamactl/mcp';
import { buildNovaMcpServer } from '@nova/mcp';
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
  /** Override the tool client. Defaults to booting both @llamactl/mcp
   *  and @nova/mcp in-process and routing calls by tool-name prefix
   *  — `nova.*` goes to nova-mcp, everything else to llamactl-mcp.
   *  Same MCP surface a real client would see, without any
   *  subprocess. */
  toolClient?: RunbookToolClient;
}

interface MountedServer {
  client: Client;
  close: () => Promise<void>;
}

async function mountInProcess(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server: any,
  clientName: string,
): Promise<MountedServer> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: clientName, version: '0.0.0' });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      try { await client.close(); } catch { /* ignore */ }
      try { await server.close(); } catch { /* ignore */ }
    },
  };
}

/**
 * Boot a composite MCP client over @llamactl/mcp + @nova/mcp (both
 * in-process via InMemoryTransport) and route `callTool` by
 * tool-name prefix. Exposed so other CLI entrypoints (cost-guardian
 * tick, the future planner executor) can reuse the harness without
 * running a full runbook.
 */
export async function createDefaultToolClient(): Promise<{ client: RunbookToolClient; dispose: () => Promise<void> }> {
  return defaultToolClient();
}

async function defaultToolClient(): Promise<{ client: RunbookToolClient; dispose: () => Promise<void> }> {
  const llamactl = await mountInProcess(
    buildMcpServer({ name: 'llamactl-runbook-harness' }),
    'llamactl-runbook-harness',
  );
  const nova = await mountInProcess(
    buildNovaMcpServer({ name: 'nova-runbook-harness' }),
    'nova-runbook-harness',
  );
  const client: RunbookToolClient = {
    async callTool(input: ToolCallInput) {
      const target = input.name.startsWith('nova.') ? nova.client : llamactl.client;
      return target.callTool({ name: input.name, arguments: input.arguments });
    },
  };
  const dispose = async (): Promise<void> => {
    await llamactl.close();
    await nova.close();
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
