import { afterEach, describe, expect, it } from "bun:test";

import {
  createMigrationController,
  type FleetJournalEntry,
  startSupervisorLoop,
} from "../src/index.js";

describe("migration supervisor integration", () => {
  const original = process.env.LLAMACTL_FLEET_MOVE_ENABLED;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.LLAMACTL_FLEET_MOVE_ENABLED;
      return;
    }
    process.env.LLAMACTL_FLEET_MOVE_ENABLED = original;
  });

  it("emits a move fleet-proposal when migration is enabled and a NORMAL→HIGH transition is journaled", async () => {
    process.env.LLAMACTL_FLEET_MOVE_ENABLED = "1";

    const entries: FleetJournalEntry[] = [];
    let moved = false;
    const controller = createMigrationController({
      peers: ["m2mini", "m4pro"],
      fetchSnapshot: async (node) => {
        if (node === "m2mini") {
          return {
            node: "m2mini",
            schedulerLeaseHolder: "m4pro",
            pressureState: "NORMAL",
            nodeMem: { freeMb: 8192 },
            workloads: [{ name: "model-a", reachable: moved }],
          };
        }

        return {
          node: "m4pro",
          schedulerLeaseHolder: "m4pro",
          pressureState: "HIGH",
          nodeMem: { freeMb: 128 },
          workloads: [],
        };
      },
      deployWorkload: async () => {
        moved = true;
      },
      removeWorkload: async () => undefined,
      leaseholder: "m4pro",
      getNowMs: () => 1_700_000_000_000,
    });

    const handle = startSupervisorLoop({
      node: "m4pro",
      once: true,
      workloads: [{ name: "model-a", endpoint: "http://model-a", kind: "ModelHost" }],
      probeNodeMem: async () => ({
        free_mb: 128,
        active_mb: 0,
        inactive_mb: 0,
        wired_mb: 0,
        compressor_mb: 4000,
        swap_in: 0,
        swap_out: 0,
      }),
      probeWorkload: async () => ({
        name: "model-a",
        kind: "ModelHost",
        endpoint: "http://model-a",
        priority: 50,
        rss_mb: null,
        request_rate_5m: null,
        error_rate_5m: 0,
        p50_ms: 10,
        p95_ms: 10,
        models: [],
        reachable: true,
        consecutiveErrors: 0,
      }),
      writeJournal: (entry) => entries.push(entry),
      migrationController: controller,
      pressureThresholds: {
        headroomMinMb: 512,
        compressorWarnMb: 2048,
        consecutiveTicks: 1,
        clearTicks: 5,
      },
    });

    await handle.done;

    const transition = entries.find(
      (entry): entry is FleetJournalEntry & { kind: "fleet-transition" } =>
        entry.kind === "fleet-transition" && entry.from === "NORMAL" && entry.to === "HIGH",
    );
    expect(transition).toBeTruthy();

    const moveProposal = entries.find(
      (entry) => entry.kind === "fleet-proposal" && entry.action.type === "move",
    );
    expect(moveProposal).toBeTruthy();
  });

  it("does not emit a move fleet-proposal when migration is disabled", async () => {
    delete process.env.LLAMACTL_FLEET_MOVE_ENABLED;

    const entries: FleetJournalEntry[] = [];
    const handle = startSupervisorLoop({
      node: "m4pro",
      once: true,
      workloads: [{ name: "model-a", endpoint: "http://model-a", kind: "ModelHost" }],
      probeNodeMem: async () => ({
        free_mb: 128,
        active_mb: 0,
        inactive_mb: 0,
        wired_mb: 0,
        compressor_mb: 4000,
        swap_in: 0,
        swap_out: 0,
      }),
      probeWorkload: async () => ({
        name: "model-a",
        kind: "ModelHost",
        endpoint: "http://model-a",
        priority: 50,
        rss_mb: null,
        request_rate_5m: null,
        error_rate_5m: 0,
        p50_ms: 10,
        p95_ms: 10,
        models: [],
        reachable: true,
        consecutiveErrors: 0,
      }),
      writeJournal: (entry) => entries.push(entry),
    });

    await handle.done;

    expect(
      entries.some((entry) => entry.kind === "fleet-proposal" && entry.action.type === "move"),
    ).toBe(false);
  });
});
