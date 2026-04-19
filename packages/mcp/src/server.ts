import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  bench,
  catalog,
  env as envMod,
  nodeFacts as nodeFactsMod,
  presets,
  server as serverMod,
} from '@llamactl/core';
import {
  agentConfig,
  config as kubecfg,
  embersynth,
  resolveNodeKind,
  workloadStore,
  type ClusterNode,
} from '@llamactl/remote';
import { appendAudit, toTextContent } from '@nova/mcp-shared';

/**
 * `@llamactl/mcp` — Model Context Protocol server exposing llamactl's
 * operator surface to MCP-speaking clients (Claude Code, Claude
 * Desktop, third-party harnesses). Each tool maps 1:1 to an existing
 * llamactl procedure so the server is a thin adapter, never a second
 * implementation of the logic.
 *
 * Mutations accept `dryRun: boolean`. When true the handler returns
 * a preview describing what would change without mutating disk.
 * Every invocation — dry-run or wet-run — appends one JSONL record
 * to the audit sink, so operators can reconstruct what an agent did.
 */

const SERVER_SLUG = 'llamactl';

const PROFILE_ENUM = z.enum(['mac-mini-16g', 'balanced', 'macbook-pro-48g']);
const PRESET_ENUM = z.enum(['best', 'vision', 'balanced', 'fast']);

export function buildMcpServer(opts?: { name?: string; version?: string }): McpServer {
  const server = new McpServer({
    name: opts?.name ?? 'llamactl',
    version: opts?.version ?? '0.0.0',
  });

  // ---- Reads -----------------------------------------------------

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
    async ({ scope }) => toTextContent(catalog.listCatalog(scope ?? 'all')),
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
      return toTextContent({
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
      void resolved;
      return toTextContent(
        bench.benchCompare({
          classFilter: classFilter ?? 'all',
          scopeFilter: scopeFilter ?? 'all',
        }),
      );
    },
  );

  server.registerTool(
    'llamactl.server.status',
    {
      title: 'Local llama-server status',
      description:
        'Return the control plane\'s local llama-server state: up/down, running rel, PID, endpoint, and extraArgs. Operators use this alongside workload.list to reconcile "what the manifest wants" against "what is actually serving".',
      inputSchema: {},
    },
    async () => toTextContent(await serverMod.serverStatus()),
  );

  server.registerTool(
    'llamactl.workload.list',
    {
      title: 'List persisted ModelRun manifests',
      description:
        'Return every ModelRun manifest under ~/.llamactl/workloads/, each with the last-recorded status field. Live runtime phase (per-node server probing) is a CLI-only operation — callers chaining several steps should cross-reference llamactl.server.status for the control plane\'s node.',
      inputSchema: {},
    },
    async () => {
      const manifests = workloadStore.listWorkloads();
      const rows = manifests.map((m) => ({
        name: m.metadata.name,
        node: m.spec.node,
        rel: m.spec.target.value,
        gateway: m.spec.gateway,
        restartPolicy: m.spec.restartPolicy,
        status: m.status ?? null,
      }));
      return toTextContent({ count: rows.length, workloads: rows });
    },
  );

  server.registerTool(
    'llamactl.node.facts',
    {
      title: 'Local node hardware facts',
      description:
        'Return the control plane\'s own hardware inventory — profile (mac-mini-16g | balanced | macbook-pro-48g), memory bytes, OS/arch, GPU kind, llama.cpp build id, versions. Remote-node facts need the dispatcher; this tool covers the control-plane case.',
      inputSchema: {},
    },
    async () => toTextContent(nodeFactsMod.collectNodeFacts()),
  );

  server.registerTool(
    'llamactl.node.add',
    {
      title: 'Add a node from a bootstrap blob',
      description:
        'Ingest a `llamactl agent init` bootstrap blob and register the new node in the current cluster\'s kubeconfig. `dryRun: true` decodes the blob and previews the resulting node entry without writing. Does NOT probe reachability — chain with nova.ops.healthcheck after a wet-run to confirm.',
      inputSchema: {
        name: z.string().min(1),
        bootstrap: z.string().min(1).describe('base64 blob emitted by `llamactl agent init`'),
        dryRun: z.boolean().default(false),
      },
    },
    async (input) => {
      const { name, bootstrap, dryRun } = input;
      let decoded: ReturnType<typeof agentConfig.decodeBootstrap>;
      try {
        decoded = agentConfig.decodeBootstrap(bootstrap);
      } catch (err) {
        appendAudit({
          server: SERVER_SLUG,
          tool: 'llamactl.node.add',
          input: { name, dryRun },
          dryRun,
          result: { error: (err as Error).message },
        });
        return toTextContent({
          ok: false,
          error: `invalid bootstrap blob: ${(err as Error).message}`,
        });
      }
      const entry: ClusterNode = {
        name,
        endpoint: decoded.url,
        certificateFingerprint: decoded.fingerprint,
        ...(decoded.certificate ? { certificate: decoded.certificate } : {}),
      };
      if (dryRun) {
        appendAudit({
          server: SERVER_SLUG,
          tool: 'llamactl.node.add',
          input: { name, dryRun },
          dryRun: true,
        });
        return toTextContent({
          dryRun: true,
          node: {
            name: entry.name,
            endpoint: entry.endpoint,
            fingerprint: entry.certificateFingerprint,
          },
          message: `would add node ${name} pointing at ${decoded.url}`,
        });
      }
      let cfg = kubecfg.loadConfig();
      const ctx = cfg.contexts.find((c) => c.name === cfg.currentContext);
      if (!ctx) {
        return toTextContent({ ok: false, error: 'no current context in kubeconfig' });
      }
      cfg = {
        ...cfg,
        users: cfg.users.map((u) =>
          u.name === ctx.user ? { ...u, token: decoded.token } : u,
        ),
      };
      cfg = kubecfg.upsertNode(cfg, ctx.cluster, entry);
      kubecfg.saveConfig(cfg);
      appendAudit({
        server: SERVER_SLUG,
        tool: 'llamactl.node.add',
        input: { name, dryRun },
        dryRun: false,
        result: { ok: true, name, endpoint: decoded.url },
      });
      return toTextContent({
        ok: true,
        name,
        endpoint: decoded.url,
        fingerprint: decoded.fingerprint,
      });
    },
  );

  server.registerTool(
    'llamactl.node.remove',
    {
      title: 'Remove a node from the current cluster',
      description:
        'Drop a node from kubeconfig (`~/.llamactl/config`). No-op if absent. Does NOT stop running workloads on that node — chain with workload.delete or drain-node. `dryRun: true` previews without writing.',
      inputSchema: {
        name: z.string().min(1),
        dryRun: z.boolean().default(false),
      },
    },
    async (input) => {
      const { name, dryRun } = input;
      const cfg = kubecfg.loadConfig();
      const ctx = cfg.contexts.find((c) => c.name === cfg.currentContext);
      const cluster = cfg.clusters.find((c) => c.name === ctx?.cluster);
      const match = cluster?.nodes.find((n) => n.name === name);
      if (dryRun) {
        appendAudit({ server: SERVER_SLUG, tool: 'llamactl.node.remove', input, dryRun: true });
        return toTextContent({
          dryRun: true,
          found: !!match,
          node: match ?? null,
          message: match
            ? `would remove node ${name} from cluster ${cluster?.name ?? '?'}`
            : `no node named ${name} in the current cluster`,
        });
      }
      if (!match || !cluster) {
        appendAudit({
          server: SERVER_SLUG,
          tool: 'llamactl.node.remove',
          input,
          dryRun: false,
          result: { removed: false },
        });
        return toTextContent({ ok: true, removed: false, node: null });
      }
      const next = kubecfg.removeNode(cfg, cluster.name, name);
      kubecfg.saveConfig(next);
      appendAudit({
        server: SERVER_SLUG,
        tool: 'llamactl.node.remove',
        input,
        dryRun: false,
        result: { removed: true },
      });
      return toTextContent({ ok: true, removed: true, node: match });
    },
  );

  server.registerTool(
    'llamactl.workload.delete',
    {
      title: 'Remove a ModelRun manifest',
      description:
        'Delete the persisted ModelRun file under ~/.llamactl/workloads/. Does NOT stop the server — that\'s a separate imperative operation. Dry-run reports what the wet-run would have removed.',
      inputSchema: {
        name: z.string().min(1).describe('metadata.name of the manifest'),
        dryRun: z.boolean().default(false),
      },
    },
    async (input) => {
      const { name, dryRun } = input;
      const manifests = workloadStore.listWorkloads();
      const match = manifests.find((m) => m.metadata.name === name);
      if (dryRun) {
        appendAudit({ server: SERVER_SLUG, tool: 'llamactl.workload.delete', input, dryRun: true });
        return toTextContent({
          dryRun: true,
          found: !!match,
          node: match?.spec.node ?? null,
          rel: match?.spec.target.value ?? null,
          message: match
            ? `would remove manifest ${name} (node=${match.spec.node}, rel=${match.spec.target.value})`
            : `no manifest named ${name}`,
        });
      }
      const removed = workloadStore.deleteWorkload(name);
      appendAudit({
        server: SERVER_SLUG,
        tool: 'llamactl.workload.delete',
        input,
        dryRun: false,
        result: { removed, found: !!match },
      });
      return toTextContent({ ok: true, removed, manifest: match ?? null });
    },
  );

  server.registerTool(
    'llamactl.promotions.list',
    {
      title: 'List preset promotions',
      description:
        'Read the current preset-overrides.tsv rows — the active (profile, preset) → rel bindings the control plane will resolve.',
      inputSchema: {},
    },
    async () => {
      const resolved = envMod.resolveEnv();
      return toTextContent(presets.readPresetOverrides(resolved.LOCAL_AI_PRESET_OVERRIDES_FILE));
    },
  );

  // ---- Mutations -------------------------------------------------

  server.registerTool(
    'llamactl.catalog.promote',
    {
      title: 'Promote a rel to a (profile, preset) slot',
      description:
        'Write a preset override so `llamactl resolve --preset <preset>` on `--profile <profile>` picks this rel. Accepts `dryRun: true` to preview without writing.',
      inputSchema: {
        profile: PROFILE_ENUM,
        preset: PRESET_ENUM,
        rel: z.string().min(1).describe('repo/file.gguf path the preset should resolve to'),
        dryRun: z.boolean().default(false),
      },
    },
    async (input) => {
      const { profile, preset, rel, dryRun } = input;
      const resolved = envMod.resolveEnv();
      const file = resolved.LOCAL_AI_PRESET_OVERRIDES_FILE;
      const before = presets.readPresetOverrides(file);
      if (dryRun) {
        const prior = before.find((r) => r.profile === profile && r.preset === preset);
        const payload = {
          dryRun: true,
          file,
          prior: prior ?? null,
          next: { profile, preset, rel },
          message: prior
            ? `would replace ${prior.rel} with ${rel} for (${profile}, ${preset})`
            : `would add (${profile}, ${preset}) → ${rel}`,
        };
        appendAudit({ server: SERVER_SLUG, tool: 'llamactl.catalog.promote', input, dryRun: true });
        return toTextContent(payload);
      }
      presets.writePresetOverride(profile, preset, rel);
      const after = presets.readPresetOverrides(file);
      appendAudit({
        server: SERVER_SLUG,
        tool: 'llamactl.catalog.promote',
        input,
        dryRun: false,
        result: { ok: true, rows: after.length },
      });
      return toTextContent({ ok: true, promotions: after });
    },
  );

  server.registerTool(
    'llamactl.catalog.promoteDelete',
    {
      title: 'Clear a (profile, preset) promotion',
      description:
        'Remove the override row at (profile, preset). No-op if absent. Accepts `dryRun: true`.',
      inputSchema: {
        profile: PROFILE_ENUM,
        preset: PRESET_ENUM,
        dryRun: z.boolean().default(false),
      },
    },
    async (input) => {
      const { profile, preset, dryRun } = input;
      const resolved = envMod.resolveEnv();
      const file = resolved.LOCAL_AI_PRESET_OVERRIDES_FILE;
      const before = presets.readPresetOverrides(file);
      const match = before.find((r) => r.profile === profile && r.preset === preset);
      if (dryRun) {
        appendAudit({
          server: SERVER_SLUG,
          tool: 'llamactl.catalog.promoteDelete',
          input,
          dryRun: true,
        });
        return toTextContent({
          dryRun: true,
          prior: match ?? null,
          message: match
            ? `would remove (${profile}, ${preset}) → ${match.rel}`
            : `no promotion found for (${profile}, ${preset}) — no-op`,
        });
      }
      const removed = presets.deletePresetOverride(profile, preset);
      const after = presets.readPresetOverrides(file);
      appendAudit({
        server: SERVER_SLUG,
        tool: 'llamactl.catalog.promoteDelete',
        input,
        dryRun: false,
        result: { removed, rows: after.length },
      });
      return toTextContent({ ok: true, removed, promotions: after });
    },
  );

  server.registerTool(
    'llamactl.embersynth.sync',
    {
      title: 'Regenerate embersynth.yaml',
      description:
        'Project the current kubeconfig + sirius-providers + bench history into `embersynth.yaml`. Preserves hand-edited profiles/syntheticModels when a prior file exists. `dryRun: true` returns the would-be YAML without writing.',
      inputSchema: {
        path: z.string().optional().describe('Override the default embersynth.yaml path.'),
        dryRun: z.boolean().default(false),
      },
    },
    async (input) => {
      const { dryRun } = input;
      const path = input.path ?? embersynth.defaultEmbersynthConfigPath();
      const existing = embersynth.loadEmbersynthConfig(path);
      const next = embersynth.generateEmbersynthConfig({ existing });
      if (dryRun) {
        appendAudit({ server: SERVER_SLUG, tool: 'llamactl.embersynth.sync', input, dryRun: true });
        return toTextContent({
          dryRun: true,
          path,
          priorExists: !!existing,
          nodes: next.nodes.length,
          profiles: next.profiles.map((p) => p.id),
          syntheticModels: Object.keys(next.syntheticModels),
        });
      }
      embersynth.saveEmbersynthConfig(next, path);
      appendAudit({
        server: SERVER_SLUG,
        tool: 'llamactl.embersynth.sync',
        input,
        dryRun: false,
        result: { path, nodes: next.nodes.length, profiles: next.profiles.length },
      });
      return toTextContent({
        ok: true,
        path,
        nodes: next.nodes.length,
        profiles: next.profiles.length,
        syntheticModels: Object.keys(next.syntheticModels),
      });
    },
  );

  server.registerTool(
    'llamactl.embersynth.set-default-profile',
    {
      title: 'Remap a synthetic model to a different profile',
      description:
        'Update `syntheticModels[<syntheticModel>]` in embersynth.yaml so the named synthetic model routes to a different profile. Primary use case: the cost-guardian tier-2 action that flips `fusion-auto` (or another default) to `private-first` when spend crosses the force-private threshold. `dryRun: true` reports the diff without writing. Wet mode validates that the target profile exists, atomically rewrites the YAML, and returns the old + new mapping. Does NOT touch live embersynth processes — the gateway picks up the change on next config reload.',
      inputSchema: {
        profile: z
          .string()
          .min(1)
          .describe('Profile id to route to (must exist in config.profiles).'),
        syntheticModel: z
          .string()
          .min(1)
          .default('fusion-auto')
          .describe('Synthetic model key to remap. Default: fusion-auto.'),
        dryRun: z.boolean().default(true),
        path: z.string().optional().describe('Override the default embersynth.yaml path.'),
      },
    },
    async (input) => {
      const dryRun = input.dryRun ?? true;
      const syntheticModel = input.syntheticModel ?? 'fusion-auto';
      const path = input.path ?? embersynth.defaultEmbersynthConfigPath();
      const existing = embersynth.loadEmbersynthConfig(path);
      if (!existing) {
        appendAudit({
          server: SERVER_SLUG,
          tool: 'llamactl.embersynth.set-default-profile',
          input,
          dryRun,
          result: { path, found: false },
        });
        return toTextContent({
          ok: false,
          reason: 'config-missing',
          message: `${path} not found — run llamactl embersynth init first`,
          path,
        });
      }
      const profileExists = existing.profiles.some((p) => p.id === input.profile);
      if (!profileExists) {
        appendAudit({
          server: SERVER_SLUG,
          tool: 'llamactl.embersynth.set-default-profile',
          input,
          dryRun,
          result: { path, profileExists: false, availableProfiles: existing.profiles.map((p) => p.id) },
        });
        return toTextContent({
          ok: false,
          reason: 'unknown-profile',
          message: `profile '${input.profile}' not found in ${path}`,
          path,
          availableProfiles: existing.profiles.map((p) => p.id),
        });
      }
      const previous = existing.syntheticModels[syntheticModel] ?? null;
      const unchanged = previous === input.profile;
      if (dryRun) {
        appendAudit({
          server: SERVER_SLUG,
          tool: 'llamactl.embersynth.set-default-profile',
          input,
          dryRun: true,
          result: { path, unchanged, previous, next: input.profile },
        });
        return toTextContent({
          ok: true,
          mode: 'dry-run',
          path,
          syntheticModel,
          previous,
          next: input.profile,
          unchanged,
          note: unchanged
            ? 'syntheticModel already routes to the target profile — wet run would be a no-op'
            : 'embersynth.yaml not modified; wet run would atomically rewrite syntheticModels',
        });
      }
      const updated: embersynth.EmbersynthConfig = {
        ...existing,
        syntheticModels: {
          ...existing.syntheticModels,
          [syntheticModel]: input.profile,
        },
      };
      embersynth.saveEmbersynthConfig(updated, path);
      appendAudit({
        server: SERVER_SLUG,
        tool: 'llamactl.embersynth.set-default-profile',
        input,
        dryRun: false,
        result: { path, syntheticModel, previous, next: input.profile },
      });
      return toTextContent({
        ok: true,
        mode: 'wet',
        path,
        syntheticModel,
        previous,
        next: input.profile,
        unchanged,
        note: 'embersynth.yaml rewritten — operator should reload embersynth for the change to take effect',
      });
    },
  );

  return server;
}
