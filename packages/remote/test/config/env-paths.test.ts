import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

import { defaultAgentConfigPath } from "../../src/config/agent-config.js";
import { defaultConfigPath } from "../../src/config/kubeconfig.js";

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
});
