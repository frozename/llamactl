import type { ModelHostManifest } from "@llamactl/remote/workload/modelhost-schema";

import { describe, expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { externallyManagedRefusal, parseFlags, runController } from "../src/commands/controller.js";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

function labeledHost(name: string, manager: string, port: number): ModelHostManifest {
  return {
    apiVersion: "llamactl/v1",
    kind: "ModelHost",
    metadata: { name, labels: { "llamactl.io/managed-by": manager } },
    spec: {
      engine: "omlx",
      node: "local",
      enabled: true,
      binary: "/usr/bin/true",
      endpoint: { host: "127.0.0.1", port },
      hostedModels: [{ rel: "mlx-community/host" }],
      extraArgs: [],
      restartPolicy: "Always",
      timeoutSeconds: 60,
    },
  };
}

function unlabeledHost(name: string, port: number): ModelHostManifest {
  const host = labeledHost(name, "mac-mini", port);
  return { ...host, metadata: { name } };
}

describe("controller parseFlags --force", () => {
  test("defaults force to false", () => {
    const r = parseFlags([]);
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.force).toBe(false);
  });

  test("--force sets it true", () => {
    const r = parseFlags(["--force"]);
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.force).toBe(true);
  });

  test("coexists with --once", () => {
    const r = parseFlags(["--force", "--once"]);
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.force).toBe(true);
    expect(r.once).toBe(true);
  });
});

describe("externallyManagedRefusal", () => {
  test("returns null for an empty store", () => {
    expect(externallyManagedRefusal([])).toBeNull();
  });

  test("returns null when no host is labeled", () => {
    expect(externallyManagedRefusal([unlabeledHost("host-a", 18191)])).toBeNull();
  });

  test("names the host and its manager for one labeled host", () => {
    const message = externallyManagedRefusal([labeledHost("host-a", "mac-mini", 18192)]);
    expect(message).not.toBeNull();
    expect(message).toContain("refusing to start");
    expect(message).toContain("modelhost/host-a");
    expect(message).toContain("mac-mini");
    expect(message).toContain("llamactl.io/managed-by");
    expect(message).toContain("--force");
  });

  test("names every labeled host when two are present", () => {
    const message = externallyManagedRefusal([
      labeledHost("host-a", "mac-mini", 18193),
      labeledHost("host-b", "gpu-central", 18194),
    ]);
    expect(message).not.toBeNull();
    expect(message).toContain("modelhost/host-a");
    expect(message).toContain("mac-mini");
    expect(message).toContain("modelhost/host-b");
    expect(message).toContain("gpu-central");
  });
});

describe("runController managed-by refusal", () => {
  const LABELED_YAML = `apiVersion: llamactl/v1
kind: ModelHost
metadata:
  name: host-managed
  labels:
    llamactl.io/managed-by: mac-mini
spec:
  engine: omlx
  node: local
  enabled: false
  binary: /usr/bin/true
  endpoint:
    host: 127.0.0.1
    port: 18199
  hostedModels:
    - rel: mlx-community/host
  extraArgs: []
  restartPolicy: Always
  timeoutSeconds: 60
`;

  function withWorkloadsDir(
    body: (dir: string, stderr: () => string, stdout: () => string) => Promise<void>,
  ): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-controller-managed-by-"));
    writeFileSync(join(dir, "host-managed.yaml"), LABELED_YAML);
    const previous = process.env["LLAMACTL_WORKLOADS_DIR"];
    const errChunks: string[] = [];
    const outChunks: string[] = [];
    const errSpy = spyOn(process.stderr, "write").mockImplementation((chunk) => {
      errChunks.push(String(chunk));
      return true;
    });
    const outSpy = spyOn(process.stdout, "write").mockImplementation((chunk) => {
      outChunks.push(String(chunk));
      return true;
    });
    process.env["LLAMACTL_WORKLOADS_DIR"] = dir;
    return body(
      dir,
      () => errChunks.join(""),
      () => outChunks.join(""),
    ).finally(() => {
      errSpy.mockRestore();
      outSpy.mockRestore();
      if (previous === undefined) delete process.env["LLAMACTL_WORKLOADS_DIR"];
      else process.env["LLAMACTL_WORKLOADS_DIR"] = previous;
      rmSync(dir, { recursive: true, force: true });
    });
  }

  test("serve --once refuses a labeled store before taking the lock", async () => {
    await withWorkloadsDir(async (dir, stderr) => {
      const code = await runController(["serve", "--once"]);
      expect(code).toBe(1);
      const output = stderr();
      expect(output).toContain("modelhost/host-managed");
      expect(output).toContain("mac-mini");
      expect(output).toContain("--force");
      expect(existsSync(join(dir, ".controller.lock"))).toBe(false);
    });
  });

  test("--force starts anyway and the labeled host stays skipped by the reconciler", async () => {
    await withWorkloadsDir(async (_dir, stderr, stdout) => {
      const code = await runController(["serve", "--once", "--force"]);
      expect(code).toBe(0);
      expect(stderr()).not.toContain("refusing to start");
      expect(stdout()).toContain("modelhost/host-managed");
      expect(stdout()).toContain("skipped-external");
    });
  });
});
