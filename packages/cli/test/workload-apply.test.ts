import type { workloadSchema } from "@llamactl/remote";
import type { ModelHostManifest } from "@llamactl/remote/workload/modelhost-schema";

import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { runApply, stampApplyAnnotations } from "../src/commands/workload.js";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "../src/safe-fs.js";
import { captureProcessStreams } from "./helpers.js";

function makeManifest(): workloadSchema.ModelRun {
  return {
    apiVersion: "llamactl/v1",
    kind: "ModelRun",
    metadata: {
      name: "demo",
      labels: {},
      annotations: {},
    },
    spec: {
      node: "gpu1",
      enabled: true,
      target: { kind: "rel" as const, value: "fake/model.gguf" },
      extraArgs: [],
      workers: [],
      restartPolicy: "Always" as const,
      timeoutSeconds: 60,
      gateway: false,
      allowExternalBind: false,
    },
  };
}

describe("apply annotation stamping", () => {
  test("--evict collects repeatable values into the manifest annotation", () => {
    const manifest = makeManifest();

    stampApplyAnnotations(manifest, { evict: ["foo", "bar"], force: false });

    expect(manifest.metadata.annotations["llamactl.io/evict"]).toBe("foo,bar");
  });

  test("--force stamps force-admit=true on the manifest annotation", () => {
    const manifest = makeManifest();

    stampApplyAnnotations(manifest, { evict: [], force: true });

    expect(manifest.metadata.annotations["llamactl.io/force-admit"]).toBe("true");
  });
});

describe("apply flag validation", () => {
  function writeModelHostYaml(
    dir: string,
    opts: {
      enabled: boolean;
      endpointHost: string;
      binary?: string;
      annotationsLines?: string[];
    },
  ): string {
    const manifestPath = join(dir, "host.yaml");
    writeFileSync(
      manifestPath,
      [
        "apiVersion: llamactl/v1",
        "kind: ModelHost",
        "metadata:",
        "  name: mlx-host",
        ...(opts.annotationsLines ?? []),
        "spec:",
        "  engine: omlx",
        "  node: local",
        `  enabled: ${String(opts.enabled)}`,
        `  binary: ${opts.binary ?? "/bin/true"}`,
        "  endpoint:",
        `    host: ${opts.endpointHost}`,
        "    port: 8094",
        "  hostedModels:",
        "    - rel: mlx-community/Qwen3-8B-MLX-4bit",
        "  extraArgs: []",
        "  timeoutSeconds: 60",
        "",
      ].join("\n"),
    );
    return manifestPath;
  }

  // DF-02 (#275): --evict is meaningful on a ModelHost apply — the
  // manifest may act as an eviction replacement — while --force stays
  // ModelRun-only and is refused by name.
  test("C1 --force is rejected for ModelHost manifests by name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-apply-hostforce-"));
    try {
      const manifestPath = writeModelHostYaml(dir, {
        enabled: true,
        endpointHost: "127.0.0.1",
      });
      for (const extra of [["--force"], ["--evict", "victim", "--force"]]) {
        const { result: code, stderr } = await captureProcessStreams(() =>
          runApply(["-f", manifestPath, ...extra]),
        );
        expect(code).toBe(1);
        expect(stderr).toBe("apply: --force is not supported for ModelHost manifests\n");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("C2 --evict reaches the bind refusal on an enabled ModelHost", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-apply-hostevict-"));
    try {
      const manifestPath = writeModelHostYaml(dir, {
        enabled: true,
        endpointHost: "0.0.0.0",
      });
      const { result: code, stderr } = await captureProcessStreams(() =>
        runApply(["-f", manifestPath, "--evict", "victim"]),
      );
      expect(code).toBe(1);
      expect(stderr).toContain("refusing to bind ModelHost");
      expect(stderr).not.toContain("not supported for ModelHost");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("C3 --evict stamps the annotation on a ModelHost manifest", () => {
    const host: ModelHostManifest = {
      apiVersion: "llamactl/v1",
      kind: "ModelHost",
      metadata: { name: "mlx-host" },
      spec: {
        engine: "omlx",
        node: "local",
        enabled: true,
        binary: "/bin/true",
        endpoint: { host: "127.0.0.1", port: 8094 },
        hostedModels: [{ rel: "mlx-community/Qwen3-8B-MLX-4bit" }],
        extraArgs: [],
        restartPolicy: "Always",
        timeoutSeconds: 60,
      },
    };
    let out: ReturnType<typeof stampApplyAnnotations> | undefined;
    try {
      out = stampApplyAnnotations(host, { evict: ["foo", "bar"], force: false });
    } catch {
      out = undefined;
    }
    expect(out?.metadata.annotations?.["llamactl.io/evict"]).toBe("foo,bar");
  });

  // #214 + DF-02 (#275): a disabled ModelHost with --evict takes the normal
  // disabled path, so the engine spec is validated before anything is saved.
  // The fake omlx binary satisfies validateSpec's existsSync check.
  async function withIsolatedWorkloadsEnv(
    prefix: string,
    body: (dir: string) => Promise<void>,
  ): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    const envKeys = ["LLAMACTL_WORKLOADS_DIR", "DEV_STORAGE", "LOCAL_AI_RUNTIME_DIR"] as const;
    const savedEnv = new Map<string, string | undefined>(
      envKeys.map((key) => [key, process.env[key]]),
    );
    try {
      process.env["LLAMACTL_WORKLOADS_DIR"] = join(dir, "workloads");
      process.env["DEV_STORAGE"] = join(dir, "home");
      process.env["LOCAL_AI_RUNTIME_DIR"] = join(dir, "runtime");
      await body(dir);
    } finally {
      for (const [key, prev] of savedEnv) {
        if (prev === undefined) {
          Reflect.deleteProperty(process.env, key);
        } else {
          process.env[key] = prev;
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }

  function mkFakeOmlxBinary(dir: string): string {
    const binary = join(dir, "omlx");
    writeFileSync(binary, "#!/bin/sh\nexit 0\n");
    chmodSync(binary, 0o755);
    return binary;
  }

  function readSavedEvict(savedPath: string): string | undefined {
    const parsed = parseYaml(readFileSync(savedPath, "utf8")) as {
      metadata?: { annotations?: Record<string, string> };
    } | null;
    return parsed?.metadata?.annotations?.["llamactl.io/evict"];
  }

  test("C4 --evict on a disabled ModelHost the engine accepts is persisted onto the saved manifest", async () => {
    await withIsolatedWorkloadsEnv("llamactl-apply-hostevict-persist-", async (dir) => {
      const manifestPath = writeModelHostYaml(dir, {
        enabled: false,
        endpointHost: "127.0.0.1",
        binary: mkFakeOmlxBinary(dir),
      });
      const { stderr } = await captureProcessStreams(() =>
        runApply(["-f", manifestPath, "--evict", "victim"]),
      );
      expect(stderr).not.toContain("not supported for ModelHost");
      expect(stderr).not.toContain("omlx binary not found");
      const savedPath = join(dir, "workloads", "mlx-host.yaml");
      expect(existsSync(savedPath)).toBe(true);
      expect(readSavedEvict(savedPath)).toBe("victim");
    });
  });

  test("C5 an engine-refused disabled ModelHost with --evict does not replace the saved manifest", async () => {
    await withIsolatedWorkloadsEnv("llamactl-apply-hostevict-refused-", async (dir) => {
      const savedPath = join(dir, "workloads", "mlx-host.yaml");
      const acceptedPath = writeModelHostYaml(dir, {
        enabled: false,
        endpointHost: "127.0.0.1",
        binary: mkFakeOmlxBinary(dir),
      });
      await captureProcessStreams(() => runApply(["-f", acceptedPath]));
      expect(existsSync(savedPath)).toBe(true);
      const before = readFileSync(savedPath, "utf8");
      expect(readSavedEvict(savedPath)).toBeUndefined();

      const missingBinary = join(dir, "missing-omlx");
      const refusedPath = writeModelHostYaml(dir, {
        enabled: false,
        endpointHost: "127.0.0.1",
        binary: missingBinary,
      });
      const { result: code, stderr } = await captureProcessStreams(() =>
        runApply(["-f", refusedPath, "--evict", "victim"]),
      );
      expect(code).toBe(1);
      expect(stderr).toBe(
        `apply: omlx binary not found at ${missingBinary}; run tools/install-omlx-from-source.sh\n`,
      );
      expect(readFileSync(savedPath, "utf8")).toBe(before);
      expect(readSavedEvict(savedPath)).toBeUndefined();
    });
  });

  // #275 fix round: --evict must not mask a malformed raw `annotations`
  // value. Without --evict the schema rejects it; with --evict it must be
  // left untouched so the schema still rejects it and nothing is saved.
  for (const [label, lines] of [
    ["a string", ["  annotations: foo"]],
    ["null", ["  annotations: null"]],
    ["an array", ["  annotations:", "    - a"]],
  ] as const) {
    test(`C6 --evict does not mask ${label} annotations value on a ModelHost`, async () => {
      await withIsolatedWorkloadsEnv("llamactl-apply-hostevict-badann-", async (dir) => {
        const manifestPath = writeModelHostYaml(dir, {
          enabled: false,
          endpointHost: "127.0.0.1",
          binary: mkFakeOmlxBinary(dir),
          annotationsLines: [...lines],
        });
        const { result: code, stderr } = await captureProcessStreams(() =>
          runApply(["-f", manifestPath, "--evict", "victim"]),
        );
        expect(code).toBe(1);
        expect(stderr).toContain("apply: ModelHost manifest rejected:");
        expect(stderr).toContain("annotations");
        expect(existsSync(join(dir, "workloads", "mlx-host.yaml"))).toBe(false);
      });
    });
  }

  test("C7 --evict merges into a valid object annotations value on a ModelHost", async () => {
    await withIsolatedWorkloadsEnv("llamactl-apply-hostevict-mergeann-", async (dir) => {
      const manifestPath = writeModelHostYaml(dir, {
        enabled: false,
        endpointHost: "127.0.0.1",
        binary: mkFakeOmlxBinary(dir),
        annotationsLines: ["  annotations:", "    team: ml"],
      });
      const { stderr } = await captureProcessStreams(() =>
        runApply(["-f", manifestPath, "--evict", "victim"]),
      );
      expect(stderr).not.toContain("manifest rejected");
      const savedPath = join(dir, "workloads", "mlx-host.yaml");
      expect(existsSync(savedPath)).toBe(true);
      const saved = parseYaml(readFileSync(savedPath, "utf8")) as {
        metadata: { annotations?: Record<string, string> };
      };
      expect(saved.metadata.annotations).toEqual({
        team: "ml",
        "llamactl.io/evict": "victim",
      });
    });
  });
});
