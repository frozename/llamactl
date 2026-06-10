import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { CLI_ENTRY, makeTempRuntime, runCli } from "./helpers.js";
import { parseServeFlags } from "../src/commands/agent.js";

function augment(env: NodeJS.ProcessEnv, devStorage: string): NodeJS.ProcessEnv {
  return {
    ...env,
    LLAMACTL_CONFIG: join(devStorage, "config"),
    LLAMACTL_AGENT_DIR: join(devStorage, "agent"),
  };
}

describe("agent serve --no-auth validation", () => {
  let temp: ReturnType<typeof makeTempRuntime>;

  beforeEach(() => {
    temp = makeTempRuntime();
  });

  afterEach(() => {
    temp.cleanup();
  });

  function initAgent(env: NodeJS.ProcessEnv): void {
    const r = runCli(
      [
        "agent",
        "init",
        "--host=127.0.0.1",
        "--port=17871",
        "--name=probe",
        "--bind=127.0.0.1",
        "--san=127.0.0.1,localhost",
      ],
      env,
    );
    expect(r.code).toBe(0);
  }

  test("--no-auth with 0.0.0.0 is rejected before bind", () => {
    const parsed = parseServeFlags(["--no-auth", "--host=0.0.0.0"]);
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.noAuth).toBe(true);
    expect(parsed.bindHost).toBe("0.0.0.0");

    const env = augment(temp.env, temp.devStorage);
    initAgent(env);
    const r = runCli(["agent", "serve", "--no-auth", "--host=0.0.0.0"], env);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("localhost");
    expect(r.stderr).toContain("127.0.0.1");
    expect(r.stderr).toContain("0.0.0.0");
  });

  test("--no-auth with 127.0.0.1 starts normally", () => {
    const env = augment(temp.env, temp.devStorage);
    initAgent(env);

    const proc = spawnSync("bun", [CLI_ENTRY, "agent", "serve", "--no-auth", "--host=127.0.0.1"], {
      env,
      cwd: join(__dirname, ".."),
      encoding: "utf8",
      timeout: 1000,
    });
    expect(proc.stderr).not.toContain("restricted to 127.0.0.1 or localhost");
  });
});
