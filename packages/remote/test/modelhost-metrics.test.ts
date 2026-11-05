// RED pins for frozename/llamactl#196: /metrics must expose per-ModelHost
// restart and OOM-kill series read from modelhost.conditions.json sidecars,
// labelled by workload and node, omitting hosts without a sidecar.
import { recordModelHostOomKill, recordModelHostRestart } from "@llamactl/core/engines/conditions";
import { resolveEnv } from "@llamactl/core/env";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";
import * as metricsModule from "../src/server/metrics.js";

const NOW = new Date("2026-11-05T12:00:00.000Z");

const resetNodeOverride = (): void =>
  (
    metricsModule as unknown as { setModelHostMetricsNode?: (n: string | null) => void }
  ).setModelHostMetricsNode?.(null);

describe("modelhost metrics", () => {
  let tmp = "";
  let savedEnv: NodeJS.ProcessEnv = {};

  const workloadDir = (name: string): string => join(tmp, "workloads", name);

  const scrape = (): Promise<string> => metricsModule.registry.metrics();

  beforeEach(() => {
    savedEnv = { ...process.env };
    tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-metrics-"));
    process.env["LOCAL_AI_RUNTIME_DIR"] = tmp;
    process.env["LLAMACTL_NODE_NAME"] = "z13";
    // Pins the profile so resolveEnv skips the sysctl memory probe.
    process.env["LLAMA_CPP_MACHINE_PROFILE"] = "balanced";
    resetNodeOverride();
  });

  afterEach(() => {
    resetNodeOverride();
    for (const key of Object.keys(process.env)) Reflect.deleteProperty(process.env, key);
    Object.assign(process.env, savedEnv);
    if (tmp !== "") rmSync(tmp, { recursive: true, force: true });
  });

  test("exposes the restart count per ModelHost labelled by workload and node", async () => {
    const resolved = resolveEnv(process.env);
    recordModelHostRestart({ name: "seat-a" }, "EngineExited", resolved, NOW);
    recordModelHostRestart({ name: "seat-a" }, "EngineExited", resolved, NOW);
    recordModelHostRestart({ name: "seat-a" }, "EngineExited", resolved, NOW);

    const text = await scrape();
    expect(text).toMatch(
      /^llamactl_modelhost_restarts\{(?=[^}]*workload="seat-a")(?=[^}]*node="z13")[^}]*\} 3$/m,
    );
  });

  test("exposes the OOM-kill count and the cgroup oom_kill counter from the OOMKilled condition", async () => {
    const resolved = resolveEnv(process.env);
    recordModelHostOomKill({ name: "seat-a" }, 2, resolved, NOW);
    recordModelHostOomKill({ name: "seat-a" }, 5, resolved, NOW);

    const text = await scrape();
    expect(text).toMatch(
      /^llamactl_modelhost_oom_kills\{(?=[^}]*workload="seat-a")(?=[^}]*node="z13")[^}]*\} 2$/m,
    );
    expect(text).toMatch(
      /^llamactl_modelhost_cgroup_oom_kill\{(?=[^}]*workload="seat-a")(?=[^}]*node="z13")[^}]*\} 5$/m,
    );
  });

  test("omits a ModelHost with no conditions sidecar instead of emitting 0", async () => {
    const resolved = resolveEnv(process.env);
    const plainDir = workloadDir("plain-run");
    mkdirSync(plainDir, { recursive: true });
    writeFileSync(join(plainDir, "llama-server.pid"), `${String(process.pid)}\n`);
    recordModelHostRestart({ name: "seat-a" }, "EngineExited", resolved, NOW);

    const text = await scrape();
    expect(text).toMatch(
      /^llamactl_modelhost_restarts\{(?=[^}]*workload="seat-a")(?=[^}]*node="z13")[^}]*\} 1$/m,
    );
    expect(text).not.toContain('workload="plain-run"');
  });

  test("omits OOM series when no OOMKilled condition was recorded", async () => {
    const resolved = resolveEnv(process.env);
    recordModelHostRestart({ name: "seat-b" }, "EngineExited", resolved, NOW);

    const text = await scrape();
    expect(text).toMatch(
      /^llamactl_modelhost_restarts\{(?=[^}]*workload="seat-b")(?=[^}]*node="z13")[^}]*\} 1$/m,
    );
    expect(text).not.toMatch(/^llamactl_modelhost_oom_kills\{(?=[^}]*workload="seat-b")[^}]*\}/m);
    expect(text).not.toMatch(
      /^llamactl_modelhost_cgroup_oom_kill\{(?=[^}]*workload="seat-b")[^}]*\}/m,
    );
  });

  test("omits the cgroup counter when the OOMKilled condition has none", async () => {
    const dir = workloadDir("seat-c");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "modelhost.conditions.json"),
      `${JSON.stringify(
        {
          conditions: [
            {
              type: "OOMKilled",
              status: "True",
              reason: "CgroupOOMKill",
              message: "engine was OOM-killed",
              firstSeen: NOW.toISOString(),
              lastSeen: NOW.toISOString(),
              lastTransitionTime: NOW.toISOString(),
              count: 1,
            },
          ],
          restarts: 0,
          lastRestartAt: null,
          lastRestartReason: null,
        },
        null,
        2,
      )}\n`,
    );

    const text = await scrape();
    expect(text).toMatch(
      /^llamactl_modelhost_oom_kills\{(?=[^}]*workload="seat-c")(?=[^}]*node="z13")[^}]*\} 1$/m,
    );
    expect(text).not.toMatch(
      /^llamactl_modelhost_cgroup_oom_kill\{(?=[^}]*workload="seat-c")[^}]*\}/m,
    );
  });

  test("reflects the sidecar at scrape time", async () => {
    const resolved = resolveEnv(process.env);
    recordModelHostRestart({ name: "seat-a" }, "EngineExited", resolved, NOW);

    let text = await scrape();
    expect(text).toMatch(
      /^llamactl_modelhost_restarts\{(?=[^}]*workload="seat-a")(?=[^}]*node="z13")[^}]*\} 1$/m,
    );

    recordModelHostRestart({ name: "seat-a" }, "EngineExited", resolved, NOW);
    text = await scrape();
    expect(text).toMatch(
      /^llamactl_modelhost_restarts\{(?=[^}]*workload="seat-a")(?=[^}]*node="z13")[^}]*\} 2$/m,
    );

    rmSync(workloadDir("seat-a"), { recursive: true, force: true });
    text = await scrape();
    expect(text).not.toContain('workload="seat-a"');
  });
});
