import type { workloadSchema } from "@llamactl/remote";

import { describe, expect, test } from "bun:test";

import { buildMigrationWorkloadOps } from "../src/commands/supervisor.js";

describe("supervisor migration deploy wiring", () => {
  async function expectRejectsToThrow(promise: Promise<unknown>, expected: RegExp): Promise<void> {
    try {
      await promise;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toMatch(expected);
      return;
    }
    throw new Error("expected promise to reject");
  }

  function inputYaml(input: unknown): string {
    if (typeof input !== "object" || input === null || !("yaml" in input)) {
      throw new Error("expected input with yaml");
    }
    const yaml = input.yaml;
    if (typeof yaml !== "string") throw new Error("expected yaml string");
    return yaml;
  }

  function modelRun(name: string): workloadSchema.ModelRun {
    return {
      apiVersion: "llamactl/v1",
      kind: "ModelRun" as const,
      metadata: { name, labels: {}, annotations: {} },
      spec: {
        node: "m4pro",
        enabled: true,
        target: { kind: "rel" as const, value: "models/demo.gguf" },
        extraArgs: [],
        workers: [],
        restartPolicy: "Always" as const,
        gateway: false,
        allowExternalBind: false,
        timeoutSeconds: 60,
      },
    };
  }

  test("tunnel-backed deploy sends workloadApply as a mutation for local execution", async () => {
    const calls: {
      method: string;
      type: "query" | "mutation" | undefined;
      input: unknown;
    }[] = [];
    const ops = buildMigrationWorkloadOps({
      peers: [
        {
          id: "m2mini",
          endpoint: "https://m2mini.local:7843",
          tunnelPreferred: true,
          tunnelCentralUrl: "https://127.0.0.1:7843",
          tunnelCentralCertificate:
            "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
          tunnelCentralFingerprint: "sha256:test",
          tunnelRelayToken: "local-token",
        },
      ],
      loadManifestByName: modelRun,
      callViaTunnelRelay: (opts) => {
        calls.push({ method: opts.method, type: opts.type, input: opts.input });
        return Promise.resolve({ action: "unchanged" });
      },
    });

    const deployWorkload = ops.deployWorkload;
    if (deployWorkload === undefined) throw new Error("expected deployWorkload");
    await deployWorkload("model-a", "m2mini");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("workloadApply");
    expect(calls[0]?.type).toBe("mutation");
    expect(inputYaml(calls[0]?.input)).toContain("node: local");
  });

  test("one peer with missing tunnel relay config does not disable moves between configured peers", async () => {
    const calls: { method: string; nodeName: string; input: unknown }[] = [];
    const ops = buildMigrationWorkloadOps({
      peers: [
        {
          id: "bad-peer",
          endpoint: "https://bad-peer.local:7843",
          tunnelPreferred: true,
        },
        {
          id: "m2mini",
          endpoint: "https://m2mini.local:7843",
          tunnelPreferred: true,
          tunnelCentralUrl: "https://127.0.0.1:7843",
          tunnelCentralCertificate:
            "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
          tunnelCentralFingerprint: "sha256:test",
          tunnelRelayToken: "local-token",
        },
      ],
      loadManifestByName: modelRun,
      callViaTunnelRelay: (opts) => {
        calls.push({ method: opts.method, nodeName: opts.nodeName, input: opts.input });
        return Promise.resolve({});
      },
    });

    const deployWorkload = ops.deployWorkload;
    if (deployWorkload === undefined) throw new Error("expected deployWorkload");
    await deployWorkload("model-a", "m2mini");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.nodeName).toBe("m2mini");
  });

  test("move to peer with missing tunnel relay config fails with distinct reason", async () => {
    const ops = buildMigrationWorkloadOps({
      peers: [
        {
          id: "bad-peer",
          endpoint: "https://bad-peer.local:7843",
          tunnelPreferred: true,
        },
      ],
      loadManifestByName: () => {
        throw new Error("should not load manifest before relay validation");
      },
      callViaTunnelRelay: () => Promise.resolve({}),
    });

    const deployWorkload = ops.deployWorkload;
    if (deployWorkload === undefined) throw new Error("expected deployWorkload");
    await expectRejectsToThrow(
      deployWorkload("model-a", "bad-peer"),
      /tunnel relay config incomplete/i,
    );
  });

  test("removeWorkload deletes the source workload instead of applying a disabled manifest", async () => {
    const calls: { kind: "apply" | "delete"; input: unknown }[] = [];
    const ops = buildMigrationWorkloadOps({
      peers: [{ id: "m4pro", endpoint: "https://m4pro.local:7843" }],
      loadManifestByName: modelRun,
      getNodeClientByName: () =>
        ({
          workloadApply: {
            mutate: (input: unknown) => {
              calls.push({ kind: "apply", input });
              return Promise.resolve({});
            },
          },
          workloadDelete: {
            mutate: (input: unknown) => {
              calls.push({ kind: "delete", input });
              return Promise.resolve({ ok: true });
            },
          },
        }) as never,
    });

    const removeWorkload = ops.removeWorkload;
    if (removeWorkload === undefined) throw new Error("expected removeWorkload");
    await removeWorkload("model-a", "m4pro");

    expect(calls).toEqual([{ kind: "delete", input: { name: "model-a" } }]);
  });

  test("deployWorkload rejects ModelHost moves until they are durable", async () => {
    const ops = buildMigrationWorkloadOps({
      peers: [{ id: "m2mini", endpoint: "https://m2mini.local:7843" }],
      loadManifestByName: (name) =>
        ({
          apiVersion: "llamactl/v1",
          kind: "ModelHost",
          metadata: { name },
          spec: { node: "m4pro", engine: "llama.cpp", hostedModels: [] },
        }) as never,
      getNodeClientByName: () =>
        ({
          workloadApply: {
            mutate: () => Promise.reject(new Error("should not apply ModelHost")),
          },
        }) as never,
    });

    const deployWorkload = ops.deployWorkload;
    if (deployWorkload === undefined) throw new Error("expected deployWorkload");
    await expectRejectsToThrow(
      deployWorkload("host-a", "m2mini"),
      /ModelHost moves are not supported/i,
    );
  });

  test("direct deploy call rejects when the node client hangs", async () => {
    const ops = buildMigrationWorkloadOps({
      peers: [{ id: "m2mini", endpoint: "https://m2mini.local:7843" }],
      loadManifestByName: modelRun,
      callTimeoutMs: 5,
      getNodeClientByName: () =>
        ({
          workloadApply: {
            mutate: () => new Promise<never>(() => undefined),
          },
        }) as never,
    });

    const deployWorkload = ops.deployWorkload;
    if (deployWorkload === undefined) throw new Error("expected deployWorkload");
    await expectRejectsToThrow(deployWorkload("model-a", "m2mini"), /timed out/i);
  });
});
