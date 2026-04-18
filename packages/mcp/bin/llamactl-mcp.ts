#!/usr/bin/env bun
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildMcpServer } from '../src/server.js';

/**
 * Stdio MCP server entry. Claude Code, Claude Desktop and similar
 * clients spawn this as a subprocess and speak JSON-RPC over
 * stdin/stdout. Nothing else may write to stdout — diagnostics go to
 * stderr.
 */

async function main(): Promise<void> {
  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('llamactl-mcp: ready (stdio)\n');
}

main().catch((err) => {
  process.stderr.write(`llamactl-mcp: fatal ${(err as Error).message}\n`);
  process.exit(1);
});
