import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  bench,
  catalog,
  env as envMod,
  nodeFacts as nodeFactsMod,
  presets,
  server as serverMod,
} from "@llamactl/core";
import {
  config as kubecfg,
  modelHostStore,
  resolveNodeKind,
  router,
  workloadStore,
} from "@llamactl/remote";
import { toTextContent } from "@nova/mcp-shared";
import { z } from "zod";

export function registerReadTools(server: McpServer): void {
  server.registerTool(
    "llamactl.catalog.list",
    {
      title: "List curated models",
      description:
        "Read the llamactl curated-models catalog on the control plane. Returns one entry per (rel, scope).",
      inputSchema: {
        scope: z
          .enum(["all", "builtin", "custom"])
          .default("all")
          .describe("Which catalog tier to include."),
      },
    },
    ({ scope }) => toTextContent(catalog.listCatalog(scope)),
  );

  server.registerTool(
    "llamactl.node.ls",
    {
      title: "List cluster nodes",
      description:
        "Read the kubeconfig (`~/.llamactl/config`) and return every node in the current cluster with its resolved kind (agent | gateway | provider).",
      inputSchema: {},
    },
    () => {
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
    "llamactl.bench.compare",
    {
      title: "Bench comparison table",
      description:
        "Return the bench comparison table joining curated catalog, preset tunings, and recorded runs. Filters mirror the `llamactl bench compare` CLI.",
      inputSchema: {
        classFilter: z
          .enum(["all", "reasoning", "multimodal", "general", "custom"])
          .default("all")
          .describe("Model class to include."),
        scopeFilter: z
          .string()
          .default("all")
          .describe("Catalog scope (all | builtin | custom | candidate | …)."),
      },
    },
    ({ classFilter, scopeFilter }) => {
      const resolved = envMod.resolveEnv();
      void resolved;
      return toTextContent(
        bench.benchCompare({
          classFilter,
          scopeFilter,
        }),
      );
    },
  );

  server.registerTool(
    "llamactl.server.status",
    {
      title: "Local llama-server status",
      description:
        'Return the control plane\'s local llama-server state: up/down, running rel, PID, endpoint, and extraArgs. Operators use this alongside workload.list to reconcile "what the manifest wants" against "what is actually serving".',
      inputSchema: {
        workload: z.string().min(1).describe("Name of the ModelRun workload to inspect."),
      },
    },
    async ({ workload }) => toTextContent(await serverMod.serverStatus({ name: workload })),
  );

  server.registerTool(
    "llamactl.workload.list",
    {
      title: "List persisted ModelRun + ModelHost manifests",
      description:
        "Return every ModelRun and ModelHost manifest under ~/.llamactl/workloads/, each tagged with `kind` and its last-recorded status field. ModelHosts (oMLX etc.) are charged against the same node budget as ModelRuns, so they are listed here too. Live runtime phase (per-node server probing) is a CLI-only operation — callers chaining several steps should cross-reference llamactl.server.status for the control plane's node.",
      inputSchema: {},
    },
    () => {
      const rows = workloadStore.listWorkloads().map((m) => ({
        name: m.metadata.name,
        kind: "ModelRun" as const,
        node: m.spec.node,
        rel: m.spec.target.value,
        gateway: m.spec.gateway,
        restartPolicy: m.spec.restartPolicy,
        status: m.status ?? null,
      }));
      const hostRows = modelHostStore.listModelHosts().map((h) => ({
        name: h.metadata.name,
        kind: "ModelHost" as const,
        node: h.spec.node,
        rel: h.spec.hostedModels[0]?.rel ?? "",
        gateway: false,
        restartPolicy: h.spec.restartPolicy,
        status: null,
      }));
      const workloads = [...rows, ...hostRows].sort((a, b) => a.name.localeCompare(b.name));
      return toTextContent({ count: workloads.length, workloads });
    },
  );

  server.registerTool(
    "llamactl.node.facts",
    {
      title: "Local node hardware facts",
      description:
        "Return the control plane's own hardware inventory — profile (mac-mini-16g | balanced | macbook-pro-48g), memory bytes, OS/arch, GPU kind, llama.cpp build id, versions. Remote-node facts need the dispatcher; this tool covers the control-plane case.",
      inputSchema: {},
    },
    () => toTextContent(nodeFactsMod.collectNodeFacts()),
  );

  server.registerTool(
    "llamactl.node.budget",
    {
      title: "Node workload budget rollup",
      description:
        "Return the current budget, reserved GiB, and declared workloads for a node. Mirrors the node budget rollup used by `llamactl describe node` and the remote nodeBudget procedure. Read-only.",
      inputSchema: {
        node: z.string().min(1).describe("Name of the node to inspect."),
      },
    },
    async (input) => {
      const caller = router.createCaller({});
      return toTextContent(await caller.nodeBudget({ node: input.node }));
    },
  );

  server.registerTool(
    "llamactl.promotions.list",
    {
      title: "List preset promotions",
      description:
        "Read the current preset-overrides.tsv rows — the active (profile, preset) → rel bindings the control plane will resolve.",
      inputSchema: {},
    },
    () => {
      const resolved = envMod.resolveEnv();
      return toTextContent(presets.readPresetOverrides(resolved.LOCAL_AI_PRESET_OVERRIDES_FILE));
    },
  );
}
