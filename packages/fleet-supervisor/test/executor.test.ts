/* eslint-disable @typescript-eslint/require-await -- Test doubles implement async executor contracts without artificial scheduling. */
import { describe, expect, it } from "bun:test";

import type { FleetExecutionEntry, FleetJournalEntry, FleetProposalEntry } from "../src/types.js";

import { actionTier, type ExecutorOptions, runExecutor } from "../src/executor.js";

const TS = "2026-05-22T10:00:00.000Z";
const NODE = "test-node";

function makeProposal(
  id: string,
  actionType: "mark-degraded" | "evict" | "restart" | "place" | "move" | "drain",
  workload = "qwen-host",
  node = NODE,
): FleetProposalEntry {
  return {
    kind: "fleet-proposal",
    ts: TS,
    node,
    proposalId: id,
    transition: {
      subject: workload,
      subjectKind: "workload",
      signal: "degraded",
      from: "healthy",
      to: "degraded",
    },
    action:
      actionType === "place"
        ? { type: "place", workload, node: node, reason: "test" }
        : actionType === "move"
          ? { type: "move", workload, fromNode: node, toNode: NODE, reason: "test" }
          : actionType === "drain"
            ? { type: "drain", node, reason: "test" }
            : { type: actionType, workload, reason: "test" },
  };
}

function makeOpts(
  journal: FleetJournalEntry[],
  overrides: Partial<ExecutorOptions> = {},
): { opts: ExecutorOptions; written: FleetJournalEntry[] } {
  const written: FleetJournalEntry[] = [];
  const opts: ExecutorOptions = {
    node: NODE,
    auto: false,
    severityThreshold: 2,
    journalPath: "/fake/path",
    writeJournal: (e) => written.push(e),
    readJournal: () => journal,
    disable: async () => 0,
    enable: async () => 0,
    ...overrides,
  };
  return { opts, written };
}

describe("actionTier", () => {
  it("mark-degraded is tier 2", () => {
    expect(actionTier({ type: "mark-degraded", workload: "w", reason: "r" })).toBe(2);
  });

  it("evict is tier 3", () => {
    expect(actionTier({ type: "evict", workload: "w", reason: "r" })).toBe(3);
  });

  it("restart is tier 3", () => {
    expect(actionTier({ type: "restart", workload: "w", reason: "r" })).toBe(3);
  });

  it("place is tier 1", () => {
    expect(actionTier({ type: "place", workload: "w", node: "n", reason: "r" })).toBe(1);
  });

  it("move is tier 2", () => {
    expect(
      actionTier({ type: "move", workload: "w", fromNode: "a", toNode: "b", reason: "r" }),
    ).toBe(2);
  });

  it("drain is tier 2", () => {
    expect(actionTier({ type: "drain", node: "n", reason: "r" })).toBe(2);
  });
});

describe("runExecutor", () => {
  it("empty journal → no results", async () => {
    const { opts } = makeOpts([]);
    const results = await runExecutor(opts);
    expect(results).toHaveLength(0);
  });

  it("skips proposal when --auto not set", async () => {
    const proposal = makeProposal("p1", "mark-degraded");
    const { opts, written } = makeOpts([proposal], { auto: false });
    const results = await runExecutor(opts);
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("skipped");
    expect(results[0]!.reason).toContain("--auto");
    expect(written[0]!.kind).toBe("fleet-execution");
  });

  it("skips evict when threshold=2 and auto=true (tier 3 > threshold 2)", async () => {
    const proposal = makeProposal("p1", "evict");
    const { opts, written } = makeOpts([proposal], { auto: true, severityThreshold: 2 });
    const results = await runExecutor(opts);
    expect(results[0]!.status).toBe("skipped");
    expect(results[0]!.reason).toContain("tier 3");
    expect(written).toHaveLength(1);
  });

  it("executes mark-degraded when auto=true and threshold=2", async () => {
    const proposal = makeProposal("p1", "mark-degraded");
    const { opts, written } = makeOpts([proposal], { auto: true, severityThreshold: 2 });
    const results = await runExecutor(opts);
    expect(results[0]!.status).toBe("executed");
    const exec = written[0] as FleetExecutionEntry;
    expect(exec.kind).toBe("fleet-execution");
    expect(exec.proposalId).toBe("p1");
    expect(exec.status).toBe("executed");
  });

  it("executes evict when auto=true and threshold=3", async () => {
    const calls: string[] = [];
    const proposal = makeProposal("p1", "evict", "qwen-host");
    const { opts, written } = makeOpts([proposal], {
      auto: true,
      severityThreshold: 3,
      disable: async (w) => {
        calls.push(w);
        return 0;
      },
    });
    const results = await runExecutor(opts);
    expect(results[0]!.status).toBe("executed");
    expect(calls).toEqual(["qwen-host"]);
    const exec = written[0] as FleetExecutionEntry;
    expect(exec.exitCode).toBe(0);
  });

  it("executes restart when auto=true and threshold=3: calls disable then enable in order", async () => {
    const calls: string[] = [];
    const proposal = makeProposal("p1", "restart", "granite-host");
    const { opts } = makeOpts([proposal], {
      auto: true,
      severityThreshold: 3,
      disable: async (w) => {
        calls.push(`disable:${w}`);
        return 0;
      },
      enable: async (w) => {
        calls.push(`enable:${w}`);
        return 0;
      },
    });
    const results = await runExecutor(opts);
    expect(results[0]!.status).toBe("executed");
    expect(calls).toEqual(["disable:granite-host", "enable:granite-host"]);
  });

  it("idempotency: skips proposal whose proposalId already appears as fleet-execution", async () => {
    const proposal = makeProposal("p1", "mark-degraded");
    const existing: FleetExecutionEntry = {
      kind: "fleet-execution",
      ts: TS,
      node: NODE,
      proposalId: "p1",
      action: proposal.action,
      status: "executed",
    };
    const { opts, written } = makeOpts([proposal, existing], { auto: true, severityThreshold: 2 });
    const results = await runExecutor(opts);
    expect(results).toHaveLength(0);
    expect(written).toHaveLength(0);
  });

  it("--execute=<id> overrides tier and auto for that proposal", async () => {
    const proposal = makeProposal("p1", "evict");
    const { opts } = makeOpts([proposal], {
      auto: false,
      severityThreshold: 2,
      executeId: "p1",
    });
    const results = await runExecutor(opts);
    expect(results[0]!.status).toBe("executed");
  });

  it("--execute=<id> does not affect other proposals in the same journal", async () => {
    const p1 = makeProposal("p1", "mark-degraded");
    const p2 = makeProposal("p2", "mark-degraded");
    const { opts } = makeOpts([p1, p2], {
      auto: false,
      executeId: "p1",
    });
    const results = await runExecutor(opts);
    expect(results).toHaveLength(2);
    expect(results[0]!.status).toBe("executed");
    expect(results[1]!.status).toBe("skipped");
  });

  it("disable failure → status=failed with exitCode", async () => {
    const proposal = makeProposal("p1", "evict", "bad-host");
    const { opts } = makeOpts([proposal], {
      auto: true,
      severityThreshold: 3,
      disable: async () => 1,
    });
    const results = await runExecutor(opts);
    expect(results[0]!.status).toBe("failed");
    expect(results[0]!.exitCode).toBe(1);
  });

  it("restart: disable failure → status=failed, enable is never called", async () => {
    const enableCalls: string[] = [];
    const proposal = makeProposal("p1", "restart", "bad-host");
    const { opts } = makeOpts([proposal], {
      auto: true,
      severityThreshold: 3,
      disable: async () => 1,
      enable: async (w) => {
        enableCalls.push(w);
        return 0;
      },
    });
    const results = await runExecutor(opts);
    expect(results[0]!.status).toBe("failed");
    expect(enableCalls).toHaveLength(0);
  });

  it("processes only proposals for the matching node", async () => {
    const p1 = makeProposal("p1", "mark-degraded", "w", NODE);
    const p2 = makeProposal("p2", "mark-degraded", "w", "other-node");
    const { opts } = makeOpts([p1, p2], { auto: true, severityThreshold: 2 });
    const results = await runExecutor(opts);
    expect(results).toHaveLength(1);
    expect(results[0]!.proposalId).toBe("p1");
  });

  it("execution entry carries proposalId, action, node, and kind=fleet-execution", async () => {
    const proposal = makeProposal("p-abc", "mark-degraded", "my-workload");
    const { opts, written } = makeOpts([proposal], { auto: true });
    await runExecutor(opts);
    const exec = written[0] as FleetExecutionEntry;
    expect(exec.kind).toBe("fleet-execution");
    expect(exec.proposalId).toBe("p-abc");
    expect(exec.node).toBe(NODE);
    expect(exec.action.type).toBe("mark-degraded");
    if (exec.action.type === "mark-degraded") {
      expect(exec.action.workload).toBe("my-workload");
    }
  });

  it("disable throws → status=failed with reason", async () => {
    const proposal = makeProposal("p1", "evict");
    const { opts } = makeOpts([proposal], {
      auto: true,
      severityThreshold: 3,
      disable: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const results = await runExecutor(opts);
    expect(results[0]!.status).toBe("failed");
    expect(results[0]!.reason).toContain("ECONNREFUSED");
  });

  it("expired proposal skipped with reason=expired and disable not called", async () => {
    const proposal: FleetProposalEntry = {
      ...makeProposal("p1", "evict"),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    };
    let disableCalls = 0;
    const { opts, written } = makeOpts([proposal], {
      auto: true,
      severityThreshold: 3,
      disable: async () => {
        disableCalls += 1;
        return 0;
      },
    });
    const results = await runExecutor(opts);
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("skipped");
    expect(results[0]!.reason).toBe("expired");
    expect(disableCalls).toBe(0);
    expect(written).toHaveLength(1);
    expect(written[0]!.kind).toBe("fleet-execution");
  });

  it("proposal without expiresAt executes normally", async () => {
    const proposal = makeProposal("p1", "mark-degraded");
    expect(proposal.expiresAt).toBeUndefined();
    const { opts } = makeOpts([proposal], { auto: true, severityThreshold: 2 });
    const results = await runExecutor(opts);
    expect(results[0]!.status).toBe("executed");
  });

  it("future expiresAt still executes (not yet expired)", async () => {
    const proposal: FleetProposalEntry = {
      ...makeProposal("p1", "mark-degraded"),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const { opts } = makeOpts([proposal], { auto: true, severityThreshold: 2 });
    const results = await runExecutor(opts);
    expect(results[0]!.status).toBe("executed");
  });
});

describe("executeRestart enable-failure recovery", () => {
  it("restart: enable failure triggers bounded recovery re-enable; recovery succeeds → status=executed", async () => {
    let enableCallCount = 0;
    const proposal = makeProposal("p1", "restart", "test-host");
    const { opts, written } = makeOpts([proposal], {
      auto: true,
      severityThreshold: 3,
      disable: async () => 0,
      enable: async () => {
        enableCallCount++;
        if (enableCallCount === 1) return 1;
        return 0;
      },
    });
    const results = await runExecutor(opts);
    expect(enableCallCount).toBe(2);
    expect(results[0]!.status).toBe("executed");
    expect(written).toHaveLength(1);
  });

  it("restart: enable failure + recovery re-enable failure → writes a retryable failure entry", async () => {
    const proposal = makeProposal("p1", "restart", "test-host");
    const { opts, written } = makeOpts([proposal], {
      auto: true,
      severityThreshold: 3,
      disable: async () => 0,
      enable: async () => 1,
    });
    const results = await runExecutor(opts);
    const retryEntry = written[0] as FleetExecutionEntry;
    expect(retryEntry.attempt).toBe(1);
    expect(retryEntry.maxAttempts).toBe(3);
    expect(retryEntry.nextAttemptAt).toBeDefined();
    expect(results[0]!.status).toBe("failed");
  });

  it("retryable failure is re-attempted on a later tick after backoff", async () => {
    const proposal = makeProposal("p1", "restart", "test-host");
    const proposalJournal: FleetJournalEntry[] = [proposal];
    const t0 = Date.parse("2026-07-01T10:00:00.000Z");

    const first = makeOpts(proposalJournal, {
      auto: true,
      severityThreshold: 3,
      nowMs: t0,
      disable: async () => 0,
      enable: async () => 1,
    });
    const firstResults = await runExecutor(first.opts);
    const failed = first.written[0] as FleetExecutionEntry;
    expect(firstResults).toHaveLength(1);
    expect(failed.status).toBe("failed");
    expect(failed.attempt).toBe(1);
    expect(failed.nextAttemptAt).toBeTruthy();

    const pendingJournal: FleetJournalEntry[] = [...proposalJournal, ...first.written];
    const blocked = makeOpts(pendingJournal, {
      auto: true,
      severityThreshold: 3,
      nowMs: Date.parse(failed.nextAttemptAt!) - 1000,
      disable: async () => 0,
      enable: async () => 0,
    });
    const blockedResults = await runExecutor(blocked.opts);
    expect(blockedResults).toHaveLength(0);

    const retried = makeOpts(pendingJournal, {
      auto: true,
      severityThreshold: 3,
      nowMs: Date.parse(failed.nextAttemptAt!) + 1000,
      disable: async () => 0,
      enable: async () => 0,
    });
    const retriedResults = await runExecutor(retried.opts);
    expect(retriedResults).toHaveLength(1);
    expect(retriedResults[0]!.status).toBe("executed");
  });

  it("give-up is journaled after retry cap and no further attempts occur", async () => {
    const proposal = makeProposal("p1", "restart", "test-host");
    let journal: FleetJournalEntry[] = [proposal];
    let nowMs = Date.parse("2026-07-01T10:00:00.000Z");
    let terminalFailure: FleetExecutionEntry | null = null;

    for (let i = 0; i < 3; i += 1) {
      const { opts, written } = makeOpts(journal, {
        auto: true,
        severityThreshold: 3,
        nowMs,
        disable: async () => 0,
        enable: async () => 1,
      });
      const tickResults = await runExecutor(opts);
      expect(tickResults).toHaveLength(1);
      const entry = tickResults[0]!;
      terminalFailure = entry;
      journal = [...journal, ...written];
      if (entry.attempt === 3) break;
      expect(entry.nextAttemptAt).toBeTruthy();
      nowMs = Date.parse(entry.nextAttemptAt!) + 1_000;
    }

    expect(terminalFailure).not.toBeNull();
    expect(terminalFailure!.attempt).toBe(3);
    expect(terminalFailure!.reason).toContain("giving up");

    const { opts: finalAttempt } = makeOpts(journal, {
      auto: true,
      severityThreshold: 3,
      nowMs: nowMs + 1_000,
      disable: async () => 0,
      enable: async () => 1,
    });
    const finalResults = await runExecutor(finalAttempt);
    expect(finalResults).toHaveLength(0);
  });
});

describe("runExecutor restartPolicy:Never gate", () => {
  it("does NOT evict a Never-policy workload but still evicts a default-policy one", async () => {
    const disabled: string[] = [];
    const protectedProposal = makeProposal("p-never", "evict", "pinned-host");
    const evictableProposal = makeProposal("p-default", "evict", "qwen-host");
    const { opts, written } = makeOpts([protectedProposal, evictableProposal], {
      auto: true,
      severityThreshold: 3,
      loadRestartPolicy: (name) => (name === "pinned-host" ? "Never" : "Always"),
      disable: async (w) => {
        disabled.push(w);
        return 0;
      },
    });

    const results = await runExecutor(opts);

    const never = results.find((r) => r.proposalId === "p-never")!;
    expect(never.status).toBe("skipped");
    expect(never.reason).toBe("restartPolicy:Never");

    const def = results.find((r) => r.proposalId === "p-default")!;
    expect(def.status).toBe("executed");

    expect(disabled).toEqual(["qwen-host"]);
    const skipped = written.find(
      (e): e is FleetExecutionEntry => e.kind === "fleet-execution" && e.proposalId === "p-never",
    )!;
    expect(skipped.status).toBe("skipped");
  });

  it("does NOT restart a Never-policy workload (no disable/enable calls)", async () => {
    const calls: string[] = [];
    const proposal = makeProposal("p1", "restart", "pinned-host");
    const { opts } = makeOpts([proposal], {
      auto: true,
      severityThreshold: 3,
      loadRestartPolicy: () => "Never",
      disable: async (w) => {
        calls.push(`disable:${w}`);
        return 0;
      },
      enable: async (w) => {
        calls.push(`enable:${w}`);
        return 0;
      },
    });

    const results = await runExecutor(opts);
    expect(results[0]!.status).toBe("skipped");
    expect(results[0]!.reason).toBe("restartPolicy:Never");
    expect(calls).toHaveLength(0);
  });

  it("restarts an OnFailure-policy workload (only Never is protected)", async () => {
    const calls: string[] = [];
    const proposal = makeProposal("p1", "restart", "granite-host");
    const { opts } = makeOpts([proposal], {
      auto: true,
      severityThreshold: 3,
      loadRestartPolicy: () => "OnFailure",
      disable: async (w) => {
        calls.push(`disable:${w}`);
        return 0;
      },
      enable: async (w) => {
        calls.push(`enable:${w}`);
        return 0;
      },
    });

    const results = await runExecutor(opts);
    expect(results[0]!.status).toBe("executed");
    expect(calls).toEqual(["disable:granite-host", "enable:granite-host"]);
  });

  it("evicts when loadRestartPolicy throws (manifest unreadable → no protection)", async () => {
    const disabled: string[] = [];
    const proposal = makeProposal("p1", "evict", "qwen-host");
    const { opts } = makeOpts([proposal], {
      auto: true,
      severityThreshold: 3,
      loadRestartPolicy: () => {
        throw new Error("manifest not found");
      },
      disable: async (w) => {
        disabled.push(w);
        return 0;
      },
    });

    const results = await runExecutor(opts);
    expect(results[0]!.status).toBe("executed");
    expect(disabled).toEqual(["qwen-host"]);
  });

  it("evicts normally when loadRestartPolicy is not provided (gate is opt-in)", async () => {
    const disabled: string[] = [];
    const proposal = makeProposal("p1", "evict", "qwen-host");
    const { opts } = makeOpts([proposal], {
      auto: true,
      severityThreshold: 3,
      disable: async (w) => {
        disabled.push(w);
        return 0;
      },
    });

    const results = await runExecutor(opts);
    expect(results[0]!.status).toBe("executed");
    expect(disabled).toEqual(["qwen-host"]);
  });
});
