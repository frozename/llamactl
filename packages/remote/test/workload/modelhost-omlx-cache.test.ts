import { readModelHostState } from "@llamactl/core/engines/state";
import { resolveEnv } from "@llamactl/core/env";
import { defaultReadProcessCommand } from "@llamactl/core/kvstore";
import { expect, test } from "bun:test";
import { type ChildProcess, execFileSync, spawn, type SpawnOptions } from "node:child_process";
import { dirname, join } from "node:path";

import { ENGINES } from "../../../core/src/engines/index.js";
import { envForTemp, makeTempRuntime } from "../../../core/test/helpers.js";
import { openNodeManagedAdmission } from "../../src/residency/target-admission-policy.js";
import { router } from "../../src/router.js";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "../../src/safe-fs.js";
import {
  startModelHost,
  type StartModelHostOptions,
  stopModelHost,
} from "../../src/server/modelhost.js";
import {
  modelHostPath,
  parseModelHost,
  saveModelHost,
} from "../../src/workload/modelhost-store.js";

const name = "omlx-cache-fixture";
const rel = "fixture-model";

function installFixture(root: string): {
  binary: string;
  interpreter: string;
  module: string;
  phase: string;
} {
  const venv = join(root, "venv");
  execFileSync("python3", ["-m", "venv", "--without-pip", venv], { timeout: 15_000 });
  const interpreter = join(venv, "bin", "python3");
  const packages = execFileSync(
    interpreter,
    ["-c", "import sysconfig; print(sysconfig.get_path('purelib'))"],
    { encoding: "utf8", timeout: 5000 },
  ).trim();
  const cli = join(packages, "omlx", "cli.py");
  const phase = join(root, "boot-phase.txt");
  mkdirSync(dirname(cli), { recursive: true });
  writeFileSync(join(dirname(cli), "__init__.py"), "");
  writeFileSync(
    cli,
    `
import sys
from pathlib import Path

def mark_phase(phase):
    if "--help" not in sys.argv:
        Path(${JSON.stringify(phase)}).write_text(phase)

mark_phase("module-entered")
import argparse
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import TCPServer

class LoopbackHTTPServer(HTTPServer):
    def server_bind(self):
        # HTTPServer resolves a hostname before listen(); this fixture only needs its numeric bind address.
        TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/v1/models":
            mark_phase("model-list-request")
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{"data":[{"id":"fixture-model"}]}')

def main():
    mark_phase("main-entered")
    parser = argparse.ArgumentParser()
    parser.add_argument("command")
    parser.add_argument("--model-dir")
    parser.add_argument("--host")
    parser.add_argument("--port", type=int)
    parser.add_argument("--memory-guard-gb")
    parser.add_argument("--base-path")
    parser.add_argument("--no-cache", action="store_true")
    parser.add_argument("--hf-cache", action=argparse.BooleanOptionalAction)
    parser.add_argument("--paged-ssd-cache-dir")
    parser.add_argument("--slot-save-path")
    args = parser.parse_args()
    if args.no_cache:
        config = Path(args.base_path) / "settings.json"
        settings = json.loads(config.read_text()) if config.exists() else {}
        settings.setdefault("cache", {})["enabled"] = False
        config.write_text(json.dumps(settings))
    witness = Path(args.base_path) / "cache-witness.txt"
    witness.write_text((args.paged_ssd_cache_dir or "") + "\\n" + (args.slot_save_path or ""))
    if args.paged_ssd_cache_dir:
        Path(args.paged_ssd_cache_dir, "cache.bin").touch()
    mark_phase("before-bind")
    server = LoopbackHTTPServer((args.host, args.port), Handler)
    mark_phase("listening")
    print(f"fixture pid {os.getpid()} listening on {args.host}:{args.port}", flush=True)
    server.serve_forever()
`,
  );
  const binary = join(venv, "bin", "omlx");
  writeFileSync(
    binary,
    `#!${interpreter}
import sys
from omlx.cli import main
if __name__ == "__main__":
    sys.exit(main())
`,
    { mode: 0o755 },
  );
  return { binary, interpreter, module: cli, phase };
}

type SpawnObservation = {
  child: ChildProcess;
  env: NodeJS.ProcessEnv | undefined;
  logFd: number | undefined;
  errorCode?: string;
};

function childStatus(observed: SpawnObservation | undefined):
  | {
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      errorCode: string | undefined;
    }
  | undefined {
  return (
    observed && {
      exitCode: observed.child.exitCode,
      signalCode: observed.child.signalCode,
      errorCode: observed.errorCode,
    }
  );
}

async function probeLauncherHelp(
  executable: string,
  args: string[],
  log: string,
  env: NodeJS.ProcessEnv | undefined,
): Promise<unknown> {
  let fd: number | undefined;
  try {
    fd = openSync(log, "w", 0o600);
    const child = spawn(executable, args, { detached: true, stdio: ["ignore", fd, fd], env });
    const result = await new Promise<object>((resolve) => {
      let timedOut = false;
      let reapTimer: ReturnType<typeof setTimeout> | undefined;
      let errorCode: string | undefined;
      const finish = (status: object): void => {
        clearTimeout(runTimer);
        clearTimeout(reapTimer);
        resolve({ pid: child.pid, timedOut, errorCode, ...status });
      };
      const onExit = (exitCode: number | null, signalCode: NodeJS.Signals | null): void => {
        finish({ exitCode, signalCode, ...(timedOut ? { reap: "confirmed" } : {}) });
      };
      const runTimer = setTimeout(() => {
        timedOut = true;
        reapTimer = setTimeout(() => {
          child.unref();
          finish({ reap: "unconfirmed" });
        }, 1000);
        try {
          child.kill("SIGKILL");
        } catch (error) {
          errorCode = (error as NodeJS.ErrnoException).code ?? "kill-error";
        }
      }, 1500);
      child.once("exit", onExit);
      child.once("close", onExit);
      child.once("error", (error: NodeJS.ErrnoException) => {
        errorCode = error.code ?? error.name;
        if (!timedOut) finish({});
      });
      if (child.exitCode !== null || child.signalCode !== null) {
        onExit(child.exitCode, child.signalCode);
      }
    });
    const output = readFileSync(log, "utf8");
    return { ...result, bytes: Buffer.byteLength(output), usage: output.includes("usage:") };
  } catch (error) {
    return { errorCode: (error as NodeJS.ErrnoException).code ?? "probe-error" };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function openLogDescriptors(path: string): number {
  const log = statSync(path);
  return readdirSync("/dev/fd")
    .map(Number)
    .filter((fd) => {
      try {
        const file = fstatSync(fd);
        return file.dev === log.dev && file.ino === log.ino;
      } catch {
        return false;
      }
    }).length;
}

test("the ModelHost reuses exact oMLX cache paths and rotates on every relevant input", async () => {
  const root = makeTempRuntime();
  using cleanup = { [Symbol.dispose]: root.cleanup };
  const { binary, interpreter, module, phase } = installFixture(root.devStorage);
  const traceBoot = process.env["LLAMACTL_TEST_TRACE_OMLX_BOOT"] === "1";
  if (traceBoot) {
    const version = execFileSync(interpreter, ["--version"], { encoding: "utf8", timeout: 5000 });
    const identity = {
      interpreter,
      resolved: realpathSync(interpreter),
      version: version.trim(),
      shebangBytes: Buffer.byteLength(`#!${interpreter}`),
    };
    process.stdout.write(`oMLX fixture interpreter ${JSON.stringify(identity)}\n`);
  }
  let observed: SpawnObservation | undefined;
  let atReadinessDeadline: ReturnType<typeof childStatus>;
  const observeSpawn = (
    executable: string,
    args: readonly string[],
    options: SpawnOptions,
  ): ChildProcess => {
    const child = spawn(executable, args, options);
    const fd = Array.isArray(options.stdio) ? options.stdio[1] : undefined;
    const observation: SpawnObservation = {
      child,
      env: options.env,
      logFd: typeof fd === "number" ? fd : undefined,
    };
    observed = observation;
    child.once("error", (error: NodeJS.ErrnoException) => {
      observation.errorCode = error.code ?? error.name;
    });
    return child;
  };
  const probeReady: NonNullable<StartModelHostOptions["probeReady"]> = async (...args) => {
    const readiness = await ENGINES.omlx.probeReady(...args);
    if (!readiness.ready) atReadinessDeadline = childStatus(observed);
    return readiness;
  };
  const env = {
    ...envForTemp(root),
    LLAMACTL_MODELS_DIR: root.modelsDir,
    LLAMACTL_RUNTIME_DIR: root.runtimeDir,
  };
  const key = { name };
  const options = {
    key,
    env,
    runtimeDir: root.runtimeDir,
    workloadsDir: join(root.devStorage, "desired"),
    identity: {
      processCommand(pid: number): string | null {
        const observed = defaultReadProcessCommand(pid);
        const commandStart = observed?.indexOf(` ${binary} serve `) ?? -1;
        return commandStart === -1 ? observed : (observed?.slice(commandStart + 1) ?? null);
      },
    },
  };
  const stop = async (): Promise<void> => {
    expect(await stopModelHost({ ...options, graceSeconds: 0 })).toMatchObject({ ok: true });
  };
  const legacy = join(root.runtimeDir, "workloads", name, ".omlx");
  const base = join(legacy, "managed-cache");
  const bootLog = join(dirname(legacy), "modelhost.boot.log");
  const legacySettings = JSON.stringify({ cache: { enabled: true }, local: "keep" });
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, "settings.json"), legacySettings);
  const file = join(root.modelsDir, rel, "weights.safetensors");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "original model fixture");
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const endpoint = { host: "127.0.0.1", port: reservation.port };
  await reservation.stop();
  const declarations = { epoch: 0, bits: 4 as 4 | 8, draft: undefined as string | undefined };
  const manifest = (): ReturnType<typeof parseModelHost> =>
    parseModelHost(
      JSON.stringify({
        apiVersion: "llamactl/v1",
        kind: "ModelHost",
        metadata: { name },
        spec: {
          engine: "omlx",
          node: "local",
          binary,
          endpoint,
          hostedModels: [
            {
              rel,
              omlx: {
                max_context_window: 8192,
                turboquant_kv_enabled: true,
                turboquant_kv_bits: declarations.bits,
                ...(declarations.draft === undefined
                  ? {}
                  : {
                      specprefill_enabled: true,
                      specprefill_draft_model: declarations.draft,
                    }),
              },
            },
          ],
          omlxCacheEpoch: declarations.epoch,
          extraArgs: ["--slot-save-path", "auto"],
          timeoutSeconds: 4,
          resources: { expectedMemoryGiB: 16 },
        },
      }),
    );
  const start = (checkSpawn?: () => undefined): ReturnType<typeof startModelHost> => {
    observed = undefined;
    atReadinessDeadline = undefined;
    rmSync(phase, { force: true });
    rmSync(join(base, "cache-witness.txt"), { force: true });
    return startModelHost({
      ...options,
      spawn: observeSpawn as typeof spawn,
      probeReady,
      ...(checkSpawn === undefined ? {} : { checkSpawn }),
      manifest: manifest(),
    });
  };
  const currentPaths = async (): Promise<{ prefix: string; slot: string }> => {
    const began = performance.now();
    const result = await start();
    if (!result.ok) {
      const elapsed = Math.round(performance.now() - began);
      const log = existsSync(bootLog)
        ? readFileSync(bootLog, "utf8").slice(-4096)
        : "(no boot log)";
      const diagnostics = {
        phase: existsSync(phase) ? readFileSync(phase, "utf8") : "not-entered",
        cacheWitness: existsSync(join(base, "cache-witness.txt")),
        logFd: observed?.logFd ?? null,
        atReadinessDeadline,
        afterTeardown: childStatus(observed),
      };
      const launcher =
        process.platform === "darwin" && observed !== undefined
          ? {
              directDetached: await probeLauncherHelp(
                binary,
                ["--help"],
                join(root.devStorage, "direct-help.log"),
                observed.env,
              ),
              explicitInterpreter: await probeLauncherHelp(
                interpreter,
                [binary, "--help"],
                join(root.devStorage, "explicit-help.log"),
                observed.env,
              ),
            }
          : undefined;
      throw new Error(
        `oMLX fixture boot failed after ${String(elapsed)} ms: ${JSON.stringify(result)}\n` +
          `boot evidence ${JSON.stringify({ ...diagnostics, launcher })}\n${log}`,
      );
    }
    const [prefix, slot] = readFileSync(join(base, "cache-witness.txt"), "utf8").split("\n");
    expect(prefix).toMatch(/\/cache-by-identity\/[a-f0-9]{64}\/prefix$/);
    expect(slot).toBe(prefix?.replace(/\/prefix$/, "/slots"));
    expect(readModelHostState(key, resolveEnv(env))?.slotSavePath).toBe(slot);
    if (!prefix || !slot) throw new Error("fixture has no namespaced paths");
    return { prefix, slot };
  };
  const previousDefaultWorkloads = process.env["LLAMACTL_WORKLOADS_DIR"];
  process.env["LLAMACTL_WORKLOADS_DIR"] = join(root.devStorage, "fallback-desired");
  try {
    const initial = await currentPaths();
    const initialPhase = readFileSync(phase, "utf8");
    if (traceBoot) process.stdout.write(`oMLX fixture initial boot phase ${initialPhase}\n`);
    expect(initialPhase).toBe("model-list-request");
    expect(existsSync(modelHostPath(name))).toBe(false);
    expect(existsSync(modelHostPath(name, options.workloadsDir))).toBe(true);
    writeFileSync(join(initial.slot, "request.slot"), "recorded slot");
    await stop();
    const settingsFile = join(base, "settings.json");
    const cache = {
      paged_cache_block_size: 256,
      hot_cache_only: false,
      gdn_snapshot_storage: "auto",
      gdn_sidecar_precision: "fp32",
    };
    writeFileSync(settingsFile, JSON.stringify({ cache }));

    const restart = await currentPaths();
    expect(restart).toEqual(initial);
    expect(readFileSync(join(restart.slot, "request.slot"), "utf8")).toBe("recorded slot");
    await stop();

    writeFileSync(file, "replacement model fixture");
    const changedModel = await currentPaths();
    expect(changedModel).not.toEqual(initial);
    await stop();

    writeFileSync(module, readFileSync(module, "utf8") + "\n# changed runtime build\n");
    const changedBuild = await currentPaths();
    expect(changedBuild).not.toEqual(changedModel);
    await stop();

    declarations.bits = 8;
    const changedSettings = await currentPaths();
    expect(changedSettings).not.toEqual(changedBuild);
    await stop();

    writeFileSync(
      settingsFile,
      JSON.stringify({ cache: { ...cache, gdn_sidecar_precision: "rht_int16" } }),
    );
    const changedPrecision = await currentPaths();
    expect(changedPrecision).not.toEqual(changedSettings);
    await stop();

    declarations.epoch = 1;
    const changedEpoch = await currentPaths();
    expect(changedEpoch).not.toEqual(changedPrecision);
    await stop();

    const priorDescriptors = openLogDescriptors(bootLog);
    const next = await start(() => {
      writeFileSync(file, "replacement during final admission");
      return undefined;
    });
    expect(next).toMatchObject({
      ok: false,
      pid: null,
      error: "oMLX cache inputs changed before spawn",
    });
    expect(openLogDescriptors(bootLog)).toBe(priorDescriptors);
    expect(priorDescriptors).toBe(0);
    const fixtureEnv = {
      ...env,
      LLAMACTL_WORKLOADS_DIR: options.workloadsDir,
      LLAMACTL_RESIDENCY_STORE: join(root.devStorage, "operations.sqlite"),
    };
    const oldEnv = Object.entries(fixtureEnv).map(([name]) => [name, process.env[name]] as const);
    Object.assign(process.env, fixtureEnv);
    const workloadsDir = fixtureEnv.LLAMACTL_WORKLOADS_DIR;
    let owner: Awaited<ReturnType<typeof openNodeManagedAdmission>> | undefined;
    let changes = 0;
    try {
      const desired = manifest();
      saveModelHost(desired, workloadsDir);
      owner = await openNodeManagedAdmission({
        nodeName: "local",
        workloadsDir,
        readCapacity: () => ({
          source: "linux-procfs",
          observedAtMs: Date.now(),
          physicalBytes: 64 * 1024 ** 3,
          availableBytes: 48 * 1024 ** 3,
          scope: { kind: "host-physical" },
          pressure: "normal",
          swapUsedBytes: 0,
        }),
        onCapacityAudit: (entry) => {
          if (entry.phase === "spawn") {
            writeFileSync(file, `replacement during owner spawn check ${String(++changes)}`);
          }
        },
      });
      const caller = router.createCaller({ managedLaunchAdmission: owner.admission });
      const ownerStart = async (): Promise<unknown[]> => {
        const events: unknown[] = [];
        for await (const event of await caller.modelHostStart({
          workload: name,
          manifest: desired,
        })) {
          events.push(event);
        }
        return events;
      };
      const events = await ownerStart();
      expect(owner.authority.snapshot()).toEqual([]);
      expect(changes).toBe(1);
      expect(events).toContainEqual({
        type: "done",
        result: { ok: false, pid: null, error: "oMLX cache inputs changed before spawn" },
      });
      const defaults = readFileSync(settingsFile, "utf8");
      writeFileSync(
        settingsFile,
        JSON.stringify({ cache, slot_save_path: join(root.devStorage, "untracked-slots") }),
      );
      const rejectedSettings = await ownerStart();
      expect(owner.authority.snapshot()).toEqual([]);
      expect(changes).toBe(1);
      expect(rejectedSettings).toContainEqual({
        type: "done",
        result: {
          ok: false,
          pid: null,
          error: "oMLX managed cache requires slot storage to be declared with --slot-save-path",
        },
      });
      writeFileSync(settingsFile, defaults);
    } finally {
      owner?.authority.close();
      for (const [name, value] of oldEnv) {
        if (value === undefined) Reflect.deleteProperty(process.env, name);
        else process.env[name] = value;
      }
    }

    const draft = join(root.modelsDir, "draft.safetensors");
    declarations.draft = draft;
    writeFileSync(draft, "first draft");
    const beforeDraftChange = await currentPaths();
    await stop();
    writeFileSync(draft, "updated draft");
    const changedDraft = await currentPaths();
    expect(changedDraft).not.toEqual(beforeDraftChange);
    await stop();
    declarations.draft = "unresolved/repository";
    expect(await start()).toMatchObject({ ok: true });
    expect(readFileSync(join(base, "cache-witness.txt"), "utf8")).toBe("\n");
    expect(readModelHostState(key, resolveEnv(env))?.slotSavePath).toBeNull();
    expect(readFileSync(settingsFile, "utf8")).toContain('"enabled": false');
    expect(readFileSync(join(legacy, "settings.json"), "utf8")).toBe(legacySettings);
    await stop();

    declarations.draft = draft;
    const modelSettingsFile = join(base, "model_settings.json");
    const modelSettings = readFileSync(modelSettingsFile, "utf8");
    writeFileSync(
      modelSettingsFile,
      JSON.stringify({
        version: 1,
        models: { [rel]: { vlm_mtp_enabled: 1, vlm_mtp_draft_model: draft } },
      }),
    );
    expect(await start()).toMatchObject({ ok: true });
    expect(readFileSync(join(base, "cache-witness.txt"), "utf8")).toBe("\n");
    await stop();
    writeFileSync(modelSettingsFile, modelSettings);

    writeFileSync(join(base, "model_profiles.json"), "{}");
    expect(await start()).toMatchObject({ ok: true });
    expect(readFileSync(join(base, "cache-witness.txt"), "utf8")).toBe("\n");
    await stop();

    writeFileSync(binary, readFileSync(binary, "utf8") + "\n# unrecognized launcher body\n");
    expect(await start()).toMatchObject({
      ok: false,
      pid: null,
      error: "oMLX cache mode requires a supported Python launcher",
    });
    expect(existsSync(join(initial.prefix, "cache.bin"))).toBe(true);
    expect(readFileSync(join(initial.slot, "request.slot"), "utf8")).toBe("recorded slot");
  } finally {
    try {
      await stop();
    } finally {
      if (previousDefaultWorkloads === undefined) {
        Reflect.deleteProperty(process.env, "LLAMACTL_WORKLOADS_DIR");
      } else {
        process.env["LLAMACTL_WORKLOADS_DIR"] = previousDefaultWorkloads;
      }
    }
  }
}, 25_000);
