import { writeModelHostState } from "@llamactl/core/engines/state";
import { resolveEnv } from "@llamactl/core/env";
import { expect, mock, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OmlxParkedProbeIdentity } from "../../src/server/modelhost.js";

import { router } from "../../src/router.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";

test("only a current owner-verified oMLX generation attests parking to the exact probe origin", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "llamactl-parked-omlx-status-"));
  const previousRuntime = process.env["LOCAL_AI_RUNTIME_DIR"];
  process.env["LOCAL_AI_RUNTIME_DIR"] = runtimeDir;
  const resolved = resolveEnv();
  const workload = "fixture-parked-omlx";
  const endpoint = { host: "127.0.0.1", port: 19097 };
  const key = { name: workload };
  const child = spawn("/bin/sleep", ["60"], { argv0: "omlx-server", stdio: "ignore" });
  const fetchSpy = spyOn(globalThis, "fetch");
  try {
    if (child.pid === undefined) throw new Error("missing fixture pid");
    const runtime = {
      kind: "ModelHost" as const,
      engine: "omlx" as const,
      pid: child.pid,
      startedAt: new Date().toISOString(),
      host: endpoint.host,
      port: endpoint.port,
      modelAliases: ["fixture"],
      specHash: "parked-spec",
    };
    writeModelHostState(runtime, key, resolved);
    const expected: OmlxParkedProbeIdentity = {
      workload,
      pid: child.pid,
      startedAt: runtime.startedAt,
      specHash: runtime.specHash,
      endpoint,
    };
    let found = true;
    let moveBeforeReply = false;
    const verifyParkedOmlxProbe = mock(
      async (identity: OmlxParkedProbeIdentity): Promise<boolean> => {
        expect(identity).toEqual(expected);
        await Promise.resolve();
        if (moveBeforeReply)
          writeModelHostState({ ...runtime, startedAt: "2026-01-01T00:00:00.000Z" }, key, resolved);
        return found;
      },
    );
    const managed = {
      ownerNodeId: "fixture-owner",
      run: (): Promise<{ ran: false; detail: string }> =>
        Promise.resolve({ ran: false, detail: "fixture" }),
      verifyParkedOmlxProbe,
    };
    const caller = router.createCaller({ managedLaunchAdmission: managed });
    const input = { workload, probeOrigin: "http://127.0.0.1:19097" };
    expect(await caller.modelHostStatus(input)).toMatchObject({
      state: "Running",
      probeParked: true,
    });
    expect(await caller.modelHostStatus({ workload })).not.toHaveProperty("probeParked");
    expect(
      await caller.modelHostStatus({ ...input, probeOrigin: "http://127.0.0.1:19098" }),
    ).not.toHaveProperty("probeParked");
    expect(await router.createCaller({}).modelHostStatus(input)).not.toHaveProperty("probeParked");
    expect(verifyParkedOmlxProbe).toHaveBeenCalledTimes(1);

    found = false;
    expect(await caller.modelHostStatus(input)).not.toHaveProperty("probeParked");
    found = true;
    moveBeforeReply = true;
    expect(await caller.modelHostStatus(input)).not.toHaveProperty("probeParked");
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
    child.kill("SIGKILL");
    if (previousRuntime === undefined) Reflect.deleteProperty(process.env, "LOCAL_AI_RUNTIME_DIR");
    else process.env["LOCAL_AI_RUNTIME_DIR"] = previousRuntime;
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});
