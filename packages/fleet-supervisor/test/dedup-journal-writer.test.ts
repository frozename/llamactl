import { describe, expect, it } from "bun:test";

import type { FleetJournalEntry, FleetProposalEntry } from "../src/types.js";

import { makeDedupJournalWriter } from "../src/loop-helpers.js";

function makeProposal(proposalId: string): FleetProposalEntry {
  return {
    kind: "fleet-proposal",
    ts: "2026-01-01T00:00:00.000Z",
    node: "local",
    proposalId,
    transition: {
      subject: "workload-x",
      subjectKind: "workload",
      signal: "pressure",
      from: "NORMAL",
      to: "HIGH",
    },
    action: { type: "evict", workload: "workload-x", reason: "memory" },
  };
}

describe("makeDedupJournalWriter", () => {
  it("passes the first occurrence of a proposal through", () => {
    const received: FleetJournalEntry[] = [];
    const write = makeDedupJournalWriter((e) => received.push(e));
    write(makeProposal("id-1"));
    expect(received).toHaveLength(1);
  });

  it("deduplicates a duplicate proposalId within the window", () => {
    const received: FleetJournalEntry[] = [];
    const write = makeDedupJournalWriter((e) => received.push(e));
    write(makeProposal("id-1"));
    write(makeProposal("id-1"));
    expect(received).toHaveLength(1);
  });

  it("passes non-proposal entries through unconditionally", () => {
    const received: FleetJournalEntry[] = [];
    const write = makeDedupJournalWriter((e) => received.push(e));
    write({ kind: "fleet-heartbeat", ts: "2026-01-01T00:00:00.000Z", node: "local" });
    write({ kind: "fleet-heartbeat", ts: "2026-01-01T00:00:01.000Z", node: "local" });
    expect(received).toHaveLength(2);
  });

  it("bounds seen-ids to DEDUP_WINDOW_MAX — evicts oldest when full", () => {
    const received: FleetJournalEntry[] = [];
    const write = makeDedupJournalWriter((e) => received.push(e));
    const COUNT = 300; // well above the 256 cap
    for (let i = 0; i < COUNT; i++) {
      write(makeProposal(`id-${String(i)}`));
    }
    // All unique → all pass through.
    expect(received).toHaveLength(COUNT);

    // id-0 was written first and must have been evicted once the ring filled.
    // An unbounded Set would still contain it → the second write would be silently
    // dropped (deduped). The bounded fix must let it through again.
    const before = received.length;
    write(makeProposal("id-0"));
    expect(received).toHaveLength(before + 1);
  });

  it("still deduplicates a recent id that remains within the window", () => {
    const received: FleetJournalEntry[] = [];
    const write = makeDedupJournalWriter((e) => received.push(e));
    const COUNT = 300;
    for (let i = 0; i < COUNT; i++) {
      write(makeProposal(`id-${String(i)}`));
    }
    // id-299 is the most recently written — still in the window.
    const before = received.length;
    write(makeProposal(`id-${String(COUNT - 1)}`));
    expect(received).toHaveLength(before); // still deduped
  });
});
