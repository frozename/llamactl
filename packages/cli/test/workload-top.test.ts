// RED pins for frozename/llamactl#249 — `llamactl workload top` renders one
// throughput row per ModelHost across the local journal and peer snapshots,
// with --watch refreshing on an injected timer. runWorkload runs in-process
// against injected deps: no journal, network or engine access.

import type { PeerNode } from "@llamactl/core/config/peers";
import type {
  EngineThroughputSnapshot,
  FleetSnapshotEntry,
  WorkloadSnapshot,
  WorkloadThroughputStats,
} from "@llamactl/fleet-supervisor";

import { readLatestFleetSnapshotFromJournal } from "@llamactl/fleet-supervisor";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runWorkload } from "../src/commands/workload-status.js";
import {
  captureProcessStreams,
  isPlainRecord,
  parseJsonRecord,
  requireArrayField,
  requireRecord,
} from "./helpers.js";

const WORKLOAD = "w1";
const PARTIAL_WORKLOAD = "w3";
const MODEL_RUN = "r1";
const NODE = "local";
const PEER_NODE = "peer1";
const PEER: PeerNode = { id: PEER_NODE, endpoint: "https://peer.invalid" };
const SNAP_TS = "2026-11-01T10:00:31.000Z";
const PEER_TS = "2026-11-01T10:00:32.000Z";
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

type SnapshotWorkload = Pick<WorkloadSnapshot, "name" | "kind">;

function fleetSnapshot(
  ts: string,
  engineThroughput?: EngineThroughputSnapshot[],
  node: string = NODE,
  workloads: SnapshotWorkload[] = [{ name: WORKLOAD, kind: "ModelHost" }],
): FleetSnapshotEntry {
  return {
    kind: "fleet-snapshot",
    ts,
    node,
    node_mem: {
      free_mb: 16384,
      active_mb: 8192,
      inactive_mb: 4096,
      wired_mb: 2048,
      compressor_mb: 1024,
      swap_in: 0,
      swap_out: 0,
    },
    workloads: workloads.map((workload) => ({
      name: workload.name,
      kind: workload.kind,
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
    })),
    ...(engineThroughput === undefined ? {} : { engineThroughput }),
  };
}

function withDecodeMedian(median: number): WorkloadThroughputStats {
  return {
    ...FULL_STATS,
    decodeTokPerSec: { median, p10: median - 3, p90: median + 3, count: 11 },
  };
}

function fullLocalSnapshot(): FleetSnapshotEntry {
  return fleetSnapshot(SNAP_TS, [throughputEntry(FULL_STATS, { revision: "rev-a" })]);
}

function topFixtureSnapshot(): FleetSnapshotEntry {
  return fleetSnapshot(
    SNAP_TS,
    [
      throughputEntry(FULL_STATS, { revision: "rev-a" }),
      throughputEntry(
        { ...PARTIAL_STATS, workload: PARTIAL_WORKLOAD },
        {
          workload: PARTIAL_WORKLOAD,
          slots: { available: false, reason: "slots endpoint returned 501" },
        },
      ),
    ],
    NODE,
    [
      { name: WORKLOAD, kind: "ModelHost" },
      { name: PARTIAL_WORKLOAD, kind: "ModelHost" },
      { name: MODEL_RUN, kind: "ModelRun" },
    ],
  );
}

interface TopDeps {
  readLocalSnapshot?: () => Promise<FleetSnapshotEntry | null>;
  readPeers?: () => PeerNode[];
  fetchPeerSnapshot?: (peer: PeerNode) => Promise<FleetSnapshotEntry | null>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => Date;
  signal?: AbortSignal;
  isTTY?: boolean;
}

interface TopResult {
  result: number;
  stdout: string;
  stderr: string;
}

async function runTop(args: string[], deps: TopDeps = {}): Promise<TopResult> {
  const injected: TopDeps = {
    readLocalSnapshot: () => Promise.resolve(null),
    readPeers: () => [],
    fetchPeerSnapshot: () => Promise.resolve(null),
    sleep: () => Promise.resolve(),
    now: () => new Date("2026-11-01T12:00:00.000Z"),
    isTTY: false,
    ...deps,
  };
  return await captureProcessStreams(() =>
    runWorkload(["top", ...args], injected as unknown as Parameters<typeof runWorkload>[1]),
  );
}

function isWorkloadRow(line: string, name: string): boolean {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith(name)) return false;
  const rest = trimmed.slice(name.length);
  return rest === "" || /^\s/.test(rest);
}

function workloadLine(stdout: string, name: string): string {
  const line = stdout.split("\n").find((candidate) => isWorkloadRow(candidate, name));
  if (line === undefined) {
    throw new Error(`expected a '${name}' row in:\n${stdout}`);
  }
  return line;
}

function findRow(rows: unknown[], name: string): Record<string, unknown> {
  const row = rows
    .map(requireRecord)
    .find((candidate) => candidate["name"] === name || candidate["workload"] === name);
  if (row === undefined) {
    throw new Error(`expected a '${name}' row in ${JSON.stringify(rows)}`);
  }
  return row;
}

const TOP_METRIC_KEYS = [
  "decodeTokPerSec",
  "prefillTokPerSec",
  "meanBusySlots",
  "deferredShare",
  "counterResets",
];

describe("workload top", () => {
  test("one row per ModelHost", async () => {
    const { result, stdout } = await runTop([], {
      readLocalSnapshot: () => Promise.resolve(topFixtureSnapshot()),
      readPeers: () => [],
      fetchPeerSnapshot: () => Promise.resolve(null),
    });

    expect(result).toBe(0);
    expect(stdout).toMatch(
      /^WORKLOAD\s+NODE\s+DECODE\s+PREFILL\s+BUSY\s+DEFERRED\s+RESETS\s+SAMPLED/m,
    );

    const w1 = workloadLine(stdout, WORKLOAD);
    expect(w1).toContain("45.1");
    expect(w1).toContain("589.0");
    expect(w1).toContain("1.50");
    expect(w1).toContain("28.0%");
    expect(w1.split(/\s+/)).toContain("1");

    const w3 = workloadLine(stdout, PARTIAL_WORKLOAD);
    expect(w3.match(/unavailable/g)).toHaveLength(3);
    expect(w3).not.toMatch(/w3.*\b0\.0/);

    const lines = stdout.split("\n");
    expect(lines.filter((line) => isWorkloadRow(line, MODEL_RUN))).toHaveLength(0);

    const w1Index = lines.findIndex((line) => isWorkloadRow(line, WORKLOAD));
    const w3Index = lines.findIndex((line) => isWorkloadRow(line, PARTIAL_WORKLOAD));
    expect(w1Index).toBeGreaterThanOrEqual(0);
    expect(w3Index).toBeGreaterThan(w1Index);
  });

  test("--json rows", async () => {
    const { result, stdout } = await runTop(["--json"], {
      readLocalSnapshot: () => Promise.resolve(topFixtureSnapshot()),
      readPeers: () => [],
      fetchPeerSnapshot: () => Promise.resolve(null),
    });

    expect(result).toBe(0);
    const rows = requireArrayField(parseJsonRecord(stdout), "rows");
    expect(rows).toHaveLength(2);

    const w1 = findRow(rows, WORKLOAD);
    expect(w1["node"]).toBe(NODE);
    expect(w1["decodeTokPerSec"]).toBe(45.1);
    expect(w1["prefillTokPerSec"]).toBe(589);
    expect(w1["meanBusySlots"]).toBe(1.5);
    expect(w1["deferredShare"]).toBe(0.28);
    expect(w1["counterResets"]).toBe(1);

    const w3 = findRow(rows, PARTIAL_WORKLOAD);
    expect(w3["prefillTokPerSec"]).toBeNull();
    expect(w3["meanBusySlots"]).toBeNull();
    expect(w3["deferredShare"]).toBeNull();
  });

  test("stats null", async () => {
    const snapshot = fleetSnapshot(SNAP_TS, [
      throughputEntry(null, {
        metrics: { available: false, reason: "workload unreachable" },
        slots: { available: false, reason: "workload unreachable" },
      }),
    ]);
    const deps: TopDeps = {
      readLocalSnapshot: () => Promise.resolve(snapshot),
      readPeers: () => [],
      fetchPeerSnapshot: () => Promise.resolve(null),
    };

    const human = await runTop([], deps);
    expect(human.result).toBe(0);
    expect(workloadLine(human.stdout, WORKLOAD).match(/unavailable/g)).toHaveLength(5);

    const json = await runTop(["--json"], deps);
    expect(json.result).toBe(0);
    const row = findRow(requireArrayField(parseJsonRecord(json.stdout), "rows"), WORKLOAD);
    for (const key of TOP_METRIC_KEYS) {
      expect(row[key]).toBeNull();
    }
  });

  test("no snapshot", async () => {
    const { result, stderr } = await runTop([], {
      readLocalSnapshot: () => Promise.resolve(null),
      readPeers: () => [],
      fetchPeerSnapshot: () => Promise.resolve(null),
    });

    expect(result).toBe(1);
    expect(stderr).toContain("no fleet snapshot found");
  });

  test("merge reuses status semantics", async () => {
    const local = fleetSnapshot(SNAP_TS, [
      throughputEntry(FULL_STATS, {
        revision: "rev-a",
        sampledAt: "2026-11-01T09:30:00.000Z",
      }),
    ]);
    const peer = fleetSnapshot(
      PEER_TS,
      [
        throughputEntry(withDecodeMedian(99), {
          revision: "rev-a",
          sampledAt: "2026-11-01T10:30:00.000Z",
        }),
      ],
      PEER_NODE,
    );

    const { result, stdout } = await runTop([], {
      readLocalSnapshot: () => Promise.resolve(local),
      readPeers: () => [PEER],
      fetchPeerSnapshot: () => Promise.resolve(peer),
    });

    expect(result).toBe(0);
    const w1 = workloadLine(stdout, WORKLOAD);
    expect(w1).toContain(PEER_NODE);
    expect(w1).toContain("99.0");
  });

  test("peer compat: previous-build peer snapshot", async () => {
    const localEntry = {
      ...throughputEntry(FULL_STATS, { revision: "rev-a" }),
      engine: "future",
      stats: { ...FULL_STATS, futureField: 1 },
    } as EngineThroughputSnapshot;
    const local = fleetSnapshot(SNAP_TS, [localEntry]);
    const previousBuildPeer = fleetSnapshot(PEER_TS, undefined, PEER_NODE, [
      { name: "w2", kind: "ModelHost" },
    ]);
    const deps: TopDeps = {
      readLocalSnapshot: () => Promise.resolve(local),
      readPeers: () => [PEER],
      fetchPeerSnapshot: () => Promise.resolve(previousBuildPeer),
    };

    const json = await runTop(["--json"], deps);
    expect(json.result).toBe(0);
    const rows = requireArrayField(parseJsonRecord(json.stdout), "rows");
    expect(findRow(rows, WORKLOAD)["decodeTokPerSec"]).toBe(45.1);
    const w2 = findRow(rows, "w2");
    expect(w2["node"]).toBe(PEER_NODE);
    for (const key of TOP_METRIC_KEYS) {
      expect(w2[key]).toBeNull();
    }

    const human = await runTop([], deps);
    expect(human.result).toBe(0);
    const w2Line = workloadLine(human.stdout, "w2");
    expect(w2Line).toContain("unavailable");
    expect(w2Line).not.toMatch(/\b0\.0/);
  });

  test("engineThroughput is purely additive (no prior key reshaped)", async () => {
    // This only checks additivity against a test-side allowlist of pre-#249
    // snapshot keys — it is not previous-build code. The loose-reader coverage
    // for old peers lives in fleet-supervisor's engine-throughput-loop test.
    const PREVIOUS_SNAPSHOT_KEYS = [
      "kind",
      "ts",
      "node",
      "node_mem",
      "workloads",
      "lease",
      "inFlightMoves",
    ];
    const previousSnapshotKeys = new Set(PREVIOUS_SNAPSHOT_KEYS);
    const projectPrevious = (obj: unknown): Record<string, unknown> => {
      if (!isPlainRecord(obj)) return {};
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        if (previousSnapshotKeys.has(key)) out[key] = value;
      }
      return out;
    };

    const withThroughput = fleetSnapshot(SNAP_TS, [throughputEntry(FULL_STATS)]);
    const without = fleetSnapshot(SNAP_TS);

    expect(Object.keys(withThroughput).filter((key) => !previousSnapshotKeys.has(key))).toEqual([
      "engineThroughput",
    ]);

    const roundTripped = JSON.parse(JSON.stringify(withThroughput)) as unknown;
    expect(projectPrevious(roundTripped)).toEqual(projectPrevious(without));

    const dir = await mkdtemp(join(tmpdir(), "llamactl-workload-top-"));
    try {
      const journalPath = join(dir, "journal.jsonl");
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Path is a fresh mkdtemp dir created by this test.
      await writeFile(journalPath, `${JSON.stringify(withThroughput)}\n`, "utf8");
      const read = readLatestFleetSnapshotFromJournal(journalPath);
      expect(read).not.toBeNull();
      expect(projectPrevious(read)).toEqual(projectPrevious(without));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    // A peer snapshot names itself after the peer; the projected local fixture
    // still carries node "local", so relabel it before handing it to fetchPeerSnapshot.
    const previousBuildPeer = {
      ...projectPrevious(withThroughput),
      node: PEER_NODE,
    } as unknown as FleetSnapshotEntry;
    const { result, stdout } = await runTop(["--json"], {
      readLocalSnapshot: () => Promise.resolve(without),
      readPeers: () => [PEER],
      fetchPeerSnapshot: () => Promise.resolve(previousBuildPeer),
    });
    expect(result).toBe(0);
    const w1 = findRow(requireArrayField(parseJsonRecord(stdout), "rows"), WORKLOAD);
    for (const key of TOP_METRIC_KEYS) {
      expect(w1[key]).toBeNull();
    }
  });

  test("--watch with injected timer", async () => {
    const ac = new AbortController();
    const sleeps: number[] = [];
    const sleep = (ms: number): Promise<void> => {
      sleeps.push(ms);
      if (sleeps.length === 2) ac.abort();
      return Promise.resolve();
    };
    let snapshotReads = 0;
    const before = process.listenerCount("SIGINT");
    const { result, stdout } = await runTop(["--watch=2"], {
      readLocalSnapshot: () => {
        snapshotReads += 1;
        const median = snapshotReads === 1 ? 45.1 : 50.0;
        return Promise.resolve(
          fleetSnapshot(SNAP_TS, [
            throughputEntry(withDecodeMedian(median), { revision: "rev-a" }),
          ]),
        );
      },
      readPeers: () => [],
      fetchPeerSnapshot: () => Promise.resolve(null),
      sleep,
      now: () => new Date("2026-11-01T10:00:00.000Z"),
      signal: ac.signal,
    });

    expect(result).toBe(0);
    expect(sleeps).toEqual([2000, 2000]);
    expect(snapshotReads).toBe(2);
    expect(stdout).not.toContain("\x1b[");
    expect(stdout.match(/^llamactl workload top .*2026-/gm)).toHaveLength(2);
    const first = stdout.indexOf("45.1");
    const second = stdout.indexOf("50.0");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThan(first);
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  test('["top", "--watch"] uses the default interval', async () => {
    const ac = new AbortController();
    const sleeps: number[] = [];
    const sleep = (ms: number): Promise<void> => {
      sleeps.push(ms);
      ac.abort();
      return Promise.resolve();
    };
    const { result } = await runTop(["--watch"], {
      readLocalSnapshot: () => Promise.resolve(fullLocalSnapshot()),
      readPeers: () => [],
      fetchPeerSnapshot: () => Promise.resolve(null),
      sleep,
      now: () => new Date("2026-11-01T10:00:00.000Z"),
      signal: ac.signal,
    });

    expect(result).toBe(0);
    expect(sleeps).toEqual([5000]);
  });

  test("invalid --watch values", async () => {
    const cases: string[][] = [["--watch=0"], ["--watch=abc"], ["--watch", "--json"]];
    for (const args of cases) {
      const sleeps: number[] = [];
      const { result, stderr } = await runTop(args, {
        readLocalSnapshot: () => Promise.resolve(fullLocalSnapshot()),
        readPeers: () => [],
        fetchPeerSnapshot: () => Promise.resolve(null),
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      });

      expect(result).toBe(1);
      expect(stderr).toContain("--watch");
      expect(sleeps).toEqual([]);
    }
  });

  test("--help documents top", async () => {
    const { result, stdout } = await captureProcessStreams(() => runWorkload(["--help"]));

    expect(result).toBe(0);
    expect(stdout).toContain("top [--watch");
  });

  test("TTY clear only in watch", async () => {
    const ac = new AbortController();
    const sleep = (ms: number): Promise<void> => {
      ac.abort();
      return Promise.resolve();
    };
    const watched = await runTop(["--watch"], {
      readLocalSnapshot: () => Promise.resolve(fullLocalSnapshot()),
      readPeers: () => [],
      fetchPeerSnapshot: () => Promise.resolve(null),
      sleep,
      now: () => new Date("2026-11-01T10:00:00.000Z"),
      signal: ac.signal,
      isTTY: true,
    });
    expect(watched.result).toBe(0);
    expect(watched.stdout).toContain("\x1b[H\x1b[2Jllamactl workload top");

    const single = await runTop([], {
      readLocalSnapshot: () => Promise.resolve(fullLocalSnapshot()),
      readPeers: () => [],
      fetchPeerSnapshot: () => Promise.resolve(null),
      isTTY: true,
    });
    expect(single.result).toBe(0);
    expect(single.stdout).not.toContain("\x1b[");
  });
});
