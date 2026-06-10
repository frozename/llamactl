import { env as envMod, presets } from "@llamactl/core";
import { agentConfig, config as kubecfg, type ClusterNode, workloadStore } from "@llamactl/remote";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { appendAudit, toTextContent } from "@nova/mcp-shared";
import { z } from "zod";

import {
  PRESET_ENUM,
  PROFILE_ENUM,
  SERVER_SLUG,
  type WorkloadDeleteDryRunResult,
} from "./shared.js";

export function registerMutationTools(server: McpServer): void {
  registerNodeAdd(server);
  registerNodeRemove(server);
  registerWorkloadDelete(server);
  registerCatalogPromote(server);
  registerCatalogPromoteDelete(server);
}

function registerNodeAdd(server: McpServer): void {
  server.registerTool(
    "llamactl.node.add",
    {
      title: "Add a node from a bootstrap blob",
      description:
        "Ingest a `llamactl agent init` bootstrap blob and register the new node in the current cluster's kubeconfig. `dryRun: true` decodes the blob and previews the resulting node entry without writing. Does NOT probe reachability — chain with nova.ops.healthcheck after a wet-run to confirm.",
      inputSchema: {
        name: z.string().min(1),
        bootstrap: z.string().min(1).describe("base64 blob emitted by `llamactl agent init`"),
        dryRun: z.boolean().default(false),
      },
    },
    (input) => {
      const { name, bootstrap, dryRun } = input;
      let decoded: ReturnType<typeof agentConfig.decodeBootstrap>;
      try {
        decoded = agentConfig.decodeBootstrap(bootstrap);
      } catch (err) {
        appendAudit({
          server: SERVER_SLUG,
          tool: "llamactl.node.add",
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
          tool: "llamactl.node.add",
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
        return toTextContent({ ok: false, error: "no current context in kubeconfig" });
      }
      cfg = {
        ...cfg,
        users: cfg.users.map((u) => (u.name === ctx.user ? { ...u, token: decoded.token } : u)),
      };
      cfg = kubecfg.upsertNode(cfg, ctx.cluster, entry);
      kubecfg.saveConfig(cfg);
      appendAudit({
        server: SERVER_SLUG,
        tool: "llamactl.node.add",
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
}

function registerNodeRemove(server: McpServer): void {
  server.registerTool(
    "llamactl.node.remove",
    {
      title: "Remove a node from the current cluster",
      description:
        "Drop a node from kubeconfig (`~/.llamactl/config`). No-op if absent. Does NOT stop running workloads on that node — chain with workload.delete or drain-node. `dryRun: true` previews without writing.",
      inputSchema: {
        name: z.string().min(1),
        dryRun: z.boolean().default(false),
      },
    },
    (input) => {
      const { name, dryRun } = input;
      const cfg = kubecfg.loadConfig();
      const ctx = cfg.contexts.find((c) => c.name === cfg.currentContext);
      const cluster = cfg.clusters.find((c) => c.name === ctx?.cluster);
      const match = cluster?.nodes.find((n) => n.name === name);
      if (dryRun) {
        appendAudit({ server: SERVER_SLUG, tool: "llamactl.node.remove", input, dryRun: true });
        return toTextContent({
          dryRun: true,
          found: !!match,
          node: match ?? null,
          message: match
            ? `would remove node ${name} from cluster ${cluster?.name ?? "?"}`
            : `no node named ${name} in the current cluster`,
        });
      }
      if (!match || !cluster) {
        appendAudit({
          server: SERVER_SLUG,
          tool: "llamactl.node.remove",
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
        tool: "llamactl.node.remove",
        input,
        dryRun: false,
        result: { removed: true },
      });
      return toTextContent({ ok: true, removed: true, node: match });
    },
  );
}

function registerWorkloadDelete(server: McpServer): void {
  server.registerTool(
    "llamactl.workload.delete",
    {
      title: "Remove a workload manifest",
      description:
        "Delete the persisted workload manifest from the configured workloads directory (LLAMACTL_WORKLOADS_DIR, else $DEV_STORAGE/workloads, else ~/.llamactl/workloads). Does NOT stop the server — that's a separate imperative operation. Dry-run reports what the wet-run would have removed.",
      inputSchema: {
        name: z.string().min(1).describe("metadata.name of the manifest"),
        dryRun: z.boolean().default(false),
      },
    },
    (input) => {
      const { name, dryRun } = input;
      const manifests = workloadStore.listAnyWorkloadsForAdmission();
      const match = manifests.find((m) => m.metadata.name === name);
      const manifest = match ? workloadStore.loadWorkloadByNameAny(name) : null;
      if (dryRun) {
        appendAudit({ server: SERVER_SLUG, tool: "llamactl.workload.delete", input, dryRun: true });
        const result = {
          dryRun: true,
          found: !!match,
          kind: manifest?.kind ?? null,
          node: match?.spec.node ?? null,
          rel: match?.spec.target.value ?? null,
          message: match
            ? `would remove manifest ${name} (kind=${manifest?.kind ?? "unknown"}, node=${match.spec.node}, rel=${match.spec.target.value})`
            : `no manifest named ${name}`,
        } satisfies WorkloadDeleteDryRunResult;
        return toTextContent(result);
      }
      const removed = workloadStore.deleteWorkload(name);
      appendAudit({
        server: SERVER_SLUG,
        tool: "llamactl.workload.delete",
        input,
        dryRun: false,
        result: { removed, found: !!match },
      });
      return toTextContent({ ok: true, removed, manifest });
    },
  );
}

function registerCatalogPromote(server: McpServer): void {
  server.registerTool(
    "llamactl.catalog.promote",
    {
      title: "Promote a rel to a (profile, preset) slot",
      description:
        "Write a preset override so `llamactl resolve --preset <preset>` on `--profile <profile>` picks this rel. Accepts `dryRun: true` to preview without writing.",
      inputSchema: {
        profile: PROFILE_ENUM,
        preset: PRESET_ENUM,
        rel: z.string().min(1).describe("repo/file.gguf path the preset should resolve to"),
        dryRun: z.boolean().default(false),
      },
    },
    (input) => {
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
        appendAudit({ server: SERVER_SLUG, tool: "llamactl.catalog.promote", input, dryRun: true });
        return toTextContent(payload);
      }
      presets.writePresetOverride(profile, preset, rel);
      const after = presets.readPresetOverrides(file);
      appendAudit({
        server: SERVER_SLUG,
        tool: "llamactl.catalog.promote",
        input,
        dryRun: false,
        result: { ok: true, rows: after.length },
      });
      return toTextContent({ ok: true, promotions: after });
    },
  );
}

function registerCatalogPromoteDelete(server: McpServer): void {
  server.registerTool(
    "llamactl.catalog.promoteDelete",
    {
      title: "Clear a (profile, preset) promotion",
      description:
        "Remove the override row at (profile, preset). No-op if absent. Accepts `dryRun: true`.",
      inputSchema: {
        profile: PROFILE_ENUM,
        preset: PRESET_ENUM,
        dryRun: z.boolean().default(false),
      },
    },
    (input) => {
      const { profile, preset, dryRun } = input;
      const resolved = envMod.resolveEnv();
      const file = resolved.LOCAL_AI_PRESET_OVERRIDES_FILE;
      const before = presets.readPresetOverrides(file);
      const match = before.find((r) => r.profile === profile && r.preset === preset);
      if (dryRun) {
        appendAudit({
          server: SERVER_SLUG,
          tool: "llamactl.catalog.promoteDelete",
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
        tool: "llamactl.catalog.promoteDelete",
        input,
        dryRun: false,
        result: { removed, rows: after.length },
      });
      return toTextContent({ ok: true, removed, promotions: after });
    },
  );
}
