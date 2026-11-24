// Part of #520 — RED tests for the supervisor migration source-removal
// stop-fence refusal. deleteFromNode discards the workloadDelete result at
// this base, so a node that refuses the source stop (SessionsActive /
// SessionsUnknown / pid-identity) looks like a completed removal and the
// move finishes with the workload still running on the source. The fix must
// reject with `workloadDelete on <node> did not remove <workload>: <error>`
// whenever the procedure resolves ok:false carrying an error, on both the
// direct-client and tunnel-relay paths, while still resolving for ok:true
// and for ok:false without an error (the manifest already vanished) and
// propagating transport rejections unchanged. Everything is hermetic:
// injected peers, manifest loader, node client and tunnel relay — no
// network, processes, sleeps or live state. At base the refusal cases fail
// BY ASSERTION (the helper's "expected promise to reject"); the guard cases
// pass on base and on the fix.
import type { workloadSchema } from "@llamactl/remote";

import { describe, expect, test } from "bun:test";

import { buildMigrationWorkloadOps } from "../src/commands/supervisor.js";

describe("supervisor migration source stop-fence refusal", () => {
  async function expectRejectsToThrow(promise: Promise<unknown>, expected: string): Promise<void> {
    try {
      await promise;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toBe(expected);
      return;
    }
    throw new Error("expected promise to reject");
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

  test("R1: removeWorkload rejects when the direct workloadDelete refuses with SessionsActive", async () => {
    const ops = buildMigrationWorkloadOps({
      peers: [{ id: "m4pro", endpoint: "https://m4pro.local:7843" }],
      loadManifestByName: modelRun,
      getNodeClientByName: () =>
        ({
          workloadDelete: {
            mutate: () =>
              Promise.resolve({
                ok: false,
                name: "model-a",
                stops: [],
                error: "serverStop on m4pro refused (SessionsActive: s1); manifest preserved",
              }),
          },
        }) as never,
    });

    const removeWorkload = ops.removeWorkload;
    if (removeWorkload === undefined) throw new Error("expected removeWorkload");
    await expectRejectsToThrow(
      removeWorkload("model-a", "m4pro"),
      "workloadDelete on m4pro did not remove model-a: serverStop on m4pro refused (SessionsActive: s1); manifest preserved",
    );
  });

  test("R2: removeWorkload rejects when the tunnel-relay workloadDelete refuses with SessionsUnknown", async () => {
    const methods: string[] = [];
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
        methods.push(opts.method);
        return Promise.resolve({
          ok: false,
          name: "model-a",
          stops: [],
          error: "serverStop on m2mini refused (SessionsUnknown: ); manifest preserved",
        });
      },
    });

    const removeWorkload = ops.removeWorkload;
    if (removeWorkload === undefined) throw new Error("expected removeWorkload");
    await expectRejectsToThrow(
      removeWorkload("model-a", "m2mini"),
      "workloadDelete on m2mini did not remove model-a: serverStop on m2mini refused (SessionsUnknown: ); manifest preserved",
    );
    expect(methods).toEqual(["workloadDelete"]);
  });

  test("R3: removeWorkload rejects on a pid-identity stop refusal", async () => {
    const ops = buildMigrationWorkloadOps({
      peers: [{ id: "m4pro", endpoint: "https://m4pro.local:7843" }],
      loadManifestByName: modelRun,
      getNodeClientByName: () =>
        ({
          workloadDelete: {
            mutate: () =>
              Promise.resolve({
                ok: false,
                name: "model-a",
                stops: [],
                error:
                  "serverStop on m4pro refused (pid identity unverifiable); manifest preserved",
              }),
          },
        }) as never,
    });

    const removeWorkload = ops.removeWorkload;
    if (removeWorkload === undefined) throw new Error("expected removeWorkload");
    await expectRejectsToThrow(
      removeWorkload("model-a", "m4pro"),
      "workloadDelete on m4pro did not remove model-a: serverStop on m4pro refused (pid identity unverifiable); manifest preserved",
    );
  });

  test("G1: removeWorkload resolves when workloadDelete stops the workload", async () => {
    const calls: unknown[] = [];
    const ops = buildMigrationWorkloadOps({
      peers: [{ id: "m4pro", endpoint: "https://m4pro.local:7843" }],
      loadManifestByName: modelRun,
      getNodeClientByName: () =>
        ({
          workloadDelete: {
            mutate: (input: unknown) => {
              calls.push(input);
              return Promise.resolve({
                ok: true,
                name: "model-a",
                stops: ["stopped llama-server on m4pro"],
              });
            },
          },
        }) as never,
    });

    const removeWorkload = ops.removeWorkload;
    if (removeWorkload === undefined) throw new Error("expected removeWorkload");
    await removeWorkload("model-a", "m4pro");
    expect(calls).toEqual([{ name: "model-a" }]);
  });

  test("G2: removeWorkload resolves when workloadDelete reports ok:false without an error", async () => {
    const ops = buildMigrationWorkloadOps({
      peers: [{ id: "m4pro", endpoint: "https://m4pro.local:7843" }],
      loadManifestByName: modelRun,
      getNodeClientByName: () =>
        ({
          workloadDelete: {
            mutate: () => Promise.resolve({ ok: false, name: "model-a", stops: [] }),
          },
        }) as never,
    });

    const removeWorkload = ops.removeWorkload;
    if (removeWorkload === undefined) throw new Error("expected removeWorkload");
    await removeWorkload("model-a", "m4pro");
  });

  test("G3: removeWorkload propagates a workloadDelete transport failure unchanged", async () => {
    const ops = buildMigrationWorkloadOps({
      peers: [{ id: "m4pro", endpoint: "https://m4pro.local:7843" }],
      loadManifestByName: modelRun,
      getNodeClientByName: () =>
        ({
          workloadDelete: {
            mutate: () => Promise.reject(new Error("ECONNREFUSED")),
          },
        }) as never,
    });

    const removeWorkload = ops.removeWorkload;
    if (removeWorkload === undefined) throw new Error("expected removeWorkload");
    await expectRejectsToThrow(removeWorkload("model-a", "m4pro"), "ECONNREFUSED");
  });
});
