import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { embersynth } from "@llamactl/remote";
import { appendAudit, toTextContent } from "@nova/mcp-shared";
import { z } from "zod";

import { SERVER_SLUG } from "./shared.js";

export function registerEmbersynthTools(server: McpServer): void {
  server.registerTool(
    "llamactl.embersynth.sync",
    {
      title: "Regenerate embersynth.yaml",
      description:
        "Project the current kubeconfig + sirius-providers + bench history into `embersynth.yaml`. Preserves hand-edited profiles/syntheticModels when a prior file exists. `dryRun: true` returns the would-be YAML without writing.",
      inputSchema: {
        path: z.string().optional().describe("Override the default embersynth.yaml path."),
        dryRun: z.boolean().default(false),
      },
    },
    (input) => {
      const { dryRun } = input;
      const path = input.path ?? embersynth.defaultEmbersynthConfigPath();
      const existing = embersynth.loadEmbersynthConfig(path);
      const next = embersynth.generateEmbersynthConfig({ existing });
      if (dryRun) {
        appendAudit({ server: SERVER_SLUG, tool: "llamactl.embersynth.sync", input, dryRun: true });
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
        tool: "llamactl.embersynth.sync",
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
    "llamactl.embersynth.set-default-profile",
    {
      title: "Remap a synthetic model to a different profile",
      description:
        "Update `syntheticModels[<syntheticModel>]` in embersynth.yaml so the named synthetic model routes to a different profile. Primary use case: the cost-guardian tier-2 action that flips `fusion-auto` (or another default) to `private-first` when spend crosses the force-private threshold. `dryRun: true` reports the diff without writing. Wet mode validates that the target profile exists, atomically rewrites the YAML, and returns the old + new mapping. Does NOT touch live embersynth processes — the gateway picks up the change on next config reload.",
      inputSchema: {
        profile: z
          .string()
          .min(1)
          .describe("Profile id to route to (must exist in config.profiles)."),
        syntheticModel: z
          .string()
          .min(1)
          .default("fusion-auto")
          .describe("Synthetic model key to remap. Default: fusion-auto."),
        dryRun: z.boolean().default(true),
        path: z.string().optional().describe("Override the default embersynth.yaml path."),
      },
    },
    (input) => {
      const dryRun = input.dryRun;
      const syntheticModel = input.syntheticModel;
      const path = input.path ?? embersynth.defaultEmbersynthConfigPath();
      const existing = embersynth.loadEmbersynthConfig(path);
      if (!existing) {
        appendAudit({
          server: SERVER_SLUG,
          tool: "llamactl.embersynth.set-default-profile",
          input,
          dryRun,
          result: { path, found: false },
        });
        return toTextContent({
          ok: false,
          reason: "config-missing",
          message: `${path} not found — run llamactl embersynth init first`,
          path,
        });
      }
      const profileExists = existing.profiles.some((p) => p.id === input.profile);
      if (!profileExists) {
        appendAudit({
          server: SERVER_SLUG,
          tool: "llamactl.embersynth.set-default-profile",
          input,
          dryRun,
          result: {
            path,
            profileExists: false,
            availableProfiles: existing.profiles.map((p) => p.id),
          },
        });
        return toTextContent({
          ok: false,
          reason: "unknown-profile",
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
          tool: "llamactl.embersynth.set-default-profile",
          input,
          dryRun: true,
          result: { path, unchanged, previous, next: input.profile },
        });
        return toTextContent({
          ok: true,
          mode: "dry-run",
          path,
          syntheticModel,
          previous,
          next: input.profile,
          unchanged,
          note: unchanged
            ? "syntheticModel already routes to the target profile — wet run would be a no-op"
            : "embersynth.yaml not modified; wet run would atomically rewrite syntheticModels",
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
        tool: "llamactl.embersynth.set-default-profile",
        input,
        dryRun: false,
        result: { path, syntheticModel, previous, next: input.profile },
      });
      return toTextContent({
        ok: true,
        mode: "wet",
        path,
        syntheticModel,
        previous,
        next: input.profile,
        unchanged,
        note: "embersynth.yaml rewritten — operator should reload embersynth for the change to take effect",
      });
    },
  );
}
