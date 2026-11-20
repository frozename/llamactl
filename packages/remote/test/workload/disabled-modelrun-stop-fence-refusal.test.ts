// Part of #522: disabling a ModelRun whose serverStop is refused by the
// node stop fence (leases, drain or sessions) must surface the refusal
// instead of reporting Stopped. At the pinned base, stopDisabledWorkload
// ignores the serverStop outcome entirely, so every refusal case fails by
// assertion while the verified-stop and already-down guards pass.
import { describe, expect, test } from "bun:test";

import type { ModelRun } from "../../src/workload/schema.js";

import { applyOne, type WorkloadClient } from "../../src/workload/apply.js";
import { parseWorkload } from "../../src/workload/store.js";

const STATUS_UP = {
  state: "up",
  rel: "fake-org/fake.gguf",
  extraArgs: [] as string[],
  pid: 4242,
  host: "127.0.0.1",
  port: 8080,
  binary: null,
  endpoint: "http://127.0.0.1:8080",
};

const STATUS_DOWN = {
  state: "down",
  rel: null,
  extraArgs: [] as string[],
  pid: null,
  host: null,
  port: null,
  binary: null,
  endpoint: "http://127.0.0.1:8080",
};

function makeManifest(): ModelRun {
  return parseWorkload(
    [
      "apiVersion: llamactl/v1",
      "kind: ModelRun",
      "metadata:",
      "  name: chat-a",
      "spec:",
      "  node: gpu1",
      "  enabled: false",
      "  target:",
      "    kind: rel",
      "    value: fake-org/fake.gguf",
      "  restartPolicy: Always",
      "",
    ].join("\n"),
  );
}

interface StopCall {
  workload: string;
  graceSeconds?: number;
}

function noopSubscription(): { unsubscribe(): undefined } {
  return {
    unsubscribe(): undefined {
      return undefined;
    },
  };
}

function makeClient(opts: {
  status?: typeof STATUS_UP | typeof STATUS_DOWN;
  stopOutcome?: unknown;
}): { client: WorkloadClient; stops: StopCall[] } {
  const stops: StopCall[] = [];
  const client: WorkloadClient = {
    serverStatus: {
      query: () => Promise.resolve(opts.status ?? STATUS_UP),
    },
    serverStop: {
      mutate: (input: StopCall) => {
        stops.push(input);
        return Promise.resolve(opts.stopOutcome ?? { stopped: true, pid: 4242, killed: false });
      },
    },
    serverStart: { subscribe: () => noopSubscription() },
    modelHostStart: { subscribe: () => noopSubscription() },
    modelHostStop: { mutate: () => Promise.resolve({}) },
    modelHostStatus: { query: () => Promise.resolve({ state: "Stopped", pid: null }) },
    rpcServerStart: { subscribe: () => noopSubscription() },
    rpcServerStop: { mutate: () => Promise.resolve({}) },
    rpcServerDoctor: {
      query: () => Promise.resolve({ ok: true, path: null, llamaCppBin: null }),
    },
  };
  return { client, stops };
}

/** The refused-stop status every refusal reason must produce. */
function refusedConditions(message: string): unknown[] {
  return [
    {
      type: "Applied",
      status: "False",
      reason: "StopRefused",
      message,
      lastTransitionTime: "<ignored>",
    },
  ];
}

function stableConditions(result: { statusSection: { conditions: object[] } }): unknown[] {
  return result.statusSection.conditions.map((c) => ({ ...c, lastTransitionTime: "<ignored>" }));
}

describe("#522 disabled ModelRun stop-fence refusal", () => {
  // Kills: ignoring the serverStop outcome at apply.ts:1517 — the refusal
  // must fail the apply, keep the live Running status and stamp StopRefused.
  test("a: SessionsActive refusal fails the apply and preserves live status", async () => {
    const { client } = makeClient({
      stopOutcome: {
        stopped: false,
        pid: null,
        killed: false,
        refused: { reason: "SessionsActive", active: ["s1", "s2"] },
      },
    });

    const result = await applyOne(makeManifest(), () => client);

    expect(result.error).toBe("serverStop refused: SessionsActive: s1, s2");
    expect(result.statusSection.phase).toBe("Running");
    expect(result.statusSection.serverPid).toBe(4242);
    expect(result.statusSection.endpoint).toBe("http://127.0.0.1:8080");
    expect({ ...result.statusSection.conditions[0], lastTransitionTime: "<ignored>" }).toEqual({
      type: "Applied",
      status: "False",
      reason: "StopRefused",
      message: "serverStop refused: SessionsActive: s1, s2",
      lastTransitionTime: "<ignored>",
    });
    // Kills: appending an extra condition (e.g. an invented "Live" entry)
    // when the refusal lists active ids — the refused status is exactly the
    // one StopRefused condition.
    expect(stableConditions(result)).toEqual(
      refusedConditions("serverStop refused: SessionsActive: s1, s2"),
    );
  });

  // Kills: an unconditional `: ${active.join(", ")}` suffix — an empty id
  // list must leave no trailing colon.
  test("b: SessionsUnknown refusal reports the reason without an id suffix", async () => {
    const { client } = makeClient({
      stopOutcome: {
        stopped: false,
        pid: null,
        killed: false,
        refused: { reason: "SessionsUnknown", active: [] },
      },
    });

    const result = await applyOne(makeManifest(), () => client);

    expect(result.error).toBe("serverStop refused: SessionsUnknown");
    // Kills: a refusal without ids reporting a different status shape than
    // one with ids — same phase, pid, endpoint and single condition.
    expect(result.statusSection.phase).toBe("Running");
    expect(result.statusSection.serverPid).toBe(4242);
    expect(result.statusSection.endpoint).toBe("http://127.0.0.1:8080");
    expect(stableConditions(result)).toEqual(
      refusedConditions("serverStop refused: SessionsUnknown"),
    );
  });

  // Kills: hard-coding the refusal reason to the session cases — lease and
  // drain refusals surface through the same path.
  for (const [reason, active, expected] of [
    ["LeasesActive", ["lease-1"], "serverStop refused: LeasesActive: lease-1"],
    ["DrainInProgress", ["lease-2"], "serverStop refused: DrainInProgress: lease-2"],
  ] as const) {
    test(`c: ${reason} refusal reports the active id`, async () => {
      const { client } = makeClient({
        stopOutcome: {
          stopped: false,
          pid: null,
          killed: false,
          refused: { reason, active: [...active] },
        },
      });

      const result = await applyOne(makeManifest(), () => client);

      expect(result.error).toBe(expected);
    });
  }

  // Guard: a verified stop keeps the existing Stopped/Disabled outcome.
  // Kills: dropping the `typeof x === "string"` filter in serverStopFenceRefusal,
  // or re-deriving the ids inline without it. The outcome arrives over RPC
  // typed unknown, so non-string entries must never reach the message.
  test("f: non-string active entries are dropped from the refusal message", async () => {
    const { client } = makeClient({
      stopOutcome: {
        stopped: false,
        pid: null,
        killed: false,
        refused: { reason: "SessionsActive", active: ["s1", 7, null, "s2"] },
      },
    });

    const result = await applyOne(makeManifest(), () => client);

    expect(result.error).toBe("serverStop refused: SessionsActive: s1, s2");
    expect(stableConditions(result)).toEqual(
      refusedConditions("serverStop refused: SessionsActive: s1, s2"),
    );
  });

  // Kills: reporting `status.pid ?? 0`. serverStatus can be up with a null pid
  // (core reports up whenever the endpoint answers), and the refused status
  // must carry that null rather than inventing pid 0.
  test("g: an up server with a null pid keeps serverPid null on refusal", async () => {
    const { client } = makeClient({
      status: { ...STATUS_DOWN, state: "up" },
      stopOutcome: {
        stopped: false,
        pid: null,
        killed: false,
        refused: { reason: "SessionsUnknown", active: [] },
      },
    });

    const result = await applyOne(makeManifest(), () => client);

    expect(result.error).toBe("serverStop refused: SessionsUnknown");
    expect(result.statusSection.phase).toBe("Running");
    expect(result.statusSection.serverPid).toBeNull();
  });

  test("d: a verified stop still reports Stopped with the Disabled condition", async () => {
    const { client, stops } = makeClient({
      stopOutcome: { stopped: true, pid: 4242, killed: false },
    });

    const result = await applyOne(makeManifest(), () => client);

    expect(result.statusSection.phase).toBe("Stopped");
    expect(result.statusSection.conditions[0]?.reason).toBe("Disabled");
    expect(result.error).toBeUndefined();
    expect(stops).toEqual([{ workload: "chat-a", graceSeconds: 5 }]);
  });

  // Guard: an already-down server skips serverStop entirely.
  test("e: an already-down server is not stopped again", async () => {
    const { client, stops } = makeClient({ status: STATUS_DOWN });

    const result = await applyOne(makeManifest(), () => client);

    expect(stops).toEqual([]);
    expect(result.statusSection.phase).toBe("Stopped");
  });
});
