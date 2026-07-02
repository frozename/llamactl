import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "../src/safe-fs.js";

const BIN = join(import.meta.dir, "../src/bin.ts");
const FAKE_SERVER = join(import.meta.dir, "fixtures", "fake-llama-server.sh");

function buildWorkloadYaml(binaryPath: string, modelRel = "test/fake-model.gguf"): string {
  return [
    "apiVersion: llamactl/v1",
    "kind: ModelRun",
    "metadata:",
    "  name: test-measure-workload",
    "  labels: {}",
    "spec:",
    "  node: local",
    "  enabled: true",
    `  binary: "${binaryPath}"`,
    "  resources:",
    "    expectedMemoryGiB: 2",
    "  target:",
    "    kind: rel",
    `    value: ${modelRel}`,
    "  extraArgs: []",
    "  restartPolicy: Always",
    "  endpoint:",
    "    host: 127.0.0.1",
    "    port: 18001",
  ].join("\n");
}

function shouldSkipCommandForLiveRun(status: number | null, stderr: string): boolean {
  if (status === 0) return false;
  const lower = stderr.toLowerCase();
  return (
    lower.includes("python3") ||
    lower.includes("no free port found") ||
    lower.includes("operation not permitted") ||
    lower.includes("eperm")
  );
}

describe("llamactl admit measure", () => {
  let tmpDir: string;
  let cachePath: string;
  let yamlPath: string;

  beforeEach(() => {
    // Ensure fake binary is executable.
    chmodSync(FAKE_SERVER, 0o755);

    tmpDir = mkdtempSync(join(tmpdir(), "admit-measure-test-"));
    cachePath = join(tmpDir, "measured-memory.json");
    yamlPath = join(tmpDir, "test-workload.yaml");
    writeFileSync(yamlPath, buildWorkloadYaml(FAKE_SERVER));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("exits 2 for --port with non-numeric value", () => {
    const r = spawnSync("bun", [BIN, "admit", "measure", yamlPath, "--port=abc"], {
      encoding: "utf8",
      env: { ...process.env, LLAMACTL_MEASURED_MEMORY_PATH: cachePath },
      timeout: 10_000,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/invalid.*port/i);
  });

  test("exits 2 for --port with negative value", () => {
    const r = spawnSync("bun", [BIN, "admit", "measure", yamlPath, "--port=-1"], {
      encoding: "utf8",
      env: { ...process.env, LLAMACTL_MEASURED_MEMORY_PATH: cachePath },
      timeout: 10_000,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/invalid.*port/i);
  });

  test("exits 2 for path traversal workload name (..) with validation message", () => {
    const r = spawnSync("bun", [BIN, "admit", "measure", "../../../etc/passwd"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/invalid workload name/i);
  });

  test("exits 2 for workload name containing path separator with validation message", () => {
    const r = spawnSync("bun", [BIN, "admit", "measure", "foo/bar"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/invalid workload name/i);
  });

  test("exits 2 for a workload name that resolves to a missing yaml", () => {
    const r = spawnSync("bun", [BIN, "admit", "measure", "nonexistent-workload-xyz-abc"], {
      encoding: "utf8",
      env: { ...process.env, LLAMACTL_MEASURED_MEMORY_PATH: cachePath },
      timeout: 10_000,
    });
    expect(r.status).toBe(2);
  });

  test("exits 2 for an unsupported manifest kind", () => {
    const badYaml = join(tmpDir, "bad.yaml");
    writeFileSync(
      badYaml,
      "apiVersion: llamactl/v1\nkind: NodeRun\nmetadata:\n  name: bad\nspec: {}\n",
    );
    const r = spawnSync("bun", [BIN, "admit", "measure", badYaml], {
      encoding: "utf8",
      env: { ...process.env, LLAMACTL_MEASURED_MEMORY_PATH: cachePath },
      timeout: 10_000,
    });
    expect(r.status).toBe(2);
  });

  test("writes cache with expected fields after successful measurement", () => {
    const pythonCheck = spawnSync("python3", ["--version"], { encoding: "utf8" });
    if (shouldSkipCommandForLiveRun(pythonCheck.status, pythonCheck.stderr)) {
      console.warn("admit-measure: python3 unavailable — skipping live-server test");
      return;
    }

    const r = spawnSync(
      "bun",
      [BIN, "admit", "measure", yamlPath, "--steady-state-seconds=4", "--samples=2"],
      {
        encoding: "utf8",
        env: { ...process.env, LLAMACTL_MEASURED_MEMORY_PATH: cachePath },
        timeout: 45_000,
      },
    );

    if (shouldSkipCommandForLiveRun(r.status, r.stderr)) {
      console.warn("admit-measure: python3 unavailable — skipping live-server test");
      return;
    }

    expect(r.status).toBe(0);

    const cache = JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, unknown>;
    const entry = cache["test/fake-model.gguf::"] as Record<string, unknown> | undefined;
    expect(entry).toBeDefined();
    expect(entry!["workloadName"]).toBe("test-measure-workload");
    expect(entry!["engineKind"]).toBe("llama.cpp");
    expect(typeof entry!["rssPeakMb"]).toBe("number");
    expect(entry!["rssPeakMb"] as number).toBeGreaterThan(0);
    expect(typeof entry!["rssMeanMb"]).toBe("number");
    expect(typeof entry!["sampleCount"]).toBe("number");
    expect(entry!["sampleCount"] as number).toBeGreaterThanOrEqual(1);
    expect(typeof entry!["measuredAt"]).toBe("string");
    expect(entry!["binary"]).toBe(FAKE_SERVER);
  }, 50_000);

  test("all concurrent invocations complete successfully", async () => {
    const pythonCheck = spawnSync("python3", ["--version"], { encoding: "utf8" });
    if (shouldSkipCommandForLiveRun(pythonCheck.status, pythonCheck.stderr)) {
      console.warn("admit-measure: python3 unavailable — skipping concurrent live-server test");
      return;
    }

    const run = (i: number): Promise<{ status: number | null; stderr: string }> =>
      new Promise((resolve) => {
        const child = spawn(
          "bun",
          [BIN, "admit", "measure", yamlPath, "--steady-state-seconds=1", "--samples=1"],
          {
            env: {
              ...process.env,
              LLAMACTL_MEASURED_MEMORY_PATH: join(tmpDir, `measured-memory-${String(i)}.json`),
            },
            stdio: ["ignore", "ignore", "pipe"],
          },
        );

        let stderr = "";
        child.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });
        child.on("close", (status) => {
          resolve({ status, stderr });
        });
      });

    const inner = await Promise.all([run(0), run(1), run(2)]);
    for (const item of inner) {
      if (shouldSkipCommandForLiveRun(item.status, item.stderr)) {
        console.warn("admit-measure: python3 unavailable — skipping concurrent live-server test");
        return;
      }
      if (item.status !== 0) {
        console.error(`admit measure concurrent run failed (status=${String(item.status)}):`);
        console.error(item.stderr);
      }
      expect(item.status).toBe(0);
    }
  }, 60_000);
});
