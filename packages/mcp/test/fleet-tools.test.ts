import type {
  FleetExecutionEntry,
  FleetHeartbeatEntry,
  FleetJournalEntry,
  FleetProposalEntry,
  FleetSnapshotEntry,
  FleetTransitionEntry,
} from "@llamactl/fleet-supervisor";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { registerFleetTools } from "../src/tools/fleet.js";

let tmpDir = "";

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "llamactl-fleet-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function journalAt(name = "journal.jsonl"): string {
  return join(tmpDir, name);
}

function writeJournal(entries: FleetJournalEntry[], name = "journal.jsonl"): string {
  const path = journalAt(name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  return path;
}

async function connected() {
  const server = new McpServer({ name: "test-fleet", version: "0.0.0" });
  registerFleetTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client };
}

function textOf(result: unknown): string {
  const c = (result as { content?: { type: string; text: string }[] }).content ?? [];
  return c[0]?.text ?? "";
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- reusable typed JSON helper for tests
function parseJson<T>(text: string): T;
function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

function call(client: Client, name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args });
}

// ── fixtures ────────────────────────────────────────────────────────────────

const snapshot = (node: string, ts: string): FleetSnapshotEntry => ({
  kind: "fleet-snapshot",
  ts,
  node,
  node_mem: {
    free_mb: 8000,
    active_mb: 4000,
    inactive_mb: 2000,
    wired_mb: 1000,
    compressor_mb: 500,
    swap_in: 0,
    swap_out: 0,
  },
  workloads: [],
});

const heartbeat = (node: string, ts: string): FleetHeartbeatEntry => ({
  kind: "fleet-heartbeat",
  ts,
  node,
});

const transition = (
  node: string,
  ts: string,
  signal: "pressure" | "pressure-cleared" | "degraded",
  from: string,
  to: string,
  subjectKind: "node" | "workload" = "node",
  subject = node,
): FleetTransitionEntry => ({
  kind: "fleet-transition",
  ts,
  node,
  subject,
  subjectKind,
  signal,
  from,
  to,
});

let _proposalSeq = 0;
const proposal = (node: string, ts: string, id?: string): FleetProposalEntry => ({
  kind: "fleet-proposal",
  ts,
  node,
  proposalId: id ?? `p-${String(++_proposalSeq)}`,
  transition: {
    subject: node,
    subjectKind: "node",
    signal: "pressure",
    from: "NORMAL",
    to: "HIGH",
  },
  action: { type: "evict", workload: "test-workload", reason: "pressure" },
});

const execution = (node: string, ts: string, proposalId: string): FleetExecutionEntry => ({
  kind: "fleet-execution",
  ts,
  node,
  proposalId,
  action: { type: "evict", workload: "test-workload", reason: "pressure" },
  status: "executed",
});

// ── llamactl_fleet_snapshot ──────────────────────────────────────────────────

describe("llamactl_fleet_snapshot", () => {
  test("empty journal → empty snapshots", async () => {
    const path = writeJournal([]);
    const { client } = await connected();
    const result = await call(client, "llamactl_fleet_snapshot", { journalPath: path });
    const parsed = parseJson<{ snapshots: unknown[] }>(textOf(result));
    expect(parsed.snapshots).toEqual([]);
  });

  test("missing journal → empty snapshots (no throw)", async () => {
    const { client } = await connected();
    const result = await call(client, "llamactl_fleet_snapshot", {
      journalPath: join(tmpDir, "no-such-file.jsonl"),
    });
    const parsed = parseJson<{ snapshots: unknown[] }>(textOf(result));
    expect(parsed.snapshots).toEqual([]);
  });

  test("returns latest snapshot per node from mixed journal", async () => {
    const path = writeJournal([
      snapshot("node-a", "2026-01-01T00:00:00Z"),
      heartbeat("node-a", "2026-01-01T00:00:05Z"),
      snapshot("node-a", "2026-01-01T00:01:00Z"),
      snapshot("node-b", "2026-01-01T00:00:30Z"),
    ]);
    const { client } = await connected();
    const result = await call(client, "llamactl_fleet_snapshot", { journalPath: path });
    const parsed = parseJson<{ snapshots: FleetSnapshotEntry[] }>(textOf(result));
    expect(parsed.snapshots).toHaveLength(2);
    const a = parsed.snapshots.find((s) => s.node === "node-a");
    expect(a?.ts).toBe("2026-01-01T00:01:00Z");
  });

  test("node filter returns only that node", async () => {
    const path = writeJournal([
      snapshot("node-a", "2026-01-01T00:00:00Z"),
      snapshot("node-b", "2026-01-01T00:00:01Z"),
    ]);
    const { client } = await connected();
    const result = await call(client, "llamactl_fleet_snapshot", {
      journalPath: path,
      node: "node-b",
    });
    const parsed = parseJson<{ snapshots: FleetSnapshotEntry[] }>(textOf(result));
    expect(parsed.snapshots).toHaveLength(1);
    expect(parsed.snapshots[0]!.node).toBe("node-b");
  });

  test("malformed lines are skipped without throwing", async () => {
    const path = journalAt();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      [
        JSON.stringify(snapshot("node-a", "2026-01-01T00:00:00Z")),
        "{not valid json",
        JSON.stringify(snapshot("node-a", "2026-01-01T00:01:00Z")),
      ].join("\n") + "\n",
      "utf8",
    );
    const { client } = await connected();
    const result = await call(client, "llamactl_fleet_snapshot", { journalPath: path });
    const parsed = parseJson<{ snapshots: FleetSnapshotEntry[] }>(textOf(result));
    expect(parsed.snapshots).toHaveLength(1);
    expect(parsed.snapshots[0]!.ts).toBe("2026-01-01T00:01:00Z");
  });
});

// ── llamactl_fleet_pressure ──────────────────────────────────────────────────

describe("llamactl_fleet_pressure", () => {
  test("empty journal → empty nodes", async () => {
    const path = writeJournal([]);
    const { client } = await connected();
    const result = await call(client, "llamactl_fleet_pressure", { journalPath: path });
    const parsed = parseJson<{ nodes: unknown[] }>(textOf(result));
    expect(parsed.nodes).toEqual([]);
  });

  test("node with snapshot but no transition → NORMAL with null lastTransitionAt", async () => {
    const path = writeJournal([snapshot("node-a", "2026-01-01T00:00:00Z")]);
    const { client } = await connected();
    const result = await call(client, "llamactl_fleet_pressure", { journalPath: path });
    const parsed = parseJson<{
      nodes: { name: string; state: string; lastTransitionAt: string | null }[];
    }>(textOf(result));
    expect(parsed.nodes).toHaveLength(1);
    expect(parsed.nodes[0]!.state).toBe("NORMAL");
    expect(parsed.nodes[0]!.lastTransitionAt).toBeNull();
  });

  test("pressure transition HIGH reflected in state", async () => {
    const path = writeJournal([
      snapshot("node-a", "2026-01-01T00:00:00Z"),
      transition("node-a", "2026-01-01T00:01:00Z", "pressure", "NORMAL", "HIGH"),
    ]);
    const { client } = await connected();
    const result = await call(client, "llamactl_fleet_pressure", { journalPath: path });
    const parsed = parseJson<{
      nodes: { name: string; state: string; lastTransitionAt: string | null }[];
    }>(textOf(result));
    const a = parsed.nodes.find((n) => n.name === "node-a")!;
    expect(a.state).toBe("HIGH");
    expect(a.lastTransitionAt).toBe("2026-01-01T00:01:00Z");
  });

  test("latest transition wins (HIGH then back to NORMAL)", async () => {
    const path = writeJournal([
      snapshot("node-a", "2026-01-01T00:00:00Z"),
      transition("node-a", "2026-01-01T00:01:00Z", "pressure", "NORMAL", "HIGH"),
      transition("node-a", "2026-01-01T00:02:00Z", "pressure-cleared", "HIGH", "NORMAL"),
    ]);
    const { client } = await connected();
    const result = await call(client, "llamactl_fleet_pressure", { journalPath: path });
    const parsed = JSON.parse(textOf(result)) as {
      nodes: { name: string; state: string }[];
    };
    expect(parsed.nodes.find((n) => n.name === "node-a")!.state).toBe("NORMAL");
  });

  test("node filter restricts to single node", async () => {
    const path = writeJournal([
      snapshot("node-a", "2026-01-01T00:00:00Z"),
      snapshot("node-b", "2026-01-01T00:00:01Z"),
      transition("node-b", "2026-01-01T00:01:00Z", "pressure", "NORMAL", "HIGH"),
    ]);
    const { client } = await connected();
    const result = await call(client, "llamactl_fleet_pressure", {
      journalPath: path,
      node: "node-a",
    });
    const parsed = JSON.parse(textOf(result)) as { nodes: { name: string }[] };
    expect(parsed.nodes.every((n) => n.name === "node-a")).toBe(true);
  });
});

// ── llamactl_fleet_proposals ─────────────────────────────────────────────────

describe("llamactl_fleet_proposals", () => {
  test("empty journal → empty proposals", async () => {
    const path = writeJournal([]);
    const { client } = await connected();
    const result = await call(client, "llamactl_fleet_proposals", {
      journalPath: path,
      pendingOnly: false,
    });
    const parsed = JSON.parse(textOf(result)) as { proposals: unknown[]; total: number };
    expect(parsed.proposals).toEqual([]);
    expect(parsed.total).toBe(0);
  });

  test("pendingOnly=true (default) excludes executed proposals", async () => {
    _proposalSeq = 0;
    const p1 = proposal("node-a", "2026-01-01T00:01:00Z", "prop-1");
    const p2 = proposal("node-a", "2026-01-01T00:02:00Z", "prop-2");
    const ex1 = execution("node-a", "2026-01-01T00:01:30Z", "prop-1");
    const path = writeJournal([p1, p2, ex1]);
    const { client } = await connected();
    const result = await call(client, "llamactl_fleet_proposals", { journalPath: path });
    const parsed = JSON.parse(textOf(result)) as { proposals: FleetProposalEntry[]; total: number };
    expect(parsed.proposals).toHaveLength(1);
    expect(parsed.proposals[0]!.proposalId).toBe("prop-2");
    expect(parsed.total).toBe(1);
  });

  test("pendingOnly=false returns all proposals", async () => {
    const p1 = proposal("node-a", "2026-01-01T00:01:00Z", "prop-A");
    const ex1 = execution("node-a", "2026-01-01T00:01:30Z", "prop-A");
    const p2 = proposal("node-a", "2026-01-01T00:02:00Z", "prop-B");
    const path = writeJournal([p1, ex1, p2]);
    const { client } = await connected();
    const result = await call(client, "llamactl_fleet_proposals", {
      journalPath: path,
      pendingOnly: false,
    });
    const parsed = JSON.parse(textOf(result)) as { proposals: FleetProposalEntry[]; total: number };
    expect(parsed.total).toBe(2);
  });

  test("node filter restricts proposals", async () => {
    const p1 = proposal("node-a", "2026-01-01T00:01:00Z", "p-a");
    const p2 = proposal("node-b", "2026-01-01T00:02:00Z", "p-b");
    const path = writeJournal([p1, p2]);
    const { client } = await connected();
    const result = await call(client, "llamactl_fleet_proposals", {
      journalPath: path,
      node: "node-b",
      pendingOnly: false,
    });
    const parsed = JSON.parse(textOf(result)) as { proposals: FleetProposalEntry[] };
    expect(parsed.proposals).toHaveLength(1);
    expect(parsed.proposals[0]!.proposalId).toBe("p-b");
  });

  test("results are most-recent-first and limit is respected", async () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      proposal("node-a", `2026-01-01T00:0${String(i)}:00Z`, `p-${String(i)}`),
    );
    const path = writeJournal(entries);
    const { client } = await connected();
    const result = await call(client, "llamactl_fleet_proposals", {
      journalPath: path,
      pendingOnly: false,
      limit: 3,
    });
    const parsed = JSON.parse(textOf(result)) as { proposals: FleetProposalEntry[]; total: number };
    expect(parsed.proposals).toHaveLength(3);
    expect(parsed.total).toBe(10);
    expect(parsed.proposals[0]!.ts > parsed.proposals[1]!.ts).toBe(true);
  });
});

// ── llamactl_fleet_executions ────────────────────────────────────────────────

describe("llamactl_fleet_pressure_status", () => {
  test("empty journal -> empty nodes", async () => {
    const path = writeJournal([]);
    const { client } = await connected();
    const result = await call(client, "llamactl_fleet_pressure_status", { journalPath: path });
    const parsed = parseJson<{ nodes: unknown[] }>(textOf(result));
    expect(parsed).toEqual({ nodes: [] });
  });

  test("returns derived status from transitions and status entries", async () => {
    const path = writeJournal([
      {
        kind: "fleet-transition",
        ts: "2026-05-23T10:00:00.000Z",
        node: "local",
        subject: "node",
        subjectKind: "node",
        signal: "pressure",
        from: "NORMAL",
        to: "HIGH",
      },
      {
        kind: "fleet-pressure-status",
        ts: "2026-05-23T10:01:00.000Z",
        node: "local",
        state: "HIGH",
        enteredAt: "2026-05-23T10:00:00.000Z",
        durationMs: 60000,
        consecutiveClearTicks: 2,
        clearTicksNeeded: 5,
        free_mb: 100,
        compressor_mb: 200,
        headroomBreach: true,
        compressorBreach: false,
      },
    ] as unknown as FleetJournalEntry[]);
    const { client } = await connected();
    const result = await call(client, "llamactl_fleet_pressure_status", { journalPath: path });
    const parsed = JSON.parse(textOf(result)) as {
      nodes: { state: string; consecutiveClearTicks: number; recent: unknown[] }[];
    };
    expect(parsed.nodes).toHaveLength(1);
    expect(parsed.nodes[0]!.state).toBe("HIGH");
    expect(parsed.nodes[0]!.consecutiveClearTicks).toBe(2);
    expect(parsed.nodes[0]!.recent).toHaveLength(1);
  });

  test("deprecated alias returns same shape and warns once", async () => {
    const path = writeJournal([
      {
        kind: "fleet-pressure-status",
        ts: "2026-05-23T10:01:00.000Z",
        node: "local",
        state: "NORMAL",
        enteredAt: "2026-05-23T10:00:00.000Z",
        durationMs: 60000,
        consecutiveClearTicks: 2,
        clearTicksNeeded: 5,
        free_mb: 100,
        compressor_mb: 200,
        headroomBreach: false,
        compressorBreach: false,
      },
    ] as unknown as FleetJournalEntry[]);
    const { client } = await connected();

    const baseline = await call(client, "llamactl_fleet_pressure_status", { journalPath: path });
    const expected = parseJson<unknown>(textOf(baseline));
    const previous = console.error;
    const errorLines: string[] = [];
    console.error = ((...args: unknown[]) =>
      errorLines.push(args.map((arg) => String(arg)).join(" "))) as typeof console.error;

    try {
      const first = await call(client, "llamactl_fleet_supervisor_status", { journalPath: path });
      const second = await call(client, "llamactl_fleet_supervisor_status", { journalPath: path });
      const aliasedFirst = parseJson<unknown>(textOf(first));
      const aliasedSecond = parseJson<unknown>(textOf(second));

      expect(aliasedFirst).toEqual(expected);
      expect(aliasedSecond).toEqual(expected);
      const warningLines = errorLines.filter((line) =>
        line.includes(
          "[llamactl-mcp] deprecated: llamactl_fleet_supervisor_status -> llamactl_fleet_pressure_status; will be removed",
        ),
      );
      expect(warningLines).toHaveLength(1);
    } finally {
      console.error = previous;
    }
  });
});

describe("llamactl_fleet_audit", () => {
  test("empty journal -> empty entries", async () => {
    const path = writeJournal([]);
    const { client } = await connected();
    const result = await call(client, "llamactl_fleet_audit", { auditPath: path });
    const parsed = JSON.parse(textOf(result)) as {
      entries: unknown[];
      total: number;
      auditPath: string;
      malformedLines: number;
    };
    expect(parsed).toEqual({ entries: [], total: 0, auditPath: path, malformedLines: 0 });
  });

  test("returns derived status from audit entries", async () => {
    const path = writeJournal([
      {
        kind: "mcp-audit",
        ts: "2026-05-23T10:00:00.000Z",
        tool: "test-tool",
        input: { a: 1 },
        outcome: "success",
        detail: {},
      },
    ] as unknown as FleetJournalEntry[]);
    const { client } = await connected();
    const result = await call(client, "llamactl_fleet_audit", { auditPath: path });
    const parsed = JSON.parse(textOf(result)) as { entries: { tool: string }[]; total: number };
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]!.tool).toBe("test-tool");
    expect(parsed.total).toBe(1);
  });
});

describe("llamactl_fleet_executions", () => {
  test("empty journal → empty executions", async () => {
    const path = writeJournal([]);
    const { client } = await connected();
    const result = await call(client, "llamactl_fleet_executions", { journalPath: path });
    const parsed = JSON.parse(textOf(result)) as { executions: unknown[]; total: number };
    expect(parsed.executions).toEqual([]);
    expect(parsed.total).toBe(0);
  });

  test("returns executions most-recent-first with correct total", async () => {
    const entries = [
      execution("node-a", "2026-01-01T00:01:00Z", "p-1"),
      execution("node-a", "2026-01-01T00:02:00Z", "p-2"),
      execution("node-b", "2026-01-01T00:03:00Z", "p-3"),
    ];
    const path = writeJournal(entries);
    const { client } = await connected();
    const result = await call(client, "llamactl_fleet_executions", {
      journalPath: path,
      limit: 2,
    });
    const parsed = JSON.parse(textOf(result)) as {
      executions: FleetExecutionEntry[];
      total: number;
    };
    expect(parsed.total).toBe(3);
    expect(parsed.executions).toHaveLength(2);
    expect(parsed.executions[0]!.ts > parsed.executions[1]!.ts).toBe(true);
  });

  test("node filter restricts executions", async () => {
    const path = writeJournal([
      execution("node-a", "2026-01-01T00:01:00Z", "pa-1"),
      execution("node-b", "2026-01-01T00:02:00Z", "pb-1"),
    ]);
    const { client } = await connected();
    const result = await call(client, "llamactl_fleet_executions", {
      journalPath: path,
      node: "node-a",
    });
    const parsed = JSON.parse(textOf(result)) as { executions: FleetExecutionEntry[] };
    expect(parsed.executions).toHaveLength(1);
    expect(parsed.executions[0]!.proposalId).toBe("pa-1");
  });

  test("sinceIsoTs filters out older entries", async () => {
    const path = writeJournal([
      execution("node-a", "2026-01-01T00:01:00Z", "old"),
      execution("node-a", "2026-01-01T00:03:00Z", "new"),
    ]);
    const { client } = await connected();
    const result = await call(client, "llamactl_fleet_executions", {
      journalPath: path,
      sinceIsoTs: "2026-01-01T00:02:00Z",
    });
    const parsed = JSON.parse(textOf(result)) as { executions: FleetExecutionEntry[] };
    expect(parsed.executions).toHaveLength(1);
    expect(parsed.executions[0]!.proposalId).toBe("new");
  });
});

// ── llamactl_fleet_journal_tail ──────────────────────────────────────────────

describe("llamactl_fleet_journal_tail", () => {
  test("empty journal → empty entries", async () => {
    const path = writeJournal([]);
    const { client } = await connected();
    const result = await call(client, "llamactl_fleet_journal_tail", { journalPath: path });
    const parsed = JSON.parse(textOf(result)) as { entries: unknown[] };
    expect(parsed.entries).toEqual([]);
  });

  test("returns last N entries in chronological order", async () => {
    const entries: FleetJournalEntry[] = [
      snapshot("node-a", "2026-01-01T00:00:00Z"),
      heartbeat("node-a", "2026-01-01T00:01:00Z"),
      snapshot("node-a", "2026-01-01T00:02:00Z"),
      heartbeat("node-a", "2026-01-01T00:03:00Z"),
      snapshot("node-a", "2026-01-01T00:04:00Z"),
    ];
    const path = writeJournal(entries);
    const { client } = await connected();
    const result = await call(client, "llamactl_fleet_journal_tail", {
      journalPath: path,
      limit: 3,
    });
    const parsed = JSON.parse(textOf(result)) as { entries: FleetJournalEntry[] };
    expect(parsed.entries).toHaveLength(3);
    expect(parsed.entries[0]!.ts).toBe("2026-01-01T00:02:00Z");
    expect(parsed.entries[2]!.ts).toBe("2026-01-01T00:04:00Z");
  });

  test("kinds filter restricts entry types", async () => {
    const path = writeJournal([
      snapshot("node-a", "2026-01-01T00:00:00Z"),
      heartbeat("node-a", "2026-01-01T00:01:00Z"),
      snapshot("node-a", "2026-01-01T00:02:00Z"),
    ]);
    const { client } = await connected();
    const result = await call(client, "llamactl_fleet_journal_tail", {
      journalPath: path,
      kinds: ["fleet-heartbeat"],
    });
    const parsed = JSON.parse(textOf(result)) as { entries: FleetJournalEntry[] };
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]!.kind).toBe("fleet-heartbeat");
  });

  test("node filter restricts entries to that node", async () => {
    const path = writeJournal([
      snapshot("node-a", "2026-01-01T00:00:00Z"),
      snapshot("node-b", "2026-01-01T00:01:00Z"),
      heartbeat("node-a", "2026-01-01T00:02:00Z"),
    ]);
    const { client } = await connected();
    const result = await call(client, "llamactl_fleet_journal_tail", {
      journalPath: path,
      node: "node-b",
    });
    const parsed = JSON.parse(textOf(result)) as { entries: FleetJournalEntry[] };
    expect(parsed.entries).toHaveLength(1);
    expect((parsed.entries[0] as FleetSnapshotEntry).node).toBe("node-b");
  });

  test("mixed journal with node + kinds filter", async () => {
    const path = writeJournal([
      snapshot("node-a", "2026-01-01T00:00:00Z"),
      heartbeat("node-a", "2026-01-01T00:01:00Z"),
      snapshot("node-b", "2026-01-01T00:02:00Z"),
      snapshot("node-a", "2026-01-01T00:03:00Z"),
    ]);
    const { client } = await connected();
    const result = await call(client, "llamactl_fleet_journal_tail", {
      journalPath: path,
      node: "node-a",
      kinds: ["fleet-snapshot"],
    });
    const parsed = JSON.parse(textOf(result)) as { entries: FleetJournalEntry[] };
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries.every((e) => e.kind === "fleet-snapshot")).toBe(true);
    expect(parsed.entries.every((e) => (e as FleetSnapshotEntry).node === "node-a")).toBe(true);
  });
});
