import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  bench,
  catalog,
  env as envMod,
} from '@llamactl/core';
import { config as kubecfg, resolveNodeKind } from '@llamactl/remote';

/**
 * `@llamactl/mcp` — Model Context Protocol server exposing llamactl's
 * operator surface to MCP-speaking clients (Claude Code, Claude
 * Desktop, third-party harnesses). Each tool maps 1:1 to an existing
 * llamactl procedure so the server is a thin adapter, never a second
 * implementation of the logic.
 *
 * This module exports `buildMcpServer()` so both the stdio binary
 * (bin/llamactl-mcp.ts) and the test suite can construct a fresh
 * server without stringing together a process.
 *
 * Scope today (spike slice):
 *   * `llamactl.catalog.list`    — curated models on the control plane
 *   * `llamactl.node.ls`         — kubeconfig nodes + their kinds
 *   * `llamactl.bench.compare`   — bench table for ranking alternatives
 *
 * Deliberately excluded for now:
 *   * Mutations (promote, pull, server.start) — land once dry-run +
 *     audit helpers are factored into a shared package.
 *   * Remote-node fan-out — reads currently hit the control plane's
 *     own state; dispatcher-routed tools follow as the M.1 plan calls
 *     for broader coverage.
 */

function toText(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

export function buildMcpServer(opts?: { name?: string; version?: string }): McpServer {
  const server = new McpServer({
    name: opts?.name ?? 'llamactl',
    version: opts?.version ?? '0.0.0',
  });

  server.registerTool(
    'llamactl.catalog.list',
    {
      title: 'List curated models',
      description:
        'Read the llamactl curated-models catalog on the control plane. Returns one entry per (rel, scope).',
      inputSchema: {
        scope: z
          .enum(['all', 'builtin', 'custom'])
          .default('all')
          .describe('Which catalog tier to include.'),
      },
    },
    async ({ scope }) => toText(catalog.listCatalog(scope ?? 'all')),
  );

  server.registerTool(
    'llamactl.node.ls',
    {
      title: 'List cluster nodes',
      description:
        'Read the kubeconfig (`~/.llamactl/config`) and return every node in the current cluster with its resolved kind (agent | gateway | provider).',
      inputSchema: {},
    },
    async () => {
      const cfg = kubecfg.loadConfig();
      const ctx = cfg.contexts.find((c) => c.name === cfg.currentContext);
      const cluster = cfg.clusters.find((c) => c.name === ctx?.cluster);
      const rows = (cluster?.nodes ?? []).map((n) => ({
        name: n.name,
        endpoint: n.endpoint,
        kind: resolveNodeKind(n),
        hasCloud: !!n.cloud,
        hasProvider: !!n.provider,
      }));
      return toText({
        context: ctx?.name ?? null,
        cluster: cluster?.name ?? null,
        nodes: rows,
      });
    },
  );

  server.registerTool(
    'llamactl.bench.compare',
    {
      title: 'Bench comparison table',
      description:
        'Return the bench comparison table joining curated catalog, preset tunings, and recorded runs. Filters mirror the `llamactl bench compare` CLI.',
      inputSchema: {
        classFilter: z
          .enum(['all', 'reasoning', 'multimodal', 'general', 'custom'])
          .default('all')
          .describe('Model class to include.'),
        scopeFilter: z
          .string()
          .default('all')
          .describe('Catalog scope (all | builtin | custom | candidate | …).'),
      },
    },
    async ({ classFilter, scopeFilter }) => {
      const resolved = envMod.resolveEnv();
      void resolved; // touch resolveEnv so we fail fast on misconfigured env
      return toText(
        bench.benchCompare({
          classFilter: classFilter ?? 'all',
          scopeFilter: scopeFilter ?? 'all',
        }),
      );
    },
  );

  return server;
}
