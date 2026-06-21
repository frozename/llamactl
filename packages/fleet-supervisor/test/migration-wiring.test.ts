/* eslint-disable @typescript-eslint/require-await -- Test doubles implement async migration contracts without artificial scheduling. */
import { afterEach, describe, expect, it } from "bun:test";

import { createEnabledMigrationController } from "../src/index.js";

describe("migration controller wiring gate", () => {
  const original = process.env["LLAMACTL_FLEET_MOVE_ENABLED"];

  afterEach(() => {
    if (original === undefined) {
      delete process.env["LLAMACTL_FLEET_MOVE_ENABLED"];
      return;
    }
    process.env["LLAMACTL_FLEET_MOVE_ENABLED"] = original;
  });

  it("returns null when LLAMACTL_FLEET_MOVE_ENABLED is absent", () => {
    delete process.env["LLAMACTL_FLEET_MOVE_ENABLED"];

    const controller = createEnabledMigrationController({
      peers: [],
      fetchSnapshot: async () => ({
        pressureState: "NORMAL",
        nodeMem: { freeMb: 4096 },
        workloads: [],
      }),
      selfNode: "m4pro",
      getLeaseHolder: () => "m4pro",
    });

    expect(controller).toBeNull();
  });

  it("constructs a controller when LLAMACTL_FLEET_MOVE_ENABLED=1", () => {
    process.env["LLAMACTL_FLEET_MOVE_ENABLED"] = "1";

    const controller = createEnabledMigrationController({
      peers: [],
      fetchSnapshot: async () => ({
        pressureState: "NORMAL",
        nodeMem: { freeMb: 4096 },
        workloads: [],
      }),
      deployWorkload: async () => undefined,
      removeWorkload: async () => undefined,
      selfNode: "m4pro",
      getLeaseHolder: () => "m4pro",
    });

    expect(controller).not.toBeNull();
  });
});
