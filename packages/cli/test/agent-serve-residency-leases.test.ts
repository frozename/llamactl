/**
 * #278 DF-05 S8-agent-leases-flag.
 *
 * The RED case fails by assertion at 09ded7b2: `buildServeOptions` takes
 * no env argument yet, so the fifth argument is ignored and
 * `options.residencyLeases` stays undefined where the fix maps
 * `LLAMACTL_RESIDENCY_LEASES` '1'/'true' onto it. The inert-default
 * case passes at base and must keep passing: unset, '0' and '' must
 * never add the key.
 */
import { agentConfig, type startAgentServer } from "@llamactl/remote";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildServeOptions, parseServeFlags, type ServeFlags } from "../src/commands/agent.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";

type Opts = Parameters<typeof startAgentServer>[0] & { residencyLeases?: boolean };
const build = buildServeOptions as unknown as (...a: unknown[]) => Opts;

const dirs: string[] = [];

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const ENV_KEY = "LLAMACTL_RESIDENCY_LEASES";
let savedEnv: string | undefined;

beforeAll(() => {
  savedEnv = process.env[ENV_KEY];
  Reflect.deleteProperty(process.env, ENV_KEY);
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  if (savedEnv === undefined) Reflect.deleteProperty(process.env, ENV_KEY);
  else process.env[ENV_KEY] = savedEnv;
});

const idleWiring = {
  dialUrl: undefined,
  dialBearer: undefined,
  tunnelCentralOn: false,
  tunnelCentralBearer: undefined,
};

function seedConfig(dir: string, bindHost: string, port: number): agentConfig.AgentConfig {
  const config: agentConfig.AgentConfig = {
    apiVersion: "llamactl/v1",
    kind: "AgentConfig",
    bindHost,
    port,
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

describe("agent serve LLAMACTL_RESIDENCY_LEASES (#278)", () => {
  test("(d) '1' and 'true' set options.residencyLeases to true", () => {
    const dir = freshDir("serve-leases-on-");
    const cfg = seedConfig(dir, "127.0.0.1", 7843);
    const parsed = serveFlags([`--dir=${dir}`]);
    for (const value of ["1", "true"]) {
      const options = build(parsed, cfg, idleWiring, "n", {
        LLAMACTL_RESIDENCY_LEASES: value,
      });
      expect(options.residencyLeases).toBe(true);
    }
  });

  test("(g) pin: unset, '0' and '' never add the residencyLeases key", () => {
    const dir = freshDir("serve-leases-off-");
    const cfg = seedConfig(dir, "127.0.0.1", 7843);
    const parsed = serveFlags([`--dir=${dir}`]);
    // The four-argument call reads process.env, which beforeAll cleared.
    const baselineKeys = Object.keys(build(parsed, cfg, idleWiring, "n")).sort();
    for (const env of [{}, { LLAMACTL_RESIDENCY_LEASES: "0" }, { LLAMACTL_RESIDENCY_LEASES: "" }]) {
      const options = build(parsed, cfg, idleWiring, "n", env);
      expect("residencyLeases" in options).toBe(false);
      expect(Object.keys(options).sort()).toEqual(baselineKeys);
    }
  });
});
