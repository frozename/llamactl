import { server } from "@llamactl/core";
import { expect, mock, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openAdmissionAuthority } from "../../src/residency/admission-authority.js";
import {
  createManagedLaunchAdmission,
  type ManagedLaunchAdmission,
} from "../../src/residency/managed-launch-admission.js";
import { router } from "../../src/router.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";
import { type RunningAgent, startAgentServer } from "../../src/server/serve.js";

async function terminalResults(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const results: unknown[] = [];
  for await (const event of stream) {
    if (typeof event === "object" && event !== null && "type" in event && event.type === "done") {
      results.push("result" in event ? event.result : undefined);
    }
  }
  return results;
}

test("serverStart consults target admission before entering the runtime lifecycle", async () => {
  const run = mock(() =>
    Promise.resolve({ ran: false as const, detail: "test admission refusal" }),
  );
  const caller = router.createCaller({ managedLaunchAdmission: { run } });
  const input = { workload: "managed-router-missing-run", target: "missing/model.gguf" };
  const results = await terminalResults(await caller.serverStart(input));

  expect(run.mock.calls).toHaveLength(1);
  expect(run).toHaveBeenCalledWith(
    { kind: "ModelRun", runtimeKey: input.workload, launch: input },
    expect.any(AbortSignal),
    expect.any(Function),
  );
  expect(results).toEqual([
    expect.objectContaining({ ok: false, pid: null, error: "test admission refusal" }),
  ]);
});

test("modelHostStart consults target admission before entering the runtime lifecycle", async () => {
  const run = mock(() =>
    Promise.resolve({ ran: false as const, detail: "test admission refusal" }),
  );
  const caller = router.createCaller({ managedLaunchAdmission: { run } });
  const input = { workload: "managed-router-missing-host" };
  const results = await terminalResults(await caller.modelHostStart(input));

  expect(run.mock.calls).toHaveLength(1);
  expect(run).toHaveBeenCalledWith(
    { kind: "ModelHost", runtimeKey: input.workload, launch: input },
    expect.any(AbortSignal),
    expect.any(Function),
  );
  expect(results).toEqual([{ ok: false, pid: null, error: "test admission refusal" }]);
});

test("modelHostStart withholds its runtime terminal event until managed admission settles", async () => {
  const managed: ManagedLaunchAdmission = {
    async run(_request, _signal, start) {
      const runtime = await start(() => undefined);
      if (!runtime.ran) throw new Error(runtime.detail);
      expect(runtime.result).toMatchObject({ ok: false });
      expect("error" in runtime.result && runtime.result.error).toMatch(/refusing to bind/);
      return { ran: false, detail: "target verification failed" };
    },
  };
  const caller = router.createCaller({ managedLaunchAdmission: managed });
  const results = await terminalResults(
    await caller.modelHostStart({
      workload: "managed-terminal",
      manifest: {
        apiVersion: "llamactl/v1",
        kind: "ModelHost",
        metadata: { name: "managed-terminal" },
        spec: {
          engine: "omlx",
          node: "local",
          binary: "/usr/bin/false",
          endpoint: { host: "0.0.0.0", port: 19092 },
          hostedModels: [{ rel: "test-model.gguf" }],
        },
      },
    }),
  );

  expect(results).toEqual([{ ok: false, pid: null, error: "target verification failed" }]);
});

test("authenticated agent starts share one mixed-kind memory budget", async () => {
  const dir = mkdtempSync(join(tmpdir(), "managed-launch-router-"));
  const authority = openAdmissionAuthority({
    storePath: join(dir, "admission.db"),
    budgetGiB: () => 24,
    observe: () => undefined,
    readPidFile: () => undefined,
    owner: { pid: process.pid },
  });
  const gate = createManagedLaunchAdmission({
    authority,
    resolve: ({ runtimeKey }) => ({ specDigest: runtimeKey, allocationGiB: 8 }),
    capture: () => undefined,
  });
  let agent: RunningAgent | undefined;
  try {
    const occupying = authority.admit({
      kind: "ModelHost",
      runtimeKey: "resident-host",
      specDigest: "host",
      allocationGiB: 24,
    });
    expect(occupying.kind).toBe("admitted");
    const bearer = "managed-launch-fixture";
    agent = startAgentServer({
      tokenHash: createHash("sha256").update(bearer).digest("hex"),
      managedLaunchAdmission: gate,
    });
    for (const [procedure, input] of [
      ["serverStart", { workload: "denied-run", target: "missing/model.gguf" }],
      [
        "modelHostStart",
        {
          workload: "denied-host",
          manifest: {
            apiVersion: "llamactl/v1",
            kind: "ModelHost",
            metadata: { name: "denied-host" },
            spec: {
              engine: "omlx",
              node: "local",
              binary: "/usr/bin/false",
              endpoint: { host: "127.0.0.1", port: 19092 },
              hostedModels: [{ rel: "test-model.gguf" }],
            },
          },
        },
      ],
    ] as const) {
      const url = new URL(`http://127.0.0.1:${String(agent.port)}/trpc/${procedure}`);
      url.searchParams.set("input", JSON.stringify(input));
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${bearer}` },
        signal: AbortSignal.timeout(3000),
      });
      expect(response.status).toBe(200);
      const results = (await response.text()).split("\n").flatMap((line) => {
        if (!line.startsWith("data: {")) return [];
        const event = JSON.parse(line.slice(6)) as { type?: string; result?: unknown };
        return event.type === "done" ? [event.result] : [];
      });
      expect(results).toEqual([
        expect.objectContaining({
          ok: false,
          pid: null,
          error: "BudgetExceeded: committed 24 GiB plus incoming 8 GiB exceeds budget 24 GiB",
        }),
      ]);
    }
    expect(authority.snapshot().map(({ runtimeKey, state }) => [runtimeKey, state])).toEqual([
      ["resident-host", "pending"],
    ]);
  } finally {
    await agent?.stop();
    authority.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an already canceled caller passes cancellation to the managed launch gate", async () => {
  const managed: ManagedLaunchAdmission = {
    run(_request, signal, start) {
      if (signal.aborted) return Promise.resolve({ ran: false, detail: "already canceled" });
      return start(() => undefined);
    },
  };
  const caller = router.createCaller(
    { managedLaunchAdmission: managed },
    { signal: AbortSignal.abort() },
  );
  const results = await terminalResults(
    await caller.serverStart({
      workload: "canceled-managed-router",
      target: "missing/model.gguf",
    }),
  );
  expect(results).toEqual([expect.objectContaining({ ok: false, error: "already canceled" })]);
});

test("serverStart publishes ready only after managed admission commits", async () => {
  const endpoint = "http://127.0.0.1:19092";
  const pid = 1234;
  const startSpy = spyOn(server, "startServer").mockImplementation((opts) => {
    opts.onEvent?.({ type: "ready", pid, endpoint });
    return Promise.resolve({
      ok: true,
      pid,
      endpoint,
      advertisedEndpoint: endpoint,
      tunedProfile: null,
      retried: false,
    });
  });
  try {
    const input = { workload: "managed-run", target: "missing/model.gguf" };
    for (const accepted of [true, false]) {
      const managed: ManagedLaunchAdmission = {
        async run(_request, _signal, start) {
          const result = await start(() => undefined);
          return accepted ? result : { ran: false, detail: "claim commit failed" };
        },
      };
      const stream = await router
        .createCaller({ managedLaunchAdmission: managed })
        .serverStart(input);
      const types: string[] = [];
      for await (const event of stream) types.push(event.type);
      expect(types).toEqual(accepted ? ["ready", "done"] : ["done"]);
    }
  } finally {
    startSpy.mockRestore();
  }
});
