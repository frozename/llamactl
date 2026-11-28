import { agentConfig } from "@llamactl/remote";
import { afterAll, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildServeOptions, parseServeFlags, type ServeFlags } from "../src/commands/agent.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";

const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-engine-scope-"));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const idleWiring = {
  dialUrl: undefined,
  dialBearer: undefined,
  tunnelCentralOn: false,
  tunnelCentralBearer: undefined,
};

function seedConfig(dir: string): agentConfig.AgentConfig {
  const config: agentConfig.AgentConfig = {
    apiVersion: "llamactl/v1",
    kind: "AgentConfig",
    bindHost: "127.0.0.1",
    port: 7843,
    certPath: join(dir, "agent.crt"),
    keyPath: join(dir, "agent.key"),
    tokenHash: "a".repeat(64),
    fingerprint: `sha256:${"b".repeat(64)}`,
  };
  agentConfig.saveAgentConfig(config, join(dir, "agent.yaml"));
  return agentConfig.loadAgentConfig(join(dir, "agent.yaml"));
}

function serveFlags(args: string[]): ServeFlags {
  const parsed = parseServeFlags(args);
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed;
}

test("agent serve engine scope defaults on and LLAMACTL_ENGINE_SCOPE=off omits it", () => {
  const dir = freshDir();
  const cfg = seedConfig(dir);
  const parsed = serveFlags([`--dir=${dir}`]);

  const enabled = buildServeOptions(parsed, cfg, idleWiring, "node", {});
  expect(enabled.engineScope).toBe(true);

  const disabled = buildServeOptions(parsed, cfg, idleWiring, "node", {
    LLAMACTL_ENGINE_SCOPE: "off",
  });
  expect("engineScope" in disabled).toBe(false);
});

test("agent serve LLAMACTL_ENGINE_SCOPE=require publishes the required engine scope", () => {
  const dir = freshDir();
  const cfg = seedConfig(dir);
  const parsed = serveFlags([`--dir=${dir}`]);

  const required = buildServeOptions(parsed, cfg, idleWiring, "node", {
    LLAMACTL_ENGINE_SCOPE: "require",
  });
  expect(required.engineScope).toBe("require");

  // Only the exact value selects require mode; anything else keeps the opt-in.
  for (const value of ["REQUIRE", "required", "on", ""]) {
    const other = buildServeOptions(parsed, cfg, idleWiring, "node", {
      LLAMACTL_ENGINE_SCOPE: value,
    });
    expect(other.engineScope).toBe(true);
  }
});
