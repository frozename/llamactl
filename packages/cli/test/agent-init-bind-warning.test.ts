import { agentConfig } from "@llamactl/remote";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initBindWarning, isLoopbackHost, runAgent } from "../src/commands/agent.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";

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
  tmp = mkdtempSync(join(tmpdir(), "llamactl-agent-bindwarn-"));
  process.env["LLAMACTL_AGENT_DIR"] = tmp;
});

afterEach(() => {
  if (originalAgentDir === undefined) delete process.env["LLAMACTL_AGENT_DIR"];
  else process.env["LLAMACTL_AGENT_DIR"] = originalAgentDir;
  rmSync(tmp, { recursive: true, force: true });
});

describe("isLoopbackHost", () => {
  for (const host of [
    "127.0.0.1",
    "127.0.0.2",
    "localhost",
    "LOCALHOST",
    "::1",
    "[::1]",
    "::ffff:127.0.0.1",
  ]) {
    test(`${host} is loopback`, () => {
      expect(isLoopbackHost(host)).toBe(true);
    });
  }
  for (const host of ["192.168.1.50", "mac-mini.local", "10.0.0.5", "0.0.0.0", "::"]) {
    test(`${host} is not loopback`, () => {
      expect(isLoopbackHost(host)).toBe(false);
    });
  }
});

describe("initBindWarning", () => {
  test("warns when a non-loopback host is paired with the default loopback bind", () => {
    const w = initBindWarning("192.168.1.50", "127.0.0.1", false);
    expect(w).not.toBeNull();
    expect(w).toContain("192.168.1.50");
    expect(w).toContain("127.0.0.1");
    expect(w).toContain("--bind=0.0.0.0");
  });

  test("stays silent for a loopback host", () => {
    expect(initBindWarning("127.0.0.1", "127.0.0.1", false)).toBeNull();
  });

  test("stays silent when --bind was explicit", () => {
    expect(initBindWarning("192.168.1.50", "127.0.0.1", true)).toBeNull();
  });

  test("stays silent for a non-loopback bind", () => {
    expect(initBindWarning("192.168.1.50", "0.0.0.0", false)).toBeNull();
  });
});

describe("agent init bind warning", () => {
  test("non-loopback --host with default bind warns on stderr only", async () => {
    const r = await capture([
      "init",
      `--dir=${tmp}`,
      "--host=192.168.1.50",
      "--port=17901",
      "--name=probe",
    ]);
    expect(r.code).toBe(0);
    expect(r.err).toContain("warning:");
    expect(r.err).toContain("192.168.1.50");
    expect(r.err).toContain("--bind=0.0.0.0");
    expect(r.err).toContain("127.0.0.1");
    expect(r.err.split("\n").filter((l) => l.includes("warning")).length).toBe(1);
    expect(r.out).toContain("llamactl node add probe --bootstrap ");
    expect(r.out).not.toContain("warning");
    expect(agentConfig.loadAgentConfig(join(tmp, "agent.yaml")).bindHost).toBe("127.0.0.1");
  });

  test("--json keeps stdout a single JSON line with the warning on stderr", async () => {
    const r = await capture([
      "init",
      `--dir=${tmp}`,
      "--host=192.168.1.50",
      "--port=17902",
      "--name=probe",
      "--json",
    ]);
    expect(r.code).toBe(0);
    const lines = r.out.trim().split("\n");
    expect(lines.length).toBe(1);
    const record = JSON.parse(lines[0]!) as { bindHost: string; blob: string };
    expect(record.bindHost).toBe("127.0.0.1");
    expect(record.blob.length).toBeGreaterThan(0);
    expect(r.err).toContain("--bind=0.0.0.0");
    expect(r.err.split("\n").filter((l) => l.includes("warning")).length).toBe(1);
    expect(r.out).not.toContain("warning");
  });

  test("explicit non-loopback --bind does not warn", async () => {
    const r = await capture([
      "init",
      `--dir=${tmp}`,
      "--host=192.168.1.50",
      "--port=17903",
      "--bind=0.0.0.0",
      "--san=192.168.1.50,127.0.0.1",
    ]);
    expect(r.code).toBe(0);
    expect(r.err).not.toContain("warning");
  });

  test("explicit loopback --bind does not warn", async () => {
    const r = await capture([
      "init",
      `--dir=${tmp}`,
      "--host=192.168.1.50",
      "--port=17904",
      "--bind=127.0.0.1",
    ]);
    expect(r.code).toBe(0);
    expect(r.err).not.toContain("warning");
  });

  test("default host does not warn", async () => {
    const r = await capture(["init", `--dir=${tmp}`, "--port=17905"]);
    expect(r.code).toBe(0);
    expect(r.err).not.toContain("warning");
  });

  test("--host=localhost does not warn", async () => {
    const r = await capture(["init", `--dir=${tmp}`, "--host=localhost", "--port=17906"]);
    expect(r.code).toBe(0);
    expect(r.err).not.toContain("warning");
  });
});
