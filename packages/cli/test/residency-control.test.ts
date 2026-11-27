import type { NodeClient } from "@llamactl/remote";

import { expect, mock, spyOn, test } from "bun:test";

import { runResidency } from "../src/commands/residency.js";

test("manual residency commands route preview and confirmed actions through the selected node client", async () => {
  const mutate = mock(() =>
    Promise.resolve({
      ok: true,
      action: "load",
      node: "gpu1",
      workload: "model",
      outcome: "preview",
    }),
  );
  const client = { residencyControl: { mutate } } as unknown as NodeClient;
  const getNodeClientByName = mock(() => client);
  const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    expect(
      await runResidency(["load", "model", "--node", "gpu1", "--json"], { getNodeClientByName }),
    ).toBe(0);
    expect(getNodeClientByName).toHaveBeenCalledWith("gpu1");
    expect(mutate).toHaveBeenLastCalledWith({
      action: "load",
      workload: "model",
      node: "gpu1",
      dryRun: true,
      confirm: false,
    });

    expect(
      await runResidency(["unload", "model", "--node", "gpu1", "--execute", "--yes"], {
        getNodeClientByName,
      }),
    ).toBe(0);
    expect(mutate).toHaveBeenLastCalledWith({
      action: "unload",
      workload: "model",
      node: "gpu1",
      dryRun: false,
      confirm: true,
    });
    expect(stdout).toHaveBeenCalledTimes(2);
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
});

test("an unconfirmed unload, forced option and fan-out perform no RPC", async () => {
  const getNodeClientByName = mock((): NodeClient => {
    throw new Error("unexpected dispatch");
  });
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    for (const args of [
      ["unload", "model", "--node", "gpu1", "--execute"],
      ["unload", "model", "--node", "gpu1", "--force"],
      ["load", "model", "--node", "all"],
    ]) {
      expect(await runResidency(args, { getNodeClientByName })).toBe(1);
    }
    expect(getNodeClientByName).not.toHaveBeenCalled();
  } finally {
    stderr.mockRestore();
  }
});

test("an older node reports the unavailable manual control cleanly", async () => {
  const absent = Object.assign(new Error("old private route details"), {
    data: { code: "NOT_FOUND" },
  });
  const mutate = mock(() => Promise.reject(absent));
  const client = { residencyControl: { mutate } } as unknown as NodeClient;
  const getNodeClientByName = mock(() => client);
  const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    expect(
      await runResidency(["load", "model", "--node", "gpu1", "--json"], { getNodeClientByName }),
    ).toBe(1);
    expect(stdout).toHaveBeenCalledWith(
      expect.stringContaining('"reason": "ManagedControlUnavailable"'),
    );
    expect(stdout).not.toHaveBeenCalledWith(expect.stringContaining("old private route details"));
  } finally {
    stdout.mockRestore();
  }
});
