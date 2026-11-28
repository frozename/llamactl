import type { WorkloadTarget } from "@llamactl/fleet-supervisor";
import type { NodeClient } from "@llamactl/remote";

import { config, configSchema, modelHostStore } from "@llamactl/remote";
import { expect, test } from "bun:test";
import { join } from "node:path";

import { readSupervisorRecordedSleep } from "../src/commands/supervisor.js";
import { __resetTestSeams, __setTestSeams } from "../src/dispatcher.js";
import { makeTempRuntime } from "./helpers.js";

const ENDPOINT = "http://127.0.0.1:8090";

test("supervisor accepts endpoint-bound sleep only from the matching direct manifest owner", async () => {
  const runtime = makeTempRuntime();
  const workloadDir = join(runtime.devStorage, "workloads");
  const env = { ...runtime.env, LLAMACTL_WORKLOADS_DIR: workloadDir };
  const nodes = [
    { name: "matching", endpoint: "https://127.0.0.1:7443", kind: "agent" },
    { name: "parked", endpoint: "https://127.0.0.1:7443", kind: "agent" },
    { name: "different", endpoint: "https://127.0.0.2:7443", kind: "agent" },
    { name: "dns", endpoint: "https://sleep-test.local:7443", kind: "agent" },
    { name: "ipv6", endpoint: "https://[::1]:7443", kind: "agent" },
    { name: "tunnel", endpoint: "https://127.0.0.1:7443", kind: "agent", tunnelPreferred: true },
  ] as const;
  const cfg = nodes.reduce(
    (configEntry, node) =>
      config.upsertNode(configEntry, config.currentContext(configEntry).cluster, { ...node }),
    configSchema.freshConfig(),
  );
  const calls: { workload: string; probeOrigin?: string }[] = [];
  let proof: "sleeping" | "sleep-pending" | undefined = "sleeping";
  let parked: true | string | undefined = true;
  const client = {
    modelHostStatus: {
      query: (request: { workload: string; probeOrigin?: string }): Promise<unknown> => {
        calls.push(request);
        if (request.workload === "parked") {
          return Promise.resolve({
            state: "Running",
            ...(parked === undefined ? {} : { probeParked: parked }),
          });
        }
        return Promise.resolve({ state: "Running", sleep: "sleeping", probeSleep: proof });
      },
    },
  } as unknown as NodeClient;
  __setTestSeams({ config: cfg, nodeClient: client });

  try {
    const addresses: Record<string, string> = { dns: "sleep-test.local", ipv6: "::1" };
    for (const node of [
      "matching",
      "parked",
      "different",
      "tunnel",
      "local",
      "dns",
      "ipv6",
    ] as const) {
      modelHostStore.saveModelHost(
        {
          kind: "ModelHost",
          apiVersion: "llamactl/v1",
          metadata: { name: node },
          spec: {
            engine: node === "parked" ? "omlx" : "llamacpp",
            binary: "/usr/bin/true",
            node,
            enabled: true,
            endpoint: {
              host: addresses[node] ?? "127.0.0.1",
              port: 8090,
            },
            hostedModels: [{ rel: "model.gguf" }],
            extraArgs: [],
            restartPolicy: "Always",
            timeoutSeconds: 60,
          },
        },
        workloadDir,
      );
    }
    const target: WorkloadTarget = { kind: "ModelHost", name: "matching", endpoint: ENDPOINT };
    expect(await readSupervisorRecordedSleep(target, env)).toBe("sleeping");
    expect(calls).toEqual([{ workload: "matching", probeOrigin: ENDPOINT }]);

    proof = undefined;
    expect(await readSupervisorRecordedSleep(target, env)).toBeUndefined();
    expect(calls).toHaveLength(2);
    proof = "sleep-pending";
    expect(await readSupervisorRecordedSleep(target, env)).toBe("sleep-pending");
    expect(calls).toHaveLength(3);

    for (const name of ["different", "tunnel", "local"]) {
      expect(await readSupervisorRecordedSleep({ ...target, name }, env)).toBeUndefined();
    }
    expect(
      await readSupervisorRecordedSleep({ ...target, endpoint: "http://127.0.0.1:8091" }, env),
    ).toBeUndefined();
    expect(
      await readSupervisorRecordedSleep({ ...target, endpoint: `${ENDPOINT}/proxy` }, env),
    ).toBeUndefined();
    expect(await readSupervisorRecordedSleep({ ...target, kind: "ModelRun" }, env)).toBeUndefined();
    expect(
      await readSupervisorRecordedSleep(
        { ...target, name: "dns", endpoint: "http://sleep-test.local:8090" },
        env,
      ),
    ).toBeUndefined();
    expect(calls).toHaveLength(3);
    expect(
      await readSupervisorRecordedSleep(
        { ...target, name: "ipv6", endpoint: "http://[::1]:8090" },
        env,
      ),
    ).toBe("sleep-pending");
    expect(calls.at(-1)).toEqual({ workload: "ipv6", probeOrigin: "http://[::1]:8090" });

    expect(await readSupervisorRecordedSleep({ ...target, name: "parked" }, env)).toBe("parked");
    expect(calls.at(-1)).toEqual({ workload: "parked", probeOrigin: ENDPOINT });
    parked = undefined;
    expect(await readSupervisorRecordedSleep({ ...target, name: "parked" }, env)).toBeUndefined();
    parked = "unverified";
    expect(await readSupervisorRecordedSleep({ ...target, name: "parked" }, env)).toBeUndefined();
  } finally {
    __resetTestSeams();
    runtime.cleanup();
  }
});
