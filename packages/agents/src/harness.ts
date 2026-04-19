import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '@llamactl/mcp';
import { buildNovaMcpServer, type PlannerToolDescriptor } from '@nova/mcp';
import type {
  Runbook,
  RunbookContext,
  RunbookResult,
  RunbookToolClient,
  ToolCallInput,
} from './types.js';
import { RUNBOOKS } from './runbooks/index.js';

export interface HarnessToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

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

export interface DefaultToolClientHandle {
  client: RunbookToolClient;
  /** Enumerate every tool mounted on the composite client (union of
   *  @llamactl/mcp + @nova/mcp). Returns an unsorted list with the
   *  name + description + inputSchema the MCP SDK surfaces. */
  listTools(): Promise<HarnessToolDescriptor[]>;
  /** Same shape but widened to PlannerToolDescriptor with a default
   *  safety tier applied per tool name — dangerous tools are tagged
   *  `mutation-destructive` so the planner allowlist can filter
   *  them; everything else falls back to `read`. Operators refine
   *  this via planner.yaml (future slice). */
  listPlannerTools(): Promise<PlannerToolDescriptor[]>;
  dispose(): Promise<void>;
}

/** Heuristic safety tier for a tool name. Keep conservative — we'd
 *  rather an operator explicitly bump a read tool to mutation than
 *  have a destructive tool leak into the planner allowlist. */
function inferTier(name: string): PlannerToolDescriptor['tier'] {
  // Clearly-destructive tier — name must match exactly or have one
  // of these verbs as the final segment.
  if (/\.(uninstall|deregister|delete|remove)$/.test(name)) {
    return 'mutation-destructive';
  }
  // Mutation verbs. Rest of the surface is treated as read even if
  // it writes (e.g. `catalog.promote` which edits a TSV) — the
  // planner's dry-run cascade catches those.
  if (/\.(install|promote|start|stop|sync|apply|kick|rotate)/.test(name)) {
    return 'mutation-dry-run-safe';
  }
  return 'read';
}

/**
 * Boot a composite MCP client over @llamactl/mcp + @nova/mcp (both
 * in-process via InMemoryTransport) and route `callTool` by
 * tool-name prefix. Exposed so other CLI entrypoints (cost-guardian
 * tick, `llamactl plan run`) can reuse the harness without running a
 * full runbook.
 */
export async function createDefaultToolClient(): Promise<DefaultToolClientHandle> {
  return defaultToolClient();
}

async function defaultToolClient(): Promise<DefaultToolClientHandle> {
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
  async function listTools(): Promise<HarnessToolDescriptor[]> {
    const [lTools, nTools] = await Promise.all([
      llamactl.client.listTools(),
      nova.client.listTools(),
    ]);
    const out: HarnessToolDescriptor[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const t of (lTools as { tools: Array<any> }).tools) {
      out.push({
        name: t.name,
        description: t.description ?? '',
        inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
      });
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const t of (nTools as { tools: Array<any> }).tools) {
      out.push({
        name: t.name,
        description: t.description ?? '',
        inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
      });
    }
    return out;
  }
  async function listPlannerTools(): Promise<PlannerToolDescriptor[]> {
    const raw = await listTools();
    return raw.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      tier: inferTier(t.name),
    }));
  }
  const dispose = async (): Promise<void> => {
    await llamactl.close();
    await nova.close();
  };
  return { client, listTools, listPlannerTools, dispose };
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
    dispose = async () => built.dispose();
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
