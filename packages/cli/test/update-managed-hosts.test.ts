import type { LocalRoute } from "@llamactl/core/workloadRuntime";

import { describe, expect, test } from "bun:test";

import * as updateDeps from "../src/commands/update/deps.js";

describe("managedHostsFromRoutes", () => {
  test("groups routes by workload, sorts them, and carries declared readiness", () => {
    expect(typeof updateDeps.managedHostsFromRoutes).toBe("function");

    const readiness = {
      path: "/ready",
      expectStatus: 200,
      expectJson: { status: "ready" },
    } as const;
    const routes: LocalRoute[] = [
      {
        workload: "b",
        model: "m1",
        host: "127.0.0.1",
        port: 8080,
        engine: "llamacpp",
        kind: "ModelHost",
        pid: 1234,
        readiness,
      },
      {
        workload: "b",
        model: "m2",
        host: "127.0.0.1",
        port: 8080,
        engine: "llamacpp",
        kind: "ModelHost",
        pid: 1234,
        readiness,
      },
      {
        workload: "a",
        model: "m0",
        host: "127.0.0.1",
        port: 8081,
        engine: "llamacpp",
        kind: "ModelRun",
        pid: 5678,
      },
    ];

    const out = updateDeps.managedHostsFromRoutes(routes);
    expect(out).toStrictEqual([
      { name: "a", kind: "ModelRun", pid: 5678, host: "127.0.0.1", port: 8081 },
      {
        name: "b",
        kind: "ModelHost",
        pid: 1234,
        host: "127.0.0.1",
        port: 8080,
        readiness: { path: "/ready", expectStatus: 200, expectJson: { status: "ready" } },
      },
    ]);
    expect("readiness" in out[0]!).toBe(false);
  });

  test("an empty route list yields no managed hosts", () => {
    expect(typeof updateDeps.managedHostsFromRoutes).toBe("function");
    expect(updateDeps.managedHostsFromRoutes([])).toStrictEqual([]);
  });
});
