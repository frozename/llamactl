// RED pins for frozename/llamactl#249 — `llamactl workload status <name> --metrics`
// renders the per-ModelHost engine throughput the fleet supervisor appends to each
// fleet-snapshot. Every case spawns the real CLI against a temp DEV_STORAGE journal
// so only the user-facing contract is pinned.

import type {
  EngineThroughputSnapshot,
  FleetSnapshotEntry,
  WorkloadThroughputStats,
} from "@llamactl/fleet-supervisor";

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { mkdirSync, writeFileSync } from "../src/safe-fs.js";
import { CLI_ENTRY, makeTempRuntime, parseJsonRecord, requireRecordField } from "./helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PKG_DIR = join(__dirname, "..");

const WORKLOAD = "w1";
const NODE = "local";
const SNAP_TS = "2026-11-01T10:00:31.000Z";
const SAMPLED_AT = "2026-11-01T10:00:30.000Z";
const FIRST_SAMPLE_AT = "2026-11-01T09:55:00.000Z";
const LAST_SAMPLE_AT = "2026-11-01T10:00:30.000Z";

const FULL_STATS: WorkloadThroughputStats = {
  workload: WORKLOAD,
  revision: "rev-a",
  sampleCount: 12,
  intervalCount: 11,
  counterResets: 1,
  firstSampleAt: FIRST_SAMPLE_AT,
  lastSampleAt: LAST_SAMPLE_AT,
  decodeTokPerSec: { median: 45.1, p10: 42, p90: 48, count: 11 },
  prefillTokPerSec: { median: 589, p10: 174, p90: 600, count: 11 },
  decodeByBusySlots: {
    "3": { median: 34, p10: 33, p90: 35, count: 3 },
    "1": { median: 46, p10: 42, p90: 50, count: 4 },
  },
  meanBusySlots: 1.5,
  maxBusySlots: 3,
  meanRequestsProcessing: 1.5,
  deferredShare: 0.28,
  requestCount: 0,
  requestDecodeTokPerSec: null,
  requestPrefillTokPerSec: null,
  requestCachedPromptShare: null,
};

// Slot- and gauge-derived fields absent while decode rates survive: the
// "never zero" fixture — unavailable renders as unavailable, not 0.
const PARTIAL_STATS: WorkloadThroughputStats = {
  ...FULL_STATS,
  revision: null,
  prefillTokPerSec: null,
  decodeByBusySlots: {},
  meanBusySlots: null,
  maxBusySlots: null,
  deferredShare: null,
};

const OLDER_STATS: WorkloadThroughputStats = {
  ...FULL_STATS,
  decodeTokPerSec: { median: 99, p10: 90, p90: 100, count: 5 },
};

const OTHER_STATS: WorkloadThroughputStats = { ...FULL_STATS, workload: "other" };

interface ThroughputOverrides {
  workload?: string;
  revision?: string | null;
  sampledAt?: string;
  metrics?: EngineThroughputSnapshot["metrics"];
  slots?: EngineThroughputSnapshot["slots"];
}

function throughputEntry(
  stats: WorkloadThroughputStats | null,
  overrides: ThroughputOverrides = {},
): EngineThroughputSnapshot {
  return {
    workload: overrides.workload ?? WORKLOAD,
    revision: overrides.revision ?? null,
    sampledAt: overrides.sampledAt ?? SAMPLED_AT,
    metrics: overrides.metrics ?? { available: true },
    slots: overrides.slots ?? { available: true },
    stats,
  };
}

function fleetSnapshot(
  ts: string,
  engineThroughput?: EngineThroughputSnapshot[],
): FleetSnapshotEntry {
  return {
    kind: "fleet-snapshot",
    ts,
    node: NODE,
    node_mem: {
      free_mb: 16384,
      active_mb: 8192,
      inactive_mb: 4096,
      wired_mb: 2048,
      compressor_mb: 1024,
      swap_in: 0,
      swap_out: 0,
    },
    workloads: [
      {
        name: WORKLOAD,
        kind: "ModelHost",
        endpoint: "http://127.0.0.1:8000",
        priority: 50,
        rss_mb: null,
        request_rate_5m: null,
        error_rate_5m: 0,
        p50_ms: null,
        p95_ms: null,
        models: [],
        reachable: true,
        consecutiveErrors: 0,
      },
    ],
    ...(engineThroughput === undefined ? {} : { engineThroughput }),
  };
}

function fullStatsSnapshot(ts: string = SNAP_TS): FleetSnapshotEntry {
  return fleetSnapshot(ts, [throughputEntry(FULL_STATS, { revision: "rev-a" })]);
}

function partialStatsSnapshot(ts: string = SNAP_TS): FleetSnapshotEntry {
  return fleetSnapshot(ts, [
    throughputEntry(PARTIAL_STATS, {
      slots: { available: false, reason: "slots endpoint returned 501" },
    }),
  ]);
}

function writeJournal(devStorage: string, entries: FleetSnapshotEntry[]): void {
  const dir = join(devStorage, "fleet-supervisor");
  mkdirSync(dir, { recursive: true });
  const lines = entries.map((entry) => JSON.stringify(entry));
  writeFileSync(join(dir, "journal.jsonl"), `${lines.join("\n")}\n`, "utf8");
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function spawnCli(env: NodeJS.ProcessEnv, args: string[]): CliResult {
  const proc = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    env: { ...env },
    encoding: "utf8",
    cwd: CLI_PKG_DIR,
  });
  return {
    code: proc.status ?? -1,
    stdout: proc.stdout,
    stderr: proc.stderr,
  };
}

let runtime: ReturnType<typeof makeTempRuntime> | null = null;

function setupRuntime(entries?: FleetSnapshotEntry[]): NodeJS.ProcessEnv {
  const rt = makeTempRuntime();
  runtime = rt;
  const env: NodeJS.ProcessEnv = {
    ...rt.env,
    // A config path that does not exist loads freshConfig(): no agent peers,
    // so nothing in these tests can leave the temp DEV_STORAGE.
    LLAMACTL_CONFIG: join(rt.devStorage, "no-such-config"),
  };
  if (entries !== undefined) {
    writeJournal(rt.devStorage, entries);
  }
  return env;
}

afterEach(() => {
  runtime?.cleanup();
  runtime = null;
});

describe("workload status --metrics", () => {
  test("prints the full engine throughput stats", () => {
    const env = setupRuntime([fullStatsSnapshot()]);

    const res = spawnCli(env, ["workload", "status", WORKLOAD, "--metrics"]);

    expect(res.code).toBe(0);
    expect(res.stdout).toContain("workload: w1");
    expect(res.stdout).toContain("node: local");
    expect(res.stdout).toContain("revision: rev-a");
    expect(res.stdout).toContain("samples: 12 (11 intervals)");
    expect(res.stdout).toContain(`window: ${FIRST_SAMPLE_AT} .. ${LAST_SAMPLE_AT}`);
    expect(res.stdout).toContain("counter resets: 1");
    expect(res.stdout).toContain("decode tok/s: median 45.1 (p10 42.0, p90 48.0, n=11)");
    expect(res.stdout).toContain("prefill tok/s: median 589.0 (p10 174.0, p90 600.0, n=11)");
    expect(res.stdout).toContain("mean busy slots: 1.50 (max 3)");
    expect(res.stdout).toContain("deferred share: 28.0%");
    expect(res.stdout).toContain("decode by busy slots:");
    const bucketOne = res.stdout.indexOf("  1: median 46.0");
    const bucketThree = res.stdout.indexOf("  3: median 34.0");
    expect(bucketOne).toBeGreaterThanOrEqual(0);
    expect(bucketThree).toBeGreaterThanOrEqual(0);
    expect(bucketOne).toBeLessThan(bucketThree);
  });

  test("prints unavailable instead of zero for absent slot and prefill data", () => {
    const env = setupRuntime([partialStatsSnapshot()]);

    const res = spawnCli(env, ["workload", "status", WORKLOAD, "--metrics"]);

    expect(res.code).toBe(0);
    expect(res.stdout).toContain("prefill tok/s: unavailable");
    expect(res.stdout).toContain("mean busy slots: unavailable");
    expect(res.stdout).toContain("deferred share: unavailable");
    expect(res.stdout).toContain("decode by busy slots: unavailable");
    expect(res.stdout).toContain("revision: unavailable");
    expect(res.stdout).toContain("slots: unavailable (slots endpoint returned 501)");
    expect(res.stdout).not.toMatch(/prefill tok\/s: 0/);
    expect(res.stdout).not.toMatch(/deferred share: 0/);
    expect(res.stdout).not.toMatch(/mean busy slots: 0/);
  });

  test("prints a genuine zero deferred share as 0.0%", () => {
    const env = setupRuntime([
      fleetSnapshot(SNAP_TS, [
        throughputEntry({ ...FULL_STATS, deferredShare: 0 }, { revision: "rev-a" }),
      ]),
    ]);

    const res = spawnCli(env, ["workload", "status", WORKLOAD, "--metrics"]);

    expect(res.code).toBe(0);
    expect(res.stdout).toContain("deferred share: 0.0%");
  });

  test("stats null still exits 0 with unavailable lines", () => {
    const env = setupRuntime([
      fleetSnapshot(SNAP_TS, [
        throughputEntry(null, {
          metrics: { available: false, reason: "workload unreachable" },
          slots: { available: false, reason: "workload unreachable" },
        }),
      ]),
    ]);

    const res = spawnCli(env, ["workload", "status", WORKLOAD, "--metrics"]);

    expect(res.code).toBe(0);
    expect(res.stdout).toContain("metrics: unavailable (workload unreachable)");
    expect(res.stdout).toContain("samples: unavailable");
    expect(res.stdout).toContain("decode tok/s: unavailable");
    expect(res.stdout).toContain("prefill tok/s: unavailable");
  });

  test("the snapshot with the newest ts wins", () => {
    const newer = fullStatsSnapshot(SNAP_TS);
    const older = fleetSnapshot("2026-11-01T09:00:00.000Z", [
      throughputEntry(OLDER_STATS, { revision: "rev-a" }),
    ]);
    // Written newest-first so a last-line reader cannot pass by accident.
    const env = setupRuntime([newer, older]);

    const res = spawnCli(env, ["workload", "status", WORKLOAD, "--metrics"]);

    expect(res.code).toBe(0);
    expect(res.stdout).toContain("decode tok/s: median 45.1");
    expect(res.stdout).not.toContain("median 99.0");
  });

  test("--json emits the metrics payload", () => {
    const env = setupRuntime([partialStatsSnapshot()]);

    const res = spawnCli(env, ["workload", "status", WORKLOAD, "--metrics", "--json"]);

    expect(res.code).toBe(0);
    const parsed = parseJsonRecord(res.stdout);
    expect(parsed["available"]).toBe(true);
    expect(parsed["workload"]).toBe(WORKLOAD);
    expect(parsed["node"]).toBe(NODE);
    expect(parsed["snapshotTs"]).toBe(SNAP_TS);
    expect(parsed["sampledAt"]).toBe(SAMPLED_AT);
    expect(parsed["revision"]).toBeNull();
    expect(requireRecordField(parsed, "slots")["available"]).toBe(false);
    const stats = requireRecordField(parsed, "stats");
    expect(stats["prefillTokPerSec"]).toBeNull();
    expect(requireRecordField(stats, "decodeTokPerSec")["median"]).toBe(45.1);
    expect(stats["sampleCount"]).toBe(12);
  });

  test("exits 1 when the journal has no fleet snapshot", () => {
    const env = setupRuntime();

    const res = spawnCli(env, ["workload", "status", WORKLOAD, "--metrics"]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("no fleet snapshot found");
  });

  test("exits 1 when the snapshot has no engineThroughput field", () => {
    const env = setupRuntime([fleetSnapshot(SNAP_TS)]);

    const res = spawnCli(env, ["workload", "status", WORKLOAD, "--metrics"]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("no engine throughput data for workload w1");
  });

  test("exits 1 when engineThroughput only covers other workloads", () => {
    const env = setupRuntime([
      fleetSnapshot(SNAP_TS, [throughputEntry(OTHER_STATS, { workload: "other" })]),
    ]);

    const res = spawnCli(env, ["workload", "status", WORKLOAD, "--metrics"]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("no engine throughput data for workload w1");
  });

  test("--json reports available:false with a reason when throughput is missing", () => {
    const env = setupRuntime([fleetSnapshot(SNAP_TS)]);

    const res = spawnCli(env, ["workload", "status", WORKLOAD, "--metrics", "--json"]);

    expect(res.code).toBe(1);
    expect(res.stdout.trim()).not.toBe("");
    const parsed = parseJsonRecord(res.stdout);
    expect(parsed["workload"]).toBe(WORKLOAD);
    expect(parsed["available"]).toBe(false);
    expect(typeof parsed["reason"]).toBe("string");
    expect(parsed["reason"]).not.toBe("");
  });

  test("requires --metrics", () => {
    const env = setupRuntime([fullStatsSnapshot()]);

    const res = spawnCli(env, ["workload", "status", WORKLOAD]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("--metrics");
  });

  test("--help documents the metrics flag", () => {
    const env = setupRuntime();

    const res = spawnCli(env, ["--help"]);

    expect(res.code).toBe(0);
    expect(res.stdout).toContain("workload status <name> --metrics");
  });
});
