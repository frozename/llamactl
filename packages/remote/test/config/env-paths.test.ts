import { defaultAgentConfigPath } from "@llamactl/core/config/agent-config";
import { defaultConfigPath } from "@llamactl/core/config/kubeconfig";
import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

import { defaultScheduleFilePath } from "../../src/bench/schedule.js";
import { defaultArtifactsDir } from "../../src/server/artifacts.js";
import { defaultWorkloadsDir } from "../../src/workload/store.js";

describe("env-derived config paths", () => {
  test("empty DEV_STORAGE falls back like unset for kubeconfig and agent config", () => {
    const unsetEnv = {} as NodeJS.ProcessEnv;
    const expectedConfigPath = defaultConfigPath(unsetEnv);
    const expectedAgentConfigPath = defaultAgentConfigPath(unsetEnv);
    expect(expectedConfigPath).toBe(join(homedir(), ".llamactl", "config"));
    expect(expectedAgentConfigPath).toBe(join(homedir(), ".llamactl", "agent.yaml"));

    for (const DEV_STORAGE of ["", "   "]) {
      const env = { DEV_STORAGE } as NodeJS.ProcessEnv;

      expect(defaultConfigPath(env)).toBe(expectedConfigPath);
      expect(defaultAgentConfigPath(env)).toBe(expectedAgentConfigPath);
    }
  });

  test("empty DEV_STORAGE falls back like unset for workloads, artifacts, and bench schedules", () => {
    const unsetEnv = {} as NodeJS.ProcessEnv;
    const expectedWorkloadsDir = defaultWorkloadsDir(unsetEnv);
    const expectedArtifactsDir = defaultArtifactsDir(unsetEnv);
    const expectedSchedulePath = defaultScheduleFilePath(unsetEnv);
    expect(expectedWorkloadsDir).toBe(join(homedir(), ".llamactl", "workloads"));
    expect(expectedArtifactsDir).toBe(join(homedir(), ".llamactl", "artifacts"));
    expect(expectedSchedulePath).toBe(join(homedir(), ".llamactl", "bench-schedules.yaml"));

    for (const DEV_STORAGE of ["", "   "]) {
      const env = { DEV_STORAGE } as NodeJS.ProcessEnv;

      expect(defaultWorkloadsDir(env)).toBe(expectedWorkloadsDir);
      expect(defaultArtifactsDir(env)).toBe(expectedArtifactsDir);
      expect(defaultScheduleFilePath(env)).toBe(expectedSchedulePath);
    }
  });
});
