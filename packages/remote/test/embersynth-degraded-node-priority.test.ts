// #518 degraded-node priority demotion for embersynth fusion routing.

import type { schemas } from "@llamactl/core";
import type { Config } from "@llamactl/core/config/schema";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type EmbersynthConfig,
  type EmbersynthNode,
  generateEmbersynthConfig,
} from "../src/config/embersynth.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";

let tmp = "";
const originalEnv: NodeJS.ProcessEnv = { ...process.env };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-embersynth-degraded-node-priority-"));
  process.env["DEV_STORAGE"] = tmp;
  process.env["LLAMACTL_CONFIG"] = join(tmp, "kubeconfig");
  process.env["LLAMACTL_SIRIUS_PROVIDERS"] = join(tmp, "sirius-providers.yaml");
  process.env["LOCAL_AI_RUNTIME_DIR"] = join(tmp, "runtime");
  process.env["LOCAL_AI_CUSTOM_CATALOG_FILE"] = join(tmp, "absent-catalog.tsv");
  process.env["LOCAL_AI_QUALIFICATION_OVERRIDES_FILE"] = join(tmp, "overrides.tsv");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv);
});

function cfgWith(): Config {
  return {
    apiVersion: "llamactl/v1",
    kind: "Config",
    currentContext: "default",
    contexts: [{ name: "default", cluster: "home", user: "me", defaultNode: "local" }],
    clusters: [
      {
        name: "home",
        nodes: [
          { name: "gpu1", endpoint: "https://gpu1.lan:7843" },
          { name: "gpu2", endpoint: "https://gpu2.lan:7843" },
        ],
      },
    ],
    users: [{ name: "me", token: "agent-bearer" }],
  };
}

function row(
  machine: string,
  gen_ts: string,
  rel = "x/y.gguf",
  ctx = "8192",
): schemas.BenchHistoryEntry {
  return {
    updated_at: "2026-04-01T00:00:00Z",
    machine,
    rel,
    mode: "text",
    ctx,
    build: "b1",
    profile: "p",
    gen_ts,
    prompt_ts: "100",
    launch_args: "",
  };
}

function agentNode(out: EmbersynthConfig, id: string): EmbersynthNode | undefined {
  return out.nodes.find((n) => n.id === id);
}

describe("embersynth degraded node priority (#518)", () => {
  test("N1: a degraded-only node ranks behind a slower healthy node", () => {
    const out = generateEmbersynthConfig({
      cfg: cfgWith(),
      benchHistory: [row("gpu1", "90", "deg.gguf"), row("gpu2", "40", "ok.gguf")],
      env: {},
      qualificationStages: new Map([["deg.gguf", "degraded"]]),
    });

    const gpu1 = agentNode(out, "agent-gpu1");
    const gpu2 = agentNode(out, "agent-gpu2");
    expect(gpu1?.modelId).toBe("deg.gguf");
    expect(gpu1?.priority).toBe(9);
    expect(gpu2?.priority).toBe(2);
    expect(gpu1?.priority).toBeGreaterThan(gpu2?.priority ?? 0);
  });

  test("N2: a degraded node ranks behind an unbenched healthy node", () => {
    const out = generateEmbersynthConfig({
      cfg: cfgWith(),
      benchHistory: [row("gpu1", "90", "deg.gguf")],
      env: {},
      qualificationStages: new Map([["deg.gguf", "degraded"]]),
    });

    const gpu1 = agentNode(out, "agent-gpu1");
    const gpu2 = agentNode(out, "agent-gpu2");
    expect(gpu2?.priority).toBe(5);
    expect(gpu1?.priority).toBe(9);
    expect(gpu1?.priority).toBeGreaterThan(5);
    expect(gpu1?.priority).toBeLessThan(10);
  });

  test("N3: healthy bench bands are unchanged", () => {
    const out = generateEmbersynthConfig({
      cfg: cfgWith(),
      benchHistory: [row("gpu1", "90", "fast.gguf"), row("gpu2", "20", "slow.gguf")],
      env: {},
      qualificationStages: new Map(),
    });

    expect(agentNode(out, "agent-gpu1")?.priority).toBe(1);
    expect(agentNode(out, "agent-gpu2")?.priority).toBe(4);
  });

  test("N4: degraded nodes all share the demoted priority", () => {
    const out = generateEmbersynthConfig({
      cfg: cfgWith(),
      benchHistory: [row("gpu1", "90", "a.gguf"), row("gpu2", "20", "b.gguf")],
      env: {},
      qualificationStages: new Map([
        ["a.gguf", "degraded"],
        ["b.gguf", "degraded"],
      ]),
    });

    expect(agentNode(out, "agent-gpu1")?.priority).toBe(9);
    expect(agentNode(out, "agent-gpu2")?.priority).toBe(9);
  });
});
