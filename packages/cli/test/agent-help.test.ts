import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAgent } from "../src/commands/agent.js";
import { existsSync, mkdtempSync, rmSync } from "../src/safe-fs.js";

let tmp = "";
const originalAgentDir = process.env["LLAMACTL_AGENT_DIR"];

async function capture(args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk: string | Uint8Array): true => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array): true => {
    err += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  };
  try {
    const code = await runAgent(args);
    return { code, out, err };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-agent-help-"));
  process.env["LLAMACTL_AGENT_DIR"] = tmp;
});

afterEach(() => {
  if (originalAgentDir === undefined) delete process.env["LLAMACTL_AGENT_DIR"];
  else process.env["LLAMACTL_AGENT_DIR"] = originalAgentDir;
  rmSync(tmp, { recursive: true, force: true });
});

describe("agent subcommand --help", () => {
  const cases: [string, string[]][] = [
    [
      "init",
      ["--dir=", "--host=", "--port=", "--name=", "--bind=", "--san=", "--force", "default: 7843"],
    ],
    ["rotate-token", ["--dir=", "--host=", "--json"]],
    ["rotate-cert", ["--dir=", "--host=", "--san=", "--token-file=", "--json"]],
    ["serve", ["--dir=", "--bind=", "--port=", "--no-auth", "--dial-central="]],
    ["status", ["--dir=", "--host=", "--json"]],
    ["install-systemd", ["--scope=", "--bind=", "--port=", "--env-file=", "--dry-run"]],
    ["token", ["add", "list", "revoke", "--out="]],
  ];

  for (const [sub, flags] of cases) {
    for (const helpFlag of ["--help", "-h"]) {
      test(`agent ${sub} ${helpFlag} prints usage and exits 0`, async () => {
        const r = await capture([sub, helpFlag]);
        expect(r.code).toBe(0);
        expect(r.err).toBe("");
        expect(r.out).toContain(`Usage: llamactl agent ${sub}`);
        for (const flag of flags) expect(r.out).toContain(flag);
      });
    }
  }

  test("--help wins over other flags and does not write agent state", async () => {
    const r = await capture(["init", `--dir=${tmp}`, "--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Usage: llamactl agent init");
    expect(existsSync(join(tmp, "agent.yaml"))).toBe(false);
  });
});
