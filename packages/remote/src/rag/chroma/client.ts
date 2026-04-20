import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { RagBinding } from '../../config/schema.js';
import { RagError } from '../errors.js';

/**
 * Stdio connection to a chroma-mcp subprocess. The binding's
 * `endpoint` field carries the full command line (e.g.
 * `chroma-mcp run --persist-directory /data/chroma`); the first token
 * is the executable and the remainder — merged with `binding.extraArgs`
 * — are the arguments. Subprocess stderr inherits the parent's so
 * chroma-mcp's diagnostics are visible to the operator without us
 * re-implementing log piping.
 *
 * Exposed as `ChromaMcpClient` rather than the SDK `Client` directly so
 * the adapter can be unit-tested against a minimal mock that doesn't
 * need to satisfy the full Client surface. `callTool` mirrors the one
 * SDK method the adapter actually uses; the adapter never talks to
 * `listTools` / `notifications` / etc. and the narrower surface keeps
 * the test seam honest.
 */

const CLIENT_NAME = 'llamactl-rag-chroma';
const CLIENT_VERSION = '0.1.0';

export interface ChromaToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
  [key: string]: unknown;
}

export interface ChromaMcpClient {
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<ChromaToolResult>;
  close(): Promise<void>;
}

export interface ChromaMcpConnection {
  client: ChromaMcpClient;
  close(): Promise<void>;
}

function parseEndpoint(binding: RagBinding): { command: string; args: string[] } {
  const trimmed = binding.endpoint.trim();
  if (trimmed.length === 0) {
    throw new RagError(
      'connect-failed',
      'chroma RAG binding has an empty endpoint; expected the chroma-mcp command line',
    );
  }
  // Minimal tokenizer — split on runs of whitespace. chroma-mcp command
  // lines today don't need shell-quoted arguments; if that changes,
  // callers can use `binding.extraArgs` for anything with spaces.
  const tokens = trimmed.split(/\s+/);
  const command = tokens[0]!;
  const endpointArgs = tokens.slice(1);
  return { command, args: [...endpointArgs, ...binding.extraArgs] };
}

export async function connectChromaMcp(
  binding: RagBinding,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ChromaMcpConnection> {
  const { command, args } = parseEndpoint(binding);
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') childEnv[k] = v;
  }
  const transport = new StdioClientTransport({
    command,
    args,
    env: childEnv,
    stderr: 'inherit',
  });
  const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION });
  try {
    await client.connect(transport);
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    throw new RagError(
      'connect-failed',
      `failed to connect to chroma-mcp via "${command}": ${msg}`,
      cause,
    );
  }
  return {
    client: client as unknown as ChromaMcpClient,
    close: () => client.close(),
  };
}
