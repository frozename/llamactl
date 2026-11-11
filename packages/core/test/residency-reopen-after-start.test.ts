/**
 * #278 (DF-05) — RED pins for reopening residency admission after every
 * successful start path. The router's serverStart/modelHostStart already
 * reopen through remote's reopenWorkloadAfterLoad; the remaining gap is
 * the core keepAlive supervisor (runKeepAliveWorker → startServer) and
 * the shared core helpers the fix is expected to add. Helpers that do
 * not exist at the base commit are read off the module namespace so
 * every case fails by assertion, never by a missing export or a type
 * error.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { readKeepAliveState, runKeepAliveWorker, sleepWithAbort } from "../src/keepAlive.js";
import * as leasesMod from "../src/residency/leases.js";
import {
  createResidencyLeases,
  type ResidencyLeases,
  setResidencyLeaseRegistry,
} from "../src/residency/leases.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "../src/safe-fs.js";
import { envForTemp, makeTempRuntime } from "./helpers.js";

type WithReopenAfterLoad = <R>(
  workload: string,
  start: () => Promise<R>,
  isLoaded: (result: R) => boolean,
  registry?: ResidencyLeases | null,
) => Promise<R>;

type ReopenWorkloadAfterLoad = (
  workload: string,
  loaded: boolean,
  registry?: ResidencyLeases | null,
) => void;

function requireWithReopenAfterLoad(): WithReopenAfterLoad {
  const raw = (leasesMod as unknown as Record<string, unknown>)["withReopenAfterLoad"];
  expect(typeof raw).toBe("function");
  return raw as WithReopenAfterLoad;
}

function requireReopenWorkloadAfterLoad(): ReopenWorkloadAfterLoad {
  const raw = (leasesMod as unknown as Record<string, unknown>)["reopenWorkloadAfterLoad"];
  expect(typeof raw).toBe("function");
  return raw as ReopenWorkloadAfterLoad;
}

function parkUnloaded(reg: ResidencyLeases, workload: string): number {
  const drain = reg.beginDrain(workload);
  if (!drain.ok) {
    throw new Error(`beginDrain(${workload}) refused: ${drain.reason}`);
  }
  expect(reg.commitUnload(drain.token).ok).toBe(true);
  expect(reg.snapshot(workload).phase).toBe("unloaded");
  return reg.snapshot(workload).epoch;
}

// A bash + Bun fake that impersonates a serving engine: it binds a loopback
// port and answers `/health` (llama-server readiness) and `/v1/models`
// (ModelHost readiness) with 200, then blocks until SIGTERM. Mirrors
// writeFakeServer in packages/remote/test/residency/stop-fence.test.ts.
function writeFakeServer(path: string, host: string, port: number): void {
  const js =
    "const s=Bun.serve({hostname:" +
    JSON.stringify(host) +
    ",port:" +
    String(port) +
    ",fetch(req){const u=new URL(req.url);" +
    "if(u.pathname==='/health')return new Response('ok',{status:200});" +
    "if(u.pathname==='/v1/models')return Response.json({data:[{id:'m'}]});" +
    "return new Response('stub',{status:200});}});" +
    "process.on('SIGTERM',()=>{s.stop(true);process.exit(0);});" +
    "await new Promise(()=>undefined);";
  const script =
    "#!/bin/bash\nexec -a llama-server " +
    JSON.stringify(process.execPath) +
    " -e " +
    JSON.stringify(js) +
    "\n";
  writeFileSync(path, script, { mode: 0o755 });
}

describe("start primitives reopen admission after a verified stop (#278 DF-05)", () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  let originalEnv: NodeJS.ProcessEnv;

  // Fake llama-server processes the keepAlive worker spawned. The worker's
  // cleanup stopServer cannot prove the fake's identity (its argv drops the
  // model rel), so the record is reaped here instead of leaking a listener.
  const spawnedServerPids = new Set<number>();

  beforeEach(() => {
    temp = makeTempRuntime();
    originalEnv = { ...process.env };
    for (const [k, v] of Object.entries(envForTemp(temp))) {
      if (v !== undefined) process.env[k] = v;
    }
    setResidencyLeaseRegistry(null);
    mkdirSync(temp.runtimeDir, { recursive: true });
  });

  afterEach(() => {
    setResidencyLeaseRegistry(null);
    for (const pid of spawnedServerPids) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already gone; nothing to clean.
      }
    }
    spawnedServerPids.clear();
    process.env = originalEnv;
    temp.cleanup();
  });

  function setupFakeEngine(host: string): void {
    const binDir = join(temp.devStorage, "fake-bin");
    mkdirSync(binDir, { recursive: true });
    const port = 18300 + Math.floor(Math.random() * 80);
    writeFakeServer(join(binDir, "llama-server"), host, port);
    const modelDir = join(temp.modelsDir, "Demo");
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, "demo.gguf"), "GGUF-fake");
    Object.assign(process.env, {
      LLAMA_CPP_BIN: binDir,
      LLAMA_CPP_LOGS: join(temp.devStorage, "logs"),
      LLAMA_CPP_HOST: host,
      LLAMA_CPP_PORT: String(port),
      LLAMA_CPP_USE_TUNED_ARGS: "false",
    });
  }

  function recordServerPid(workload: string): void {
    const file = join(temp.runtimeDir, "workloads", workload, "llama-server.pid");
    if (!existsSync(file)) {
      return;
    }
    const pid = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
    if (Number.isFinite(pid) && pid > 0) {
      spawnedServerPids.add(pid);
    }
  }

  test("a keepAlive restart that comes up ok reopens a verified-stopped workload", async () => {
    const reg = createResidencyLeases();
    setResidencyLeaseRegistry(reg);
    const workload = "ka-wl";
    const epoch = parkUnloaded(reg, workload);
    setupFakeEngine("127.0.0.1");

    const controller = new AbortController();
    let escaped: unknown = null;
    const worker = runKeepAliveWorker({
      key: { name: workload },
      target: "Demo/demo.gguf",
      intervalSeconds: 60,
      signal: controller.signal,
    }).catch((error: unknown) => {
      escaped = error;
    });

    let state = readKeepAliveState();
    for (let i = 0; i < 1000 && state?.state !== "ready"; i += 1) {
      await sleepWithAbort(0.01);
      state = readKeepAliveState();
    }
    recordServerPid(workload);

    const snap = reg.snapshot(workload);
    const acq = reg.acquire(workload);

    controller.abort();
    await worker;
    recordServerPid(workload);
    if (acq.ok) {
      acq.lease.release();
    }

    expect(state?.state).toBe("ready");
    expect(escaped).toBeNull();
    expect(snap.phase).toBe("open");
    expect(snap.epoch).toBe(epoch);
    expect(acq.ok).toBe(true);
    if (acq.ok) {
      expect(acq.lease.epoch).toBe(epoch);
    }
  });

  test("a failed keepAlive restart keeps the workload unloaded", async () => {
    const reg = createResidencyLeases();
    setResidencyLeaseRegistry(reg);
    const workload = "ka-fail-wl";
    const epoch = parkUnloaded(reg, workload);
    setupFakeEngine("0.0.0.0");

    const controller = new AbortController();
    let escaped: unknown = null;
    const worker = runKeepAliveWorker({
      key: { name: workload },
      target: "Demo/demo.gguf",
      intervalSeconds: 60,
      signal: controller.signal,
    }).catch((error: unknown) => {
      escaped = error;
    });

    let state = readKeepAliveState();
    for (let i = 0; i < 1000 && state?.state !== "start-failed"; i += 1) {
      await sleepWithAbort(0.01);
      state = readKeepAliveState();
    }

    controller.abort();
    await worker;

    const snap = reg.snapshot(workload);
    const acq = reg.acquire(workload);

    expect(state?.state).toBe("start-failed");
    expect(escaped).toBeNull();
    expect(snap.phase).toBe("unloaded");
    expect(snap.epoch).toBe(epoch);
    expect(acq.ok).toBe(false);
    if (!acq.ok) {
      expect(acq.reason).toBe("Unloaded");
    }
  });

  test("withReopenAfterLoad is inert without a published registry", async () => {
    const withReopenAfterLoad = requireWithReopenAfterLoad();

    const p = Promise.resolve({ ok: true });
    let calls = 0;
    const out = withReopenAfterLoad(
      "w",
      () => p,
      () => {
        calls += 1;
        return true;
      },
    );
    expect(out).toBe(p);
    await out;
    expect(calls).toBe(0);

    const p2 = Promise.resolve({ ok: true });
    let calls2 = 0;
    const out2 = withReopenAfterLoad(
      "w",
      () => p2,
      () => {
        calls2 += 1;
        return true;
      },
      null,
    );
    expect(out2).toBe(p2);
    await out2;
    expect(calls2).toBe(0);
  });

  test("withReopenAfterLoad reopens only on a loaded result and never on failure or rejection", async () => {
    const withReopenAfterLoad = requireWithReopenAfterLoad();
    const reg = createResidencyLeases();

    const failEpoch = parkUnloaded(reg, "wa");
    const failed = { ok: false };
    const outFailed = await withReopenAfterLoad(
      "wa",
      () => Promise.resolve(failed),
      (r) => r.ok,
      reg,
    );
    expect(outFailed).toEqual(failed);
    expect(reg.snapshot("wa").phase).toBe("unloaded");
    expect(reg.snapshot("wa").epoch).toBe(failEpoch);

    const rejectEpoch = parkUnloaded(reg, "wb");
    // eslint-disable-next-line @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun's rejects matcher is typed as void.
    await expect(
      withReopenAfterLoad(
        "wb",
        () => Promise.reject(new Error("start blew up")),
        () => true,
        reg,
      ),
    ).rejects.toThrow("start blew up");
    expect(reg.snapshot("wb").phase).toBe("unloaded");
    expect(reg.snapshot("wb").epoch).toBe(rejectEpoch);

    const loadEpoch = parkUnloaded(reg, "wc");
    const loaded = { ok: true, pid: 4321 };
    const outLoaded = await withReopenAfterLoad(
      "wc",
      () => Promise.resolve(loaded),
      (r) => r.ok,
      reg,
    );
    expect(outLoaded).toEqual(loaded);
    expect(reg.snapshot("wc").phase).toBe("open");
    expect(reg.snapshot("wc").epoch).toBe(loadEpoch);

    const outOpen = await withReopenAfterLoad(
      "wd",
      () => Promise.resolve({ ok: true }),
      (r) => r.ok,
      reg,
    );
    expect(outOpen).toEqual({ ok: true });
    expect(reg.snapshot("wd")).toEqual({
      workload: "wd",
      phase: "open",
      epoch: 0,
      active: [],
      waiters: 0,
    });
  });

  test("core exports reopenWorkloadAfterLoad with the remote signature", () => {
    const reopenWorkloadAfterLoad = requireReopenWorkloadAfterLoad();
    const reg = createResidencyLeases();

    const epoch = parkUnloaded(reg, "wr");
    reopenWorkloadAfterLoad("wr", true, reg);
    expect(reg.snapshot("wr").phase).toBe("open");
    expect(reg.snapshot("wr").epoch).toBe(epoch);

    const failEpoch = parkUnloaded(reg, "wr2");
    reopenWorkloadAfterLoad("wr2", false, reg);
    expect(reg.snapshot("wr2").phase).toBe("unloaded");
    expect(reg.snapshot("wr2").epoch).toBe(failEpoch);
  });
});
