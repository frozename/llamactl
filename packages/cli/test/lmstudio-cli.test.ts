import { configSchema, type NodeClient } from "@llamactl/remote";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runLMStudio } from "../src/commands/lmstudio.js";
import { __resetTestSeams, __setTestSeams, resetGlobals, setGlobals } from "../src/dispatcher.js";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "../src/safe-fs.js";
import { captureProcessStreams } from "./helpers.js";

const ENV_KEYS = [
  "DEV_STORAGE",
  "LOCAL_AI_RUNTIME_DIR",
  "LLAMA_CPP_MODELS",
  "LLAMA_CPP_MACHINE_PROFILE",
  "LOCAL_AI_RECOMMENDATIONS_SOURCE",
  "LOCAL_AI_CUSTOM_CATALOG_FILE",
  "LOCAL_AI_PRESET_OVERRIDES_FILE",
  "LLAMACTL_TEST_PROFILE",
  "LMSTUDIO_MODELS_DIR",
] as const;

const USAGE_PREFIX = "Usage: llamactl lmstudio <subcommand>";

type TempRuntime = {
  env: NodeJS.ProcessEnv;
  devStorage: string;
  runtimeDir: string;
  modelsDir: string;
  cleanup: () => void;
};

function makeTempRuntime(): TempRuntime {
  const devStorage = mkdtempSync(join(tmpdir(), "llamactl-lmstudio-test-"));
  const runtimeDir = join(devStorage, "ai-models", "local-ai");
  const modelsDir = join(devStorage, "ai-models", "llama.cpp", "models");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env["PATH"] ?? "",
    HOME: process.env["HOME"] ?? "/tmp",
    DEV_STORAGE: devStorage,
    LOCAL_AI_RUNTIME_DIR: runtimeDir,
    LLAMA_CPP_MODELS: modelsDir,
    LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
    LOCAL_AI_RECOMMENDATIONS_SOURCE: "off",
    LOCAL_AI_CUSTOM_CATALOG_FILE: join(runtimeDir, "curated-models.tsv"),
    LOCAL_AI_PRESET_OVERRIDES_FILE: join(runtimeDir, "preset-overrides.tsv"),
  };
  return {
    env,
    devStorage,
    runtimeDir,
    modelsDir,
    cleanup: (): void => {
      rmSync(devStorage, { recursive: true, force: true });
    },
  };
}

function makeLMTree(root: string): void {
  const acme = join(root, "acme", "ExampleLM-GGUF");
  mkdirSync(acme, { recursive: true });
  writeFileSync(join(acme, "ExampleLM-UD-Q4_K_M.gguf"), "demo");
  const widgets = join(root, "widgets", "TinyModel-GGUF", "q8");
  mkdirSync(widgets, { recursive: true });
  writeFileSync(join(widgets, "TinyModel-Q8_0.gguf"), "demo");
}

type LmstudioResult = { result: number; stdout: string; stderr: string };

let temp: ReturnType<typeof makeTempRuntime>;
let snapshot: Record<string, string | undefined>;

beforeEach(() => {
  // 1. Snapshot all nine keys
  snapshot = {};
  for (const key of ENV_KEYS) {
    snapshot[key] = process.env[key];
  }

  // 2. makeTempRuntime
  temp = makeTempRuntime();

  // 3. Set first seven keys from temp.env
  for (const k of [
    "DEV_STORAGE",
    "LOCAL_AI_RUNTIME_DIR",
    "LLAMA_CPP_MODELS",
    "LLAMA_CPP_MACHINE_PROFILE",
    "LOCAL_AI_RECOMMENDATIONS_SOURCE",
    "LOCAL_AI_CUSTOM_CATALOG_FILE",
    "LOCAL_AI_PRESET_OVERRIDES_FILE",
  ] as const) {
    if (temp.env[k] !== undefined) process.env[k] = temp.env[k];
  }

  // 4. Set LLAMACTL_TEST_PROFILE
  process.env["LLAMACTL_TEST_PROFILE"] = join(temp.devStorage, "profile");

  // 5. Delete LMSTUDIO_MODELS_DIR
  delete process.env["LMSTUDIO_MODELS_DIR"];

  // 6. mkdirSync temp.runtimeDir
  mkdirSync(temp.runtimeDir, { recursive: true });

  // 7. Set test seams
  __setTestSeams({ config: configSchema.freshConfig() });
  resetGlobals();
});

afterEach(() => {
  // 1. Restore all nine keys
  for (const key of ENV_KEYS) {
    const val = snapshot[key];
    if (val === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = val;
    }
  }

  // 2. Reset seams
  __resetTestSeams();
  resetGlobals();

  // 3. Cleanup last
  temp.cleanup();
});

// ── Dispatch tests ──────────────────────────────────────────────

describe("lmstudio dispatch", () => {
  test("runLMStudio([]) prints USAGE and exits 1", async () => {
    const { result, stdout, stderr } = await captureProcessStreams(() => runLMStudio([]));
    expect(result).toBe(1);
    expect(stdout.startsWith(USAGE_PREFIX)).toBe(true);
    expect(stdout).toContain("  scan [--root=<dir>] [--json]");
    expect(stderr).toBe("");
  });

  test('["help"] prints USAGE and exits 0', async () => {
    const { result, stdout } = await captureProcessStreams(() => runLMStudio(["help"]));
    expect(result).toBe(0);
    expect(stdout.startsWith(USAGE_PREFIX)).toBe(true);
  });

  test('["-h"] prints USAGE and exits 0', async () => {
    const { result, stdout } = await captureProcessStreams(() => runLMStudio(["-h"]));
    expect(result).toBe(0);
    expect(stdout.startsWith(USAGE_PREFIX)).toBe(true);
  });

  test('["--help"] prints USAGE and exits 0', async () => {
    const { result, stdout } = await captureProcessStreams(() => runLMStudio(["--help"]));
    expect(result).toBe(0);
    expect(stdout.startsWith(USAGE_PREFIX)).toBe(true);
  });

  test('["frob"]: stderr startsWith error + USAGE_PREFIX, stdout empty, exit 1', async () => {
    const { result, stdout, stderr } = await captureProcessStreams(() => runLMStudio(["frob"]));
    expect(result).toBe(1);
    expect(stderr.startsWith("Unknown lmstudio subcommand: frob\n\n" + USAGE_PREFIX)).toBe(true);
    expect(stdout).toBe("");
  });
});

// ── Scan tests ───────────────────────────────────────────────────

describe("lmstudio scan", () => {
  test("scan --help prints USAGE and exits 0", async () => {
    const { result, stdout } = await captureProcessStreams(() => runLMStudio(["scan", "--help"]));
    expect(result).toBe(0);
    expect(stdout.startsWith(USAGE_PREFIX)).toBe(true);
  });

  test("scan --bogus: stderr === 'Unknown flag: --bogus\\n', exit 1", async () => {
    const { result, stderr } = await captureProcessStreams(() => runLMStudio(["scan", "--bogus"]));
    expect(result).toBe(1);
    expect(stderr).toBe("Unknown flag: --bogus\n");
  });

  test("scan --root=<tree> lists 2 models sorted", async () => {
    const tree = join(temp.devStorage, "lmstudio", "models");
    makeLMTree(tree);
    const { result, stdout } = await captureProcessStreams(() =>
      runLMStudio(["scan", `--root=${tree}`]),
    );
    expect(result).toBe(0);
    const lines = stdout.split("\n");
    expect(lines[0]).toBe(`root=${tree} (2 models)`);
    expect(lines.length).toBeGreaterThan(2);
    expect(lines[1]).toContain("repo=acme/ExampleLM-GGUF");
    expect(lines[2]).toContain("repo=widgets/TinyModel-GGUF");
  });

  test("scan --root=<tree> --json: parsed JSON has root and models.length", async () => {
    const tree = join(temp.devStorage, "lmstudio", "models");
    makeLMTree(tree);
    const { result, stdout } = await captureProcessStreams(() =>
      runLMStudio(["scan", `--root=${tree}`, "--json"]),
    );
    expect(result).toBe(0);
    const parsed = JSON.parse(stdout) as { root: string; models: unknown[] };
    expect(parsed.root).toBe(tree);
    expect(parsed.models.length).toBe(2);
  });

  test("scan --root=<missing dir>: stdout 'root=<missing> (0 models)\\n', exit 1", async () => {
    const missing = join(temp.devStorage, "does-not-exist");
    const { result, stdout } = await captureProcessStreams(() =>
      runLMStudio(["scan", `--root=${missing}`]),
    );
    expect(result).toBe(1);
    expect(stdout).toBe(`root=${missing} (0 models)\n`);
  });

  test("scan --root=<empty existing dir> --json: models is [], exit 1", async () => {
    const emptyDir = join(temp.devStorage, "empty-lm");
    mkdirSync(emptyDir, { recursive: true });
    const { result, stdout } = await captureProcessStreams(() =>
      runLMStudio(["scan", `--root=${emptyDir}`, "--json"]),
    );
    expect(result).toBe(1);
    const parsed = JSON.parse(stdout) as { models: unknown[] };
    expect(parsed.models).toEqual([]);
  });

  test("scan with no --root and nothing detected: stderr + exit 1", async () => {
    const { result, stdout, stderr } = await captureProcessStreams(() => runLMStudio(["scan"]));
    expect(result).toBe(1);
    expect(stderr).toBe("No LM Studio install detected. Pass --root or set LMSTUDIO_MODELS_DIR.\n");
    expect(stdout).toBe("");
  });
});

// ── Import flag tests ────────────────────────────────────────────

describe("lmstudio import flags", () => {
  test("import --bogus: stderr === 'Unknown flag: --bogus\\n', exit 1", async () => {
    const { result, stderr } = await captureProcessStreams(() =>
      runLMStudio(["import", "--bogus"]),
    );
    expect(result).toBe(1);
    expect(stderr).toBe("Unknown flag: --bogus\n");
  });

  test("import extra: stderr === 'Unexpected positional: extra\\n', exit 1", async () => {
    const { result, stderr } = await captureProcessStreams(() => runLMStudio(["import", "extra"]));
    expect(result).toBe(1);
    expect(stderr).toBe("Unexpected positional: extra\n");
  });

  test("import --help prints USAGE and exits 0", async () => {
    const { result, stdout } = await captureProcessStreams(() => runLMStudio(["import", "--help"]));
    expect(result).toBe(0);
    expect(stdout.startsWith(USAGE_PREFIX)).toBe(true);
  });
});

// ── Import preview (local) ───────────────────────────────────────

describe("lmstudio import preview (local)", () => {
  beforeEach(() => {
    __setTestSeams({ config: configSchema.freshConfig() });
    resetGlobals();
  });
  afterEach(() => {
    __resetTestSeams();
    resetGlobals();
  });

  test("import --root=<tree>: preview lists candidates, no changes made", async () => {
    const tree = join(temp.devStorage, "lmstudio", "models");
    makeLMTree(tree);
    const { result, stdout } = await captureProcessStreams(() =>
      runLMStudio(["import", `--root=${tree}`]),
    );
    expect(result).toBe(0);
    const lines = stdout.split("\n");
    expect(lines[0]).toBe(`root=${tree} (2 candidates)`);
    expect(lines[1]).toContain("link-and-add");
    expect(lines[2]).toContain("link-and-add");
    expect(stdout).toContain("Re-run with --apply to make the above changes.\n");

    // Verify no symlink or file exists at target
    const targetPath = join(temp.modelsDir, "ExampleLM-GGUF", "ExampleLM-UD-Q4_K_M.gguf");
    expect(existsSync(targetPath)).toBe(false);
  });

  test("import --root=<tree> --no-link: both items are 'add'", async () => {
    const tree = join(temp.devStorage, "lmstudio", "models");
    makeLMTree(tree);
    const { result, stdout } = await captureProcessStreams(() =>
      runLMStudio(["import", `--root=${tree}`, "--no-link"]),
    );
    expect(result).toBe(0);
    expect(stdout).toContain("add");
    expect(stdout).not.toContain("link-and-add");
  });

  test("Pre-create target: row contains 'skip-target-exists'", async () => {
    const tree = join(temp.devStorage, "lmstudio", "models");
    makeLMTree(tree);
    // Pre-create a regular file at the target path
    const targetPath = join(temp.modelsDir, "ExampleLM-GGUF", "ExampleLM-UD-Q4_K_M.gguf");
    mkdirSync(join(temp.modelsDir, "ExampleLM-GGUF"), { recursive: true });
    writeFileSync(targetPath, "existing");

    const { result, stdout } = await captureProcessStreams(() =>
      runLMStudio(["import", `--root=${tree}`]),
    );
    expect(result).toBe(0);
    expect(stdout).toContain("skip-target-exists");
    expect(stdout).toContain(" — Target path already exists: " + targetPath);
  });

  test("Preview with no root: stderr is the no-install message, exit 1", async () => {
    const { result, stdout, stderr } = await captureProcessStreams(() => runLMStudio(["import"]));
    expect(result).toBe(1);
    expect(stderr).toBe("No LM Studio install detected. Pass --root or set LMSTUDIO_MODELS_DIR.\n");
    expect(stdout).toBe("");
  });

  test("Preview with no root plus --json: exit 0 with {root:null, items:[]}", async () => {
    const { result, stdout } = await captureProcessStreams(() => runLMStudio(["import", "--json"]));
    expect(result).toBe(0);
    const parsed = JSON.parse(stdout) as { root: null; items: unknown[] };
    expect(parsed.root).toBe(null);
    expect(parsed.items).toEqual([]);
  });
});

// ── Import apply (local) ─────────────────────────────────────────

describe("lmstudio import apply (local)", () => {
  beforeEach(() => {
    __setTestSeams({ config: configSchema.freshConfig() });
    resetGlobals();
  });
  afterEach(() => {
    __resetTestSeams();
    resetGlobals();
  });

  test("import --root=<tree> --apply: symlinks created, applied=2", async () => {
    const tree = join(temp.devStorage, "lmstudio", "models");
    makeLMTree(tree);
    const { result, stdout } = await captureProcessStreams(() =>
      runLMStudio(["import", `--root=${tree}`, "--apply"]),
    );
    expect(result).toBe(0);
    expect(stdout).toContain(`root=${tree} applied=2 skipped=0 errors=0`);

    const targetPath = join(temp.modelsDir, "ExampleLM-GGUF", "ExampleLM-UD-Q4_K_M.gguf");
    expect(lstatSync(targetPath).isSymbolicLink()).toBe(true);
  });

  test("import --root=<tree> --apply --no-link: applied=2, no symlink", async () => {
    const tree = join(temp.devStorage, "lmstudio", "models");
    makeLMTree(tree);
    const { result, stdout } = await captureProcessStreams(() =>
      runLMStudio(["import", `--root=${tree}`, "--apply", "--no-link"]),
    );
    expect(result).toBe(0);
    expect(stdout).toContain("applied=2");

    const targetPath = join(temp.modelsDir, "ExampleLM-GGUF", "ExampleLM-UD-Q4_K_M.gguf");
    expect(existsSync(targetPath)).toBe(false);
  });

  test("import --apply with no root: stderr + exit 1", async () => {
    const { result, stderr } = await captureProcessStreams(() =>
      runLMStudio(["import", "--apply"]),
    );
    expect(result).toBe(1);
    expect(stderr).toBe("No LM Studio install detected.\n");
  });
});

// ── Remote tests ─────────────────────────────────────────────────

type ScanInput = { root?: string } | undefined;
type PlanInput = { root?: string; link?: boolean } | undefined;
type ImportInput = { root?: string; link?: boolean };

describe("lmstudio remote", () => {
  let scanCalls: ScanInput[];
  let planCalls: PlanInput[];
  let importCalls: ImportInput[];

  function setupRemoteSeams(
    scanReturns: { root: string; models: unknown[] }[],
    planReturns: { root: string; items: unknown[] }[],
    importReturns: {
      root: string;
      applied: unknown[];
      skipped: unknown[];
      errors: { rel: string; error: string }[];
    }[],
  ): void {
    let scanIdx = 0;
    let planIdx = 0;
    let importIdx = 0;

    const cfg = configSchema.freshConfig();
    cfg.clusters[0]!.nodes.push({ name: "gpu1", endpoint: "https://gpu1.lan:7843" });

    const mockClient = {
      lmstudioScan: {
        // eslint-disable-next-line @typescript-eslint/require-await -- Async signature mirrors the tRPC procedure.
        query: async (input: ScanInput) => {
          scanCalls.push(input);
          const result = scanReturns[scanIdx++] ?? { root: "/r", models: [] };
          return result;
        },
      },
      lmstudioPlan: {
        // eslint-disable-next-line @typescript-eslint/require-await -- Async signature mirrors the tRPC procedure.
        query: async (input: PlanInput) => {
          planCalls.push(input);
          const result = planReturns[planIdx++] ?? { root: "/r", items: [] };
          return result;
        },
      },
      lmstudioImport: {
        // eslint-disable-next-line @typescript-eslint/require-await -- Async signature mirrors the tRPC procedure.
        mutate: async (input: ImportInput) => {
          importCalls.push(input);
          const result = importReturns[importIdx++] ?? {
            root: "/r",
            applied: [],
            skipped: [],
            errors: [],
          };
          return result;
        },
      },
    } as unknown as NodeClient;

    __setTestSeams({ config: cfg, nodeClient: mockClient });
    setGlobals({ nodeName: "gpu1", contextName: null, configPath: null });
  }

  beforeEach(() => {
    scanCalls = [];
    planCalls = [];
    importCalls = [];
    // Save env
    for (const key of ENV_KEYS) {
      if (snapshot[key] !== undefined) {
        process.env[key] = snapshot[key];
      } else {
        Reflect.deleteProperty(process.env, key);
      }
    }
  });

  afterEach(() => {
    __resetTestSeams();
    resetGlobals();
    // Restore env
    for (const key of ENV_KEYS) {
      const val = snapshot[key];
      if (val === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = val;
      }
    }
  });

  test("scan with no --root records query(undefined); scan --root=/x records query({root:'/x'}), both exit 1", async () => {
    setupRemoteSeams([{ root: "/r", models: [] }], [], []);

    const { result: code1 } = await captureProcessStreams(() => runLMStudio(["scan"]));
    expect(code1).toBe(1);
    expect(scanCalls).toHaveLength(1);
    expect(scanCalls[0]).toBeUndefined();

    scanCalls = [];
    const { result: code2 } = await captureProcessStreams(() => runLMStudio(["scan", "--root=/x"]));
    expect(code2).toBe(1);
    expect(scanCalls).toHaveLength(1);
    expect(scanCalls[0]).toEqual({ root: "/x" });
  });

  test("lmstudioScan.query rejects: stderr + exit 1", async () => {
    const mockClient = {
      lmstudioScan: {
        // eslint-disable-next-line @typescript-eslint/require-await -- Async signature mirrors the tRPC procedure.
        query: async () => {
          throw new Error("boom");
        },
      },
    } as unknown as NodeClient;

    const cfg = configSchema.freshConfig();
    cfg.clusters[0]!.nodes.push({ name: "gpu1", endpoint: "https://gpu1.lan:7843" });
    __setTestSeams({ config: cfg, nodeClient: mockClient });
    setGlobals({ nodeName: "gpu1", contextName: null, configPath: null });

    const { result, stderr } = await captureProcessStreams(() => runLMStudio(["scan"]));
    expect(result).toBe(1);
    expect(stderr).toBe("lmstudio scan: remote call to 'gpu1' failed: boom\n");
  });

  test("import preview with no flags records lmstudioPlan.query(undefined), exit 0", async () => {
    setupRemoteSeams([], [{ root: "/r", items: [] }], []);

    const { result } = await captureProcessStreams(() => runLMStudio(["import"]));
    expect(result).toBe(0);
    expect(planCalls).toHaveLength(1);
    expect(planCalls[0]).toBeUndefined();
  });

  test("import --no-link records query({link:false}), exit 0", async () => {
    setupRemoteSeams([], [{ root: "/r", items: [] }], []);

    const { result } = await captureProcessStreams(() => runLMStudio(["import", "--no-link"]));
    expect(result).toBe(0);
    expect(planCalls).toHaveLength(1);
    expect(planCalls[0]).toEqual({ link: false });
  });

  test("import --root=/x records input with root, no link key, exit 0", async () => {
    setupRemoteSeams([], [{ root: "/r", items: [] }], []);

    const { result } = await captureProcessStreams(() => runLMStudio(["import", "--root=/x"]));
    expect(result).toBe(0);
    expect(planCalls).toHaveLength(1);
    expect(planCalls[0]).toEqual({ root: "/x" });
  });

  test("import --apply with no flags records lmstudioImport.mutate({}), exit 0", async () => {
    setupRemoteSeams([], [], [{ root: "/r", applied: [], skipped: [], errors: [] }]);

    const { result } = await captureProcessStreams(() => runLMStudio(["import", "--apply"]));
    expect(result).toBe(0);
    expect(importCalls).toHaveLength(1);
    expect(importCalls[0]).toEqual({});
  });

  test("mutate with errors: stderr contains error lines, exit 1 (text + json)", async () => {
    let mutationIdx = 0;
    const mutationReturns = [
      {
        root: "/r",
        applied: [],
        skipped: [],
        errors: [{ rel: "a/b.gguf", error: "nope" }],
      },
      {
        root: "/r",
        applied: [],
        skipped: [],
        errors: [{ rel: "a/b.gguf", error: "nope" }],
      },
    ];

    const cfg = configSchema.freshConfig();
    cfg.clusters[0]!.nodes.push({ name: "gpu1", endpoint: "https://gpu1.lan:7843" });

    const mockClient = {
      lmstudioScan: {
        // eslint-disable-next-line @typescript-eslint/require-await -- Async signature mirrors the tRPC procedure.
        query: async () => ({ root: "/r", models: [] }),
      },
      lmstudioPlan: {
        // eslint-disable-next-line @typescript-eslint/require-await -- Async signature mirrors the tRPC procedure.
        query: async () => ({ root: "/r", items: [] }),
      },
      lmstudioImport: {
        // eslint-disable-next-line @typescript-eslint/require-await -- Async signature mirrors the tRPC procedure.
        mutate: async () => {
          const result = mutationReturns[mutationIdx++] ?? {
            root: "/r",
            applied: [],
            skipped: [],
            errors: [],
          };
          return result;
        },
      },
    } as unknown as NodeClient;

    __setTestSeams({ config: cfg, nodeClient: mockClient });
    setGlobals({ nodeName: "gpu1", contextName: null, configPath: null });

    const { result: code1, stderr: stderr1 } = await captureProcessStreams(() =>
      runLMStudio(["import", "--apply"]),
    );
    expect(code1).toBe(1);
    expect(stderr1).toContain("  error rel=a/b.gguf: nope");

    // Same result with --json also exits 1
    const { result: code2 } = await captureProcessStreams(() =>
      runLMStudio(["import", "--apply", "--json"]),
    );
    expect(code2).toBe(1);
  });
});
