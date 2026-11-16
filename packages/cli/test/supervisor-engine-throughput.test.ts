// RED pins for frozename/llamactl#716: `llamactl supervisor tick|serve` gains
// an opt-in `--record-engine-throughput` flag that wires the loop's existing
// read-only engine-throughput recorder (frozename/llamactl#249) through the
// CLI — `engineThroughput` on the journaled fleet-snapshot, an
// `engine-throughput=on` banner line, and a USAGE entry. At base the flag is
// silently ignored: the tick still exits 0, but no /metrics or /slots probe
// fires and the snapshot lacks the field.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { runSupervisor } from "../src/commands/supervisor.js";
import { existsSync, mkdirSync, readFileSync } from "../src/safe-fs.js";
import { captureProcessStreams, CLI_ENTRY, makeTempRuntime } from "./helpers.js";

// Local parse shape for the journaled fleet-snapshot's optional
// engineThroughput field — kept structural so the pins fail by assertion
// (the field is simply absent at base), never by type error.
type SnapshotWithThroughput = {
  kind?: string;
  engineThroughput?: {
    workload: string;
    metrics: { available: boolean };
    slots: { available: boolean };
  }[];
};

interface TickRun {
  code: number;
  stderr: string;
  snapshot: SnapshotWithThroughput | undefined;
  paths: string[];
}

// Same Prometheus shape as metricsText() in
// packages/fleet-supervisor/test/engine-throughput-loop.test.ts, fixed values.
function metricsText(): string {
  return [
    "# HELP llamacpp:prompt_tokens_total Total prompt tokens processed",
    "# TYPE llamacpp:prompt_tokens_total counter",
    "llamacpp:prompt_tokens_total 100",
    "# HELP llamacpp:tokens_predicted_total Total tokens predicted",
    "# TYPE llamacpp:tokens_predicted_total counter",
    "llamacpp:tokens_predicted_total 50",
    "# HELP llamacpp:requests_processing Requests currently processing",
    "# TYPE llamacpp:requests_processing gauge",
    "llamacpp:requests_processing 1",
    "# HELP llamacpp:requests_deferred Requests deferred",
    "# TYPE llamacpp:requests_deferred gauge",
    "llamacpp:requests_deferred 0",
    "",
  ].join("\n");
}

const runtime = makeTempRuntime();
const hits: string[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    hits.push(path);
    if (req.method === "GET" && path === "/health") {
      return Response.json({ status: "ok" });
    }
    if (req.method === "GET" && path === "/v1/models") {
      return Response.json({
        object: "list",
        data: [{ id: "fake", object: "model", created: 1 }],
      });
    }
    if (req.method === "GET" && path === "/metrics") {
      return new Response(metricsText(), {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }
    if (req.method === "GET" && path === "/slots") {
      return Response.json([
        { id: 0, is_processing: true },
        { id: 1, is_processing: false },
      ]);
    }
    return new Response("not found", { status: 404 });
  },
});
const boundPort = server.port;
if (boundPort === undefined) {
  throw new Error("Bun.serve did not bind a TCP port");
}
const serverPort: number = boundPort;

const offDir = join(runtime.devStorage, "off");
const onDir = join(runtime.devStorage, "on");
mkdirSync(offDir);
mkdirSync(onDir);

async function runTick(dir: string, extraArgs: string[]): Promise<TickRun> {
  const start = hits.length;
  const env: NodeJS.ProcessEnv = {
    ...runtime.env,
    HOME: dir,
    DEV_STORAGE: runtime.devStorage,
    LLAMACTL_WORKLOADS_DIR: `${dir}/workloads`,
    LLAMACTL_FLEET_DIR: `${dir}/fleet`,
  };
  // HOME=dir is what keeps bumpLeaseTerm's os.homedir()/.llamactl/fleet/lease-term
  // write inside the temp dir; LLAMACTL_FLEET_DIR only isolates the
  // fleet-supervisor default journal dir (an explicit --journal is passed anyway).
  delete env["LLAMACTL_FLEET_MOVE_ENABLED"];
  const proc = Bun.spawn(
    [
      process.execPath,
      CLI_ENTRY,
      "supervisor",
      "tick",
      `--journal=${dir}/journal.jsonl`,
      `--workload=fakehost@http://127.0.0.1:${String(serverPort)}`,
      ...extraArgs,
    ],
    { stdout: "pipe", stderr: "pipe", env },
  );
  const code = await proc.exited;
  await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  const journalPath = `${dir}/journal.jsonl`;
  const snapshots: SnapshotWithThroughput[] = existsSync(journalPath)
    ? readFileSync(journalPath, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as SnapshotWithThroughput)
        .filter((entry) => entry.kind === "fleet-snapshot")
    : [];
  const snapshot = snapshots.at(-1);
  expect(existsSync(`${dir}/.llamactl/fleet/lease-term`)).toBe(true);
  return { code, stderr, snapshot, paths: hits.slice(start) };
}

describe("supervisor --record-engine-throughput (#716)", () => {
  let offRun: TickRun;
  let onRun: TickRun;

  beforeAll(async () => {
    offRun = await runTick(offDir, []);
    onRun = await runTick(onDir, ["--record-engine-throughput"]);
  }, 60_000);

  afterAll(async () => {
    await server.stop(true);
    runtime.cleanup();
  });

  test("--record-engine-throughput makes a tick journal engineThroughput; without it the field is absent", () => {
    expect(offRun.code).toBe(0);
    expect(onRun.code).toBe(0);
    expect(offRun.snapshot).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(offRun.snapshot, "engineThroughput")).toBe(false);
    expect(offRun.paths).not.toContain("/metrics");

    const throughput = onRun.snapshot?.engineThroughput;
    expect(throughput).toBeDefined();
    expect(throughput).toHaveLength(1);
    expect(throughput?.[0]?.workload).toBe("fakehost");
    expect(throughput?.[0]?.metrics.available).toBe(true);
    expect(throughput?.[0]?.slots.available).toBe(true);
    expect(onRun.paths).toContain("/metrics");
  }, 30_000);

  test("loop banner reports engine-throughput when the switch is on", () => {
    expect(onRun.stderr).toContain("supervisor: engine-throughput=on");
    expect(offRun.stderr).not.toContain("engine-throughput=on");
  }, 30_000);

  test("help lists --record-engine-throughput", async () => {
    const { result, stdout } = await captureProcessStreams(() =>
      runSupervisor(["serve", "--help"]),
    );
    expect(result).toBe(0);
    expect(stdout).toMatch(/--record-engine-throughput\s+Read-only/);
  }, 30_000);
});
