import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerFleetTools } from "../src/tools/fleet.js";

type SpawnFn = typeof import("node:child_process").spawn;
type SpawnMockOptions = {
  code: number;
  stdout?: string;
  stderr?: string;
  holdOpenMs?: number;
};

function mockSpawn(
  opts: SpawnMockOptions,
  calls: Array<{ cmd: string; args: string[] }> = [],
): SpawnFn {
  return ((cmd: string, args: string[], _options?: SpawnOptions) => {
    calls.push({ cmd, args });
    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    setTimeout(() => {
      if (opts.stdout) proc.stdout.emit("data", Buffer.from(opts.stdout));
      if (opts.stderr) proc.stderr.emit("data", Buffer.from(opts.stderr));
      proc.emit("close", opts.code);
    }, opts.holdOpenMs ?? 0);
    return proc as unknown as ChildProcess;
  }) as unknown as SpawnFn;
}

async function connected(deps?: {
  spawn?: SpawnFn;
  detectExistingSupervisor?: () => Promise<{ running: boolean; pid?: number }>;
}) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerFleetTools(server, {
    ...deps,
    detectExistingSupervisor: deps?.detectExistingSupervisor ?? (async () => ({ running: false })),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client };
}

function textOf(result: unknown): string {
  const c = (result as { content?: Array<{ type: string; text: string }> }).content ?? [];
  return c[0]?.text ?? "";
}

function call(client: Client, name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args });
}

// ── llamactl_admit_measure ────────────────────────────────────────────────────

describe("llamactl_admit_measure", () => {
  test("success (code 0) returns ok:true with stdout", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnFn = mockSpawn({ code: 0, stdout: '{"peakMb":1024}' }, calls);
    const { client } = await connected({ spawn: spawnFn });

    const result = await call(client, "llamactl_admit_measure", { workload: "gemma4" });
    const parsed = JSON.parse(textOf(result)) as { ok: boolean; stdout: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.stdout).toBe('{"peakMb":1024}');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe("bun");
    expect(calls[0]!.args).toContain("admit");
    expect(calls[0]!.args).toContain("measure");
    expect(calls[0]!.args).toContain("gemma4");
  });

  test("failure (non-zero code) returns ok:false with code", async () => {
    const spawnFn = mockSpawn({ code: 1, stderr: "workload not found" });
    const { client } = await connected({ spawn: spawnFn });

    const result = await call(client, "llamactl_admit_measure", { workload: "missing-wl" });
    const parsed = JSON.parse(textOf(result)) as {
      ok: boolean;
      code: number;
      stderr: string;
      error?: string;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe(1);
    expect(parsed.error).toBe("workload not found");
  });

  test("node flag is appended to args when provided", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnFn = mockSpawn({ code: 0 }, calls);
    const { client } = await connected({ spawn: spawnFn });

    await call(client, "llamactl_admit_measure", { workload: "granite", node: "mac-mini" });
    expect(calls[0]!.args).toContain("--node=mac-mini");
  });

  test("does not allow concurrent in-flight runs for the same workload", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnFn = mockSpawn({ code: 0, stdout: "ok", holdOpenMs: 15 }, calls);
    const { client } = await connected({ spawn: spawnFn });

    const first = call(client, "llamactl_admit_measure", { workload: "gemma4" });
    const second = Promise.resolve().then(() =>
      call(client, "llamactl_admit_measure", { workload: "gemma4" }),
    );
    const [, rawSecond] = await Promise.all([first, second]);
    const parsedSecond = JSON.parse(textOf(rawSecond)) as { ok: boolean; error?: string };
    expect(parsedSecond.ok).toBe(false);
    expect(parsedSecond.error).toMatch(/already running/);
    expect(calls).toHaveLength(1);
  });

  test("writes mcp-audit entry on success with LLAMACTL_FLEET_DIR", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "llamactl-fleet-audit-"));
    const original = process.env.LLAMACTL_FLEET_DIR;
    process.env.LLAMACTL_FLEET_DIR = tmpDir;

    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnFn = mockSpawn({ code: 0, stdout: '{"peakMb":1024}' }, calls);
    const { client } = await connected({ spawn: spawnFn });
    const result = await call(client, "llamactl_admit_measure", { workload: "granite" });
    const parsed = JSON.parse(textOf(result)) as { ok: boolean };
    expect(parsed.ok).toBe(true);

    const raw = readFileSync(`${tmpDir}/audit.jsonl`, "utf8").trim();
    const auditLine = JSON.parse(raw.split("\n").at(-1) ?? "{}") as {
      kind: string;
      tool: string;
      outcome: string;
    };
    expect(auditLine.kind).toBe("mcp-audit");
    expect(auditLine.tool).toBe("llamactl_admit_measure");
    expect(auditLine.outcome).toBe("success");
    if (original === undefined) {
      delete process.env.LLAMACTL_FLEET_DIR;
    } else {
      process.env.LLAMACTL_FLEET_DIR = original;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ── llamactl_supervisor_execute ───────────────────────────────────────────────

describe("llamactl_supervisor_execute", () => {
  test("proposalId mode passes --execute flag", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnFn = mockSpawn({ code: 0, stdout: "executed" }, calls);
    const { client } = await connected({ spawn: spawnFn });

    const result = await call(client, "llamactl_supervisor_execute", {
      proposalId: "prop-42",
      confirm: true,
    });
    const parsed = JSON.parse(textOf(result)) as { ok: boolean; error?: string };
    expect(parsed.ok).toBe(true);

    expect(calls[0]!.args).toContain("supervisor");
    expect(calls[0]!.args).toContain("tick");
    expect(calls[0]!.args).toContain("--execute=prop-42");
    expect(calls[0]!.args).not.toContain("--auto");
  });

  test("proposalId mode requires confirm", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnFn = mockSpawn({ code: 0 }, calls);
    const { client } = await connected({ spawn: spawnFn });

    const result = await call(client, "llamactl_supervisor_execute", { proposalId: "prop-42" });
    const parsed = JSON.parse(textOf(result)) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/destructive operation requires confirm:true/);
    expect(calls).toHaveLength(0);
  });

  test("auto mode passes --auto flag", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnFn = mockSpawn({ code: 0 }, calls);
    const { client } = await connected({ spawn: spawnFn });

    await call(client, "llamactl_supervisor_execute", { auto: true, confirm: true });
    expect(calls[0]!.args).toContain("--auto");
    expect(calls[0]!.args.some((x) => x.startsWith("--execute="))).toBe(false);
  });

  test("supervisor existing process blocks execution", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnFn = mockSpawn({ code: 0 }, calls);
    const { client } = await connected({
      spawn: spawnFn,
      detectExistingSupervisor: async () => ({ running: true, pid: 99 }),
    });

    const result = await call(client, "llamactl_supervisor_execute", {
      proposalId: "prop-1",
      confirm: true,
    });
    const parsed = JSON.parse(textOf(result)) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/blocked by running supervisor/);
    expect(calls).toHaveLength(0);
  });

  test("severityThreshold is propagated in auto mode", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnFn = mockSpawn({ code: 0 }, calls);
    const { client } = await connected({ spawn: spawnFn });

    await call(client, "llamactl_supervisor_execute", {
      auto: true,
      confirm: true,
      severityThreshold: 2,
    });
    expect(calls[0]!.args).toContain("--severity-threshold=2");
  });

  test("node flag is appended when provided", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnFn = mockSpawn({ code: 0 }, calls);
    const { client } = await connected({ spawn: spawnFn });

    await call(client, "llamactl_supervisor_execute", {
      auto: true,
      confirm: true,
      node: "mac-mini",
    });
    expect(calls[0]!.args).toContain("--node=mac-mini");
  });

  test("neither proposalId nor auto returns validation error without spawning", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnFn = mockSpawn({ code: 0 }, calls);
    const { client } = await connected({ spawn: spawnFn });

    const result = await call(client, "llamactl_supervisor_execute", { confirm: true });
    const parsed = JSON.parse(textOf(result)) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/exactly one/);
    expect(calls).toHaveLength(0);
  });

  test("both proposalId and auto returns validation error without spawning", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnFn = mockSpawn({ code: 0 }, calls);
    const { client } = await connected({ spawn: spawnFn });

    const result = await call(client, "llamactl_supervisor_execute", {
      proposalId: "prop-1",
      auto: true,
      confirm: true,
    });
    const parsed = JSON.parse(textOf(result)) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/exactly one/);
    expect(calls).toHaveLength(0);
  });

  test("non-zero exit returns ok:false", async () => {
    const spawnFn = mockSpawn({ code: 2, stderr: "proposal not found" });
    const { client } = await connected({ spawn: spawnFn });

    const result = await call(client, "llamactl_supervisor_execute", {
      proposalId: "bad-id",
      confirm: true,
    });
    const parsed = JSON.parse(textOf(result)) as { ok: boolean; code: number; error?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe(2);
    expect(parsed.error).toBe("proposal not found");
  });
});
