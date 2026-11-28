// #518 degraded-tier routing signals for embersynth bench scoring.

import type { Config } from "@llamactl/core/config/schema";

import { qualificationOverrides, type schemas } from "@llamactl/core";
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
  tmp = mkdtempSync(join(tmpdir(), "llamactl-embersynth-degraded-"));
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
        nodes: [{ name: "gpu1", endpoint: "https://gpu1.lan:7843" }],
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

describe("embersynth degraded bench tier (#518)", () => {
  test("E1: a degraded rel loses to a slower healthy rel", () => {
    const out = generateEmbersynthConfig({
      cfg: cfgWith(),
      benchHistory: [
        row("gpu1", "90", "degraded.gguf", "16384"),
        row("gpu1", "20", "stable.gguf", "4096"),
      ],
      env: {},
      qualificationStages: new Map([["degraded.gguf", "degraded"]]),
    });

    const gpu1 = agentNode(out, "agent-gpu1");
    expect(gpu1?.modelId).toBe("stable.gguf");
    expect(gpu1?.priority).toBe(4);
    expect(gpu1?.optimization?.contextWindow).toBe(4096);
  });

  test("E2: the fastest degraded row wins when no healthy row exists", () => {
    const out = generateEmbersynthConfig({
      cfg: cfgWith(),
      benchHistory: [row("gpu1", "90", "a.gguf", "16384"), row("gpu1", "50", "b.gguf", "8192")],
      env: {},
      qualificationStages: new Map([
        ["a.gguf", "degraded"],
        ["b.gguf", "degraded"],
      ]),
    });

    const gpu1 = agentNode(out, "agent-gpu1");
    expect(gpu1?.modelId).toBe("a.gguf");
    expect(gpu1?.priority).toBe(9);
  });

  test("E3: a degraded rel loses to a healthy rel after experimental exclusion", () => {
    const out = generateEmbersynthConfig({
      cfg: cfgWith(),
      benchHistory: [
        row("gpu1", "95", "exp.gguf", "16384"),
        row("gpu1", "90", "deg.gguf", "16384"),
        row("gpu1", "20", "ok.gguf", "4096"),
      ],
      env: {},
      qualificationStages: new Map([
        ["exp.gguf", "experimental"],
        ["deg.gguf", "degraded"],
      ]),
    });

    expect(agentNode(out, "agent-gpu1")?.modelId).toBe("ok.gguf");
  });

  test("E4: the default stage reader applies an applied degraded override", () => {
    qualificationOverrides.writeAppliedStage(
      process.env["LOCAL_AI_QUALIFICATION_OVERRIDES_FILE"]!,
      { rel: "deg.gguf", from: "validated", to: "degraded" },
      "test",
    );

    const out = generateEmbersynthConfig({
      cfg: cfgWith(),
      benchHistory: [row("gpu1", "90", "deg.gguf"), row("gpu1", "20", "ok.gguf")],
      env: {
        DEV_STORAGE: tmp,
        LOCAL_AI_RUNTIME_DIR: join(tmp, "runtime"),
        LOCAL_AI_CUSTOM_CATALOG_FILE: join(tmp, "absent.tsv"),
      },
    });

    expect(agentNode(out, "agent-gpu1")?.modelId).toBe("ok.gguf");
  });
});
