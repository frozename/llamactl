import { type Config, configSchema, config as kubecfg } from "@llamactl/remote";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCtx } from "../src/commands/ctx.js";
import { EMPTY_GLOBALS, resetGlobals, setGlobals } from "../src/dispatcher.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";

const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);

let stdoutChunks: string[] = [];
let stderrChunks: string[] = [];
let tmp: string;
let defaultCfgPath: string;
let altCfgPath: string;
let savedLlamaCtlConfig: string | undefined;

beforeEach(() => {
  stdoutChunks = [];
  stderrChunks = [];
  tmp = mkdtempSync(join(tmpdir(), "llamactl-ctx-test-"));
  defaultCfgPath = join(tmp, "default-config");
  altCfgPath = join(tmp, "alt-config");

  // Control defaultConfigPath() so tests are hermetic regardless of ~/.llamactl.
  savedLlamaCtlConfig = process.env["LLAMACTL_CONFIG"];
  process.env["LLAMACTL_CONFIG"] = defaultCfgPath;

  // Default config: only "default" context, currentContext: "default".
  kubecfg.saveConfig(configSchema.freshConfig(), defaultCfgPath);

  // Alt config: adds "prod" context and starts with currentContext: "prod".
  // "prod" deliberately does not exist in the default config — any subcommand
  // that reads from defaultCfgPath instead of altCfgPath will fail or return
  // the wrong value, which is the mutation check.
  const altCfg: Config = {
    ...configSchema.freshConfig(),
    currentContext: "prod",
    contexts: [
      { name: "default", cluster: "home", user: "me", defaultNode: "local" },
      { name: "prod", cluster: "home", user: "me", defaultNode: "local" },
    ],
  };
  kubecfg.saveConfig(altCfg, altCfgPath);

  process.stdout.write = (chunk: string | Uint8Array, ..._rest: unknown[]): boolean => {
    if (typeof chunk === "string") stdoutChunks.push(chunk);
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array, ..._rest: unknown[]): boolean => {
    if (typeof chunk === "string") stderrChunks.push(chunk);
    return true;
  };
});

afterEach(() => {
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
  resetGlobals();
  if (savedLlamaCtlConfig === undefined) {
    delete process.env["LLAMACTL_CONFIG"];
  } else {
    process.env["LLAMACTL_CONFIG"] = savedLlamaCtlConfig;
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe("ctx: --cluster-config respected by all subcommands", () => {
  test("ctx current reads from --cluster-config path, not default", async () => {
    // alt config has currentContext: "prod"; default has "default".
    // Without the fix, output would be "default".
    setGlobals({ ...EMPTY_GLOBALS, configPath: altCfgPath });
    const code = await runCtx(["current"]);
    expect(code).toBe(0);
    expect(stdoutChunks.join("")).toBe("prod\n");
  });

  test("ctx use reads from --cluster-config path (mutation check: prod not in default config)", async () => {
    // "prod" context exists in altCfgPath but NOT in defaultCfgPath.
    // Without the fix, runUse reads defaultCfgPath → can't find "prod" → exits 1.
    // With the fix, runUse reads altCfgPath → finds "prod" → exits 0.
    setGlobals({ ...EMPTY_GLOBALS, configPath: altCfgPath });
    const code = await runCtx(["use", "prod"]);
    expect(code).toBe(0);
    expect(stdoutChunks.join("")).toContain("prod");
  });

  test("ctx use writes back to the --cluster-config path, not default", async () => {
    // alt config starts with currentContext: "prod".
    // We switch to "default" via --cluster-config=altCfgPath.
    // Without the fix, the write goes to defaultCfgPath (already "default") and
    // altCfgPath stays at "prod".
    setGlobals({ ...EMPTY_GLOBALS, configPath: altCfgPath });
    const code = await runCtx(["use", "default"]);
    expect(code).toBe(0);

    // alt file must now reflect the switch.
    const updated = kubecfg.loadConfig(altCfgPath);
    expect(updated.currentContext).toBe("default");
  });

  test("ctx get reads from --cluster-config path, not default", async () => {
    // alt config contains a "prod" context entry; default does not.
    setGlobals({ ...EMPTY_GLOBALS, configPath: altCfgPath });
    const code = await runCtx(["get"]);
    expect(code).toBe(0);
    expect(stdoutChunks.join("")).toContain("prod");
  });
});
