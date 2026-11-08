import { loadConfig, saveConfig } from "@llamactl/core/config/kubeconfig";
import { type ClusterNode, freshConfig } from "@llamactl/core/config/schema";
import { embersynth } from "@llamactl/remote";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";

import { runEmbersynth } from "../src/commands/embersynth.js";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "../src/safe-fs.js";
import {
  captureProcessStreams,
  parseJsonRecord,
  requireArrayField,
  requireRecord,
  requireRecordField,
} from "./helpers.js";

/**
 * `llamactl embersynth` subcommands exercised in-process against a
 * temp DEV_STORAGE — no spawns, no network. Covers --path/--name flag
 * validation, show/init/sync file handling, promote-private gating,
 * and connect's kubeconfig mutation.
 */

let tmp = "";
let originalEnv: Record<string, string | undefined> = {};

const PRIVATE_FIRST_PROFILE = {
  id: "private-first",
  label: "Private First",
  preferredTags: ["private"],
};

function writeEmbersynthFixture(path: string, fixture: unknown): void {
  const validated = embersynth.EmbersynthConfigSchema.parse(fixture);
  writeFileSync(path, stringifyYaml(validated), "utf8");
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-embersynth-cli-"));
  originalEnv = { ...process.env };
  process.env["DEV_STORAGE"] = tmp;
  Reflect.deleteProperty(process.env, "LLAMACTL_CONFIG");
  Reflect.deleteProperty(process.env, "LLAMACTL_EMBERSYNTH_CONFIG");
  Reflect.deleteProperty(process.env, "LLAMACTL_SIRIUS_PROVIDERS");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) Reflect.deleteProperty(process.env, key);
  Object.assign(process.env, originalEnv);
});

describe("embersynth --path flag", () => {
  test("show --path without a value exits 1", async () => {
    const { result, stderr } = await captureProcessStreams(() => runEmbersynth(["show", "--path"]));
    expect(result).toBe(1);
    expect(stderr).toContain("--path requires a value");
  });

  test("init --path without a value exits 1 and writes no file", async () => {
    const { result, stderr } = await captureProcessStreams(() => runEmbersynth(["init", "--path"]));
    expect(result).toBe(1);
    expect(stderr).toContain("--path requires a value");
    expect(existsSync(join(tmp, "embersynth.yaml"))).toBe(false);
  });

  test("sync --path without a value exits 1", async () => {
    const { result, stderr } = await captureProcessStreams(() => runEmbersynth(["sync", "--path"]));
    expect(result).toBe(1);
    expect(stderr).toContain("--path requires a value");
  });

  test("promote-private <rel> --path without a value exits 1", async () => {
    const { result, stderr } = await captureProcessStreams(() =>
      runEmbersynth(["promote-private", "org/model.gguf", "--path"]),
    );
    expect(result).toBe(1);
    expect(stderr).toContain("--path requires a value");
  });
});

describe("embersynth help and dispatch", () => {
  test("show --help prints usage to stdout", async () => {
    const { result, stdout, stderr } = await captureProcessStreams(() =>
      runEmbersynth(["show", "--help"]),
    );
    expect(result).toBe(0);
    expect(stdout).toContain("llamactl embersynth — embersynth orchestrator integration");
    expect(stderr).toBe("");
  });

  test("unknown subcommand exits 1", async () => {
    const { result, stderr } = await captureProcessStreams(() => runEmbersynth(["bogus"]));
    expect(result).toBe(1);
    expect(stderr).toContain("unknown embersynth subcommand: bogus");
  });
});

describe("embersynth show", () => {
  test("missing --path file exits 1", async () => {
    const absent = join(tmp, "absent.yaml");
    const { result, stderr } = await captureProcessStreams(() =>
      runEmbersynth(["show", "--path", absent]),
    );
    expect(result).toBe(1);
    expect(stderr).toContain(`${absent} does not exist. Run \`llamactl embersynth init\` first.`);
  });

  test("prints the --path file contents as JSON", async () => {
    const file = join(tmp, "custom.yaml");
    writeEmbersynthFixture(file, {
      server: { host: "127.0.0.1", port: 9311 },
      profiles: [{ id: "custom", label: "Custom" }],
    });
    const { result, stdout } = await captureProcessStreams(() =>
      runEmbersynth(["show", "--path", file]),
    );
    expect(result).toBe(0);
    const shown = parseJsonRecord(stdout);
    const server = requireRecordField(shown, "server");
    expect(server["port"]).toBe(9311);
    const profiles = requireArrayField(shown, "profiles");
    const first = requireRecord(profiles[0]);
    expect(first["id"]).toBe("custom");
  });
});

describe("embersynth init", () => {
  test("refuses to overwrite an existing file", async () => {
    const file = join(tmp, "embersynth.yaml");
    writeEmbersynthFixture(file, {
      server: { host: "127.0.0.1", port: 9311 },
      profiles: [{ id: "custom", label: "Custom" }],
    });
    const before = readFileSync(file);
    const { result, stderr } = await captureProcessStreams(() =>
      runEmbersynth(["init", "--path", file]),
    );
    expect(result).toBe(1);
    expect(stderr).toContain("already exists. Use `llamactl embersynth sync`");
    expect(readFileSync(file)).toEqual(before);
  });
});

describe("embersynth sync", () => {
  test("preserves hand-edited profiles and syntheticModels", async () => {
    const file = join(tmp, "embersynth.yaml");
    writeEmbersynthFixture(file, {
      server: { host: "127.0.0.1", port: 9312 },
      profiles: [{ id: "custom", label: "Custom" }],
      syntheticModels: { "my-fusion": "custom" },
    });
    const { result, stdout } = await captureProcessStreams(() =>
      runEmbersynth(["sync", "--path", file]),
    );
    expect(result).toBe(0);
    expect(stdout).toContain("profiles: 1 (preserved)");
    const reloaded = embersynth.loadEmbersynthConfig(file);
    if (!reloaded) throw new Error("expected embersynth config to reload");
    expect(reloaded.profiles.map((p) => p.id)).toEqual(["custom"]);
    expect(reloaded.syntheticModels).toEqual({ "my-fusion": "custom" });
    expect(reloaded.server.port).toBe(9312);
  });
});

describe("embersynth promote-private", () => {
  test("exits 1 without a rel argument", async () => {
    const { result, stderr } = await captureProcessStreams(() =>
      runEmbersynth(["promote-private"]),
    );
    expect(result).toBe(1);
    expect(stderr).toContain("embersynth promote-private: <rel> is required");
  });

  test("exits 1 when the private-first profile is absent", async () => {
    const file = join(tmp, "embersynth.yaml");
    writeEmbersynthFixture(file, { profiles: [{ id: "auto", label: "Automatic" }] });
    const { result, stderr } = await captureProcessStreams(() =>
      runEmbersynth(["promote-private", "org/model.gguf", "--path", file]),
    );
    expect(result).toBe(1);
    expect(stderr).toContain(`private-first profile not found in ${file}`);
  });

  test("exits 1 when private-first lacks the private preferred tag", async () => {
    const file = join(tmp, "embersynth.yaml");
    writeEmbersynthFixture(file, {
      profiles: [{ id: "private-first", label: "Private First", preferredTags: ["fast"] }],
    });
    const { result, stderr } = await captureProcessStreams(() =>
      runEmbersynth(["promote-private", "org/model.gguf", "--path", file]),
    );
    expect(result).toBe(1);
    expect(stderr).toContain('private-first profile is missing the "private" preferred tag');
  });

  test("exits 1 when the cluster has no agent nodes", async () => {
    const file = join(tmp, "embersynth.yaml");
    writeEmbersynthFixture(file, { profiles: [PRIVATE_FIRST_PROFILE] });
    const gw: ClusterNode = {
      name: "gw",
      endpoint: "",
      kind: "gateway",
      cloud: { provider: "openai", baseUrl: "https://gw.example/v1" },
    };
    const cfg = freshConfig();
    cfg.clusters[0]!.nodes = [gw];
    saveConfig(cfg, join(tmp, "config"));
    const { result, stderr } = await captureProcessStreams(() =>
      runEmbersynth(["promote-private", "org/model.gguf", "--path", file]),
    );
    expect(result).toBe(1);
    expect(stderr).toContain("no agent nodes registered");
  });

  test("exits 1 when no embersynth node carries the private tag", async () => {
    const file = join(tmp, "embersynth.yaml");
    writeEmbersynthFixture(file, {
      profiles: [PRIVATE_FIRST_PROFILE],
      nodes: [{ id: "cloud-b", label: "cloud-b", endpoint: "https://cloud-b/v1", tags: ["cloud"] }],
    });
    const { result, stderr } = await captureProcessStreams(() =>
      runEmbersynth(["promote-private", "org/model.gguf", "--path", file]),
    );
    expect(result).toBe(1);
    expect(stderr).toContain('carry the "private" tag');
  });

  test("prints the routable model and eligible private nodes", async () => {
    const file = join(tmp, "embersynth.yaml");
    writeEmbersynthFixture(file, {
      profiles: [PRIVATE_FIRST_PROFILE],
      nodes: [
        { id: "mac-a", label: "mac-a", endpoint: "https://mac-a:7843/v1", tags: ["private"] },
        { id: "cloud-b", label: "cloud-b", endpoint: "https://cloud-b/v1", tags: ["cloud"] },
      ],
    });
    const { result, stdout } = await captureProcessStreams(() =>
      runEmbersynth(["promote-private", "org/model.gguf", "--path", file]),
    );
    expect(result).toBe(0);
    expect(stdout).toContain("model 'org/model.gguf' is routable under fusion-private-first.");
    expect(stdout).toContain("eligible private-tagged nodes (1):");
    expect(stdout).toContain("    - mac-a → https://mac-a:7843/v1");
    expect(stdout.includes("cloud-b")).toBe(false);
  });
});

describe("embersynth connect", () => {
  test("exits 1 without a base URL", async () => {
    const { result, stderr } = await captureProcessStreams(() => runEmbersynth(["connect"]));
    expect(result).toBe(1);
    expect(stderr).toContain("embersynth connect: base URL is required");
  });

  test("--name without a value exits 1", async () => {
    const { result, stderr } = await captureProcessStreams(() =>
      runEmbersynth(["connect", "http://127.0.0.1:7777", "--name"]),
    );
    expect(result).toBe(1);
    expect(stderr).toContain("--name requires a value");
  });

  test("unknown flag exits 1", async () => {
    const { result, stderr } = await captureProcessStreams(() =>
      runEmbersynth(["connect", "http://127.0.0.1:7777", "--bogus"]),
    );
    expect(result).toBe(1);
    expect(stderr).toContain("unknown flag: --bogus");
  });

  test("registers a gateway node with the api key ref", async () => {
    const { result, stdout } = await captureProcessStreams(() =>
      runEmbersynth([
        "connect",
        "http://127.0.0.1:7777",
        "--name",
        "es1",
        "--api-key-ref",
        "env:ES_KEY",
      ]),
    );
    expect(result).toBe(0);
    expect(stdout).toContain(
      "registered embersynth gateway as node 'es1' → http://127.0.0.1:7777/v1",
    );
    const cfg = loadConfig(join(tmp, "config"));
    const home = cfg.clusters.find((c) => c.name === "home");
    const es1 = home?.nodes.find((n) => n.name === "es1");
    expect(es1?.kind).toBe("gateway");
    expect(es1?.cloud).toEqual({
      provider: "embersynth",
      baseUrl: "http://127.0.0.1:7777/v1",
      apiKeyRef: "env:ES_KEY",
    });
  });

  test("does not append /v1 twice and omits apiKeyRef", async () => {
    const { result } = await captureProcessStreams(() =>
      runEmbersynth(["connect", "http://127.0.0.1:7777/v1", "--name", "es2"]),
    );
    expect(result).toBe(0);
    const cfg = loadConfig(join(tmp, "config"));
    const home = cfg.clusters.find((c) => c.name === "home");
    const es2 = home?.nodes.find((n) => n.name === "es2");
    expect(es2?.cloud).toEqual({
      provider: "embersynth",
      baseUrl: "http://127.0.0.1:7777/v1",
    });
  });
});
