// #223: the production hand-over deps, driven through a temp workloads
// directory and fake exec / clock / lock / central so nothing touches the real
// host's units, launchd jobs or ~/.llamactl.
import type { ModelHostManifest } from "@llamactl/remote/workload/modelhost-schema";

import { computeModelHostSpecHash } from "@llamactl/core/engines/state";
import { modelHostStore, workloadStore } from "@llamactl/remote";
import { MANAGED_BY_LABEL, specForHash } from "@llamactl/remote/workload/modelhost-schema";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExecResult } from "../src/commands/update/deps.js";

import {
  checkLocalController,
  defaultHandoverDeps,
  describeView,
  handoverKillModeProblem,
  type HandoverOptions,
  type HandoverSystem,
  isMissingWorkload,
  runControllerHandover,
  stopLocalController,
  waitForLockRelease,
  type WorkloadDescribeResult,
} from "../src/commands/controller-handover.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";

type ModelRun = ReturnType<typeof workloadStore.parseWorkload>;

const UNIT = "llamactl-controller.service";
const LABEL = "com.llamactl.controller";
const CGROUP = "/user.slice/user-501.slice/user@501.service/app.slice/llamactl-controller.service";
const MAIN_PID = 1000;
const ENGINE_PID = 4242;
const CENTRAL_CONTROLLER_PID = 777;

const OPTIONS: HandoverOptions = {
  to: "central",
  node: "m4pro",
  timeoutMs: 5_000,
  pollMs: 100,
  dryRun: false,
  controllerUnit: null,
};

let workloadsDir = "";

beforeEach(() => {
  workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-handover-deps-"));
});

afterEach(() => {
  rmSync(workloadsDir, { recursive: true, force: true });
});

function host(name: string, node = "local", labels?: Record<string, string>): ModelHostManifest {
  return {
    apiVersion: "llamactl/v1",
    kind: "ModelHost",
    metadata: labels === undefined ? { name } : { name, labels },
    spec: {
      engine: "omlx",
      node,
      enabled: true,
      binary: "/usr/bin/true",
      endpoint: { host: "127.0.0.1", port: 18_300 },
      hostedModels: [{ rel: "mlx-community/fake-model" }],
      extraArgs: [],
      restartPolicy: "Always",
      timeoutSeconds: 60,
    },
  };
}

function modelRun(name: string, node: string, enabled: boolean): ModelRun {
  return workloadStore.parseWorkload(
    [
      "apiVersion: llamactl/v1",
      "kind: ModelRun",
      "metadata:",
      `  name: ${name}`,
      "spec:",
      `  node: ${node}`,
      `  enabled: ${enabled ? "true" : "false"}`,
      "  target:",
      "    kind: rel",
      "    value: fake-org/fake-model.gguf",
      "  restartPolicy: Always",
      "",
    ].join("\n"),
  );
}

function hashOf(manifest: ModelHostManifest): string {
  return computeModelHostSpecHash(specForHash(manifest.spec));
}

function savedLabels(name: string): Record<string, string> {
  return modelHostStore.loadModelHostByName(name, workloadsDir).metadata.labels ?? {};
}

function systemdShow(killMode: string): string {
  return [
    `Id=${UNIT}`,
    "LoadState=loaded",
    "ActiveState=active",
    `MainPID=${String(MAIN_PID)}`,
    "ExecStart={ path=/usr/bin/bun ; argv[]=/usr/bin/bun /repo/packages/cli/src/bin.ts controller serve ; }",
    `ControlGroup=${CGROUP}`,
    `KillMode=${killMode}`,
    "",
  ].join("\n");
}

const LAUNCHD_PRINT = [
  `gui/501/${LABEL} = {`,
  "\tstate = running",
  `\tpid = ${String(MAIN_PID)}`,
  "\tpath = /Users/fake/Library/LaunchAgents/com.llamactl.controller.plist",
  "\targuments = {",
  "\t\t/usr/bin/bun",
  "\t\t/repo/packages/cli/src/bin.ts",
  "\t\tcontroller",
  "\t\tserve",
  "\t}",
  "}",
  "",
].join("\n");

interface FakeSystemInput {
  platform?: NodeJS.Platform;
  killMode?: string;
  cgroupProcs?: number[] | null;
  loaded?: boolean;
  holder?: number | null;
  releaseOnStop?: boolean;
  stopCode?: number;
  disableCode?: number;
  central?: (to: string, name: string) => Promise<WorkloadDescribeResult>;
  engines?: Record<string, { pid: number; specHash?: string | null }>;
}

interface FakeSystem {
  system: HandoverSystem;
  execs: string[];
  sleeps: number[];
  centralCalls: string[];
  stdout: string[];
  stderr: string[];
}

function ok(stdout = ""): ExecResult {
  return { code: 0, stdout, stderr: "" };
}

function failOr(code: number, message: string): ExecResult {
  return { code, stdout: "", stderr: code === 0 ? "" : message };
}

/** The fake systemctl / launchctl reply for one verb. */
function fakeExecResult(input: FakeSystemInput, verb: string, line: string): ExecResult {
  const loaded = input.loaded ?? true;
  switch (verb) {
    case "show":
      return loaded ? ok(systemdShow(input.killMode ?? "process")) : ok("LoadState=not-found\n");
    case "cat":
      return ok("[Service]\nStandardOutput=journal\n");
    case "print":
      return loaded ? ok(LAUNCHD_PRINT) : failOr(113, "");
    case "stop":
    case "bootout":
      return failOr(input.stopCode ?? 0, "stop refused");
    case "disable":
      return failOr(input.disableCode ?? 0, "disable refused");
    default:
      return failOr(1, `unexpected ${line}`);
  }
}

function fakeSystem(input: FakeSystemInput = {}): FakeSystem {
  const execs: string[] = [];
  const sleeps: number[] = [];
  const centralCalls: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  let holder = input.holder === undefined ? MAIN_PID : input.holder;
  let t = 0;
  const procs = input.cgroupProcs === undefined ? [MAIN_PID] : input.cgroupProcs;
  const system: HandoverSystem = {
    exec: (argv): Promise<ExecResult> => {
      const line = argv.join(" ");
      execs.push(line);
      const verb = argv[0] === "systemctl" ? argv[2] : argv[1];
      const result = fakeExecResult(input, verb ?? "", line);
      if (result.code === 0 && (verb === "stop" || verb === "bootout")) {
        if (input.releaseOnStop !== false) holder = null;
      }
      return Promise.resolve(result);
    },
    readFile: (path): string | null =>
      path === `/sys/fs/cgroup${CGROUP}/cgroup.procs` && procs !== null
        ? `${procs.join("\n")}\n`
        : null,
    uid: 501,
    env: { HOME: "/Users/fake", USER: "fake" },
    platform: input.platform ?? "linux",
    liveLockHolder: (dir): number | null => {
      expect(dir).toBe(workloadsDir);
      return holder;
    },
    describeCentral: async (to, name): Promise<WorkloadDescribeResult> => {
      centralCalls.push(`${to}:${name}`);
      if (input.central === undefined) throw new Error(`ModelHost ${name} not found`);
      return await input.central(to, name);
    },
    readEngineState: (name) => input.engines?.[name] ?? null,
    now: (): number => t,
    sleep: (ms): Promise<void> => {
      sleeps.push(ms);
      t += ms;
      return Promise.resolve();
    },
    stdout: (line): void => {
      stdout.push(line);
    },
    stderr: (line): void => {
      stderr.push(line);
    },
  };
  return { system, execs, sleeps, centralCalls, stdout, stderr };
}

function describeResult(
  manifest: ModelHostManifest,
  liveStatus: unknown,
  controllerPid: number | null | undefined,
): WorkloadDescribeResult {
  const result: Record<string, unknown> = { manifest, liveStatus };
  if (controllerPid !== undefined) result["controllerPid"] = controllerPid;
  return result as unknown as WorkloadDescribeResult;
}

/** A central that holds a copy of each local host aimed at m4pro, seeing the engine live. */
function adoptingCentral(
  controllerPid: number | null | "omitted" = CENTRAL_CONTROLLER_PID,
): (to: string, name: string) => Promise<WorkloadDescribeResult> {
  return (_to, name) => {
    const copy = host(name, "m4pro");
    return Promise.resolve(
      describeResult(
        copy,
        { state: "Running", pid: ENGINE_PID, specHash: hashOf(copy) },
        controllerPid === "omitted" ? undefined : controllerPid,
      ),
    );
  };
}

const SHOW_ARGV = `systemctl --user show ${UNIT}`;

function mutatingExecs(execs: readonly string[]): string[] {
  return execs.filter((line) => /\b(?:stop|disable|bootout)\b/.test(line));
}

describe("defaultHandoverDeps local store", () => {
  test("listLocalHosts lists only local hosts with their spec hash and manager", () => {
    modelHostStore.saveModelHost(host("plain"), workloadsDir);
    modelHostStore.saveModelHost(
      host("adopted", "local", { [MANAGED_BY_LABEL]: "central" }),
      workloadsDir,
    );
    modelHostStore.saveModelHost(host("remote", "gpu1"), workloadsDir);
    const deps = defaultHandoverDeps(workloadsDir, OPTIONS, fakeSystem().system);

    const hosts = deps.listLocalHosts().sort((a, b) => a.name.localeCompare(b.name));

    expect(hosts).toEqual([
      { name: "adopted", specHash: hashOf(host("adopted")), enabled: true, managedBy: "central" },
      { name: "plain", specHash: hashOf(host("plain")), enabled: true, managedBy: null },
    ]);
  });

  test("listLocalModelRuns names only enabled local ModelRuns", () => {
    workloadStore.saveWorkload(modelRun("run-local", "local", true), workloadsDir);
    workloadStore.saveWorkload(modelRun("run-off", "local", false), workloadsDir);
    workloadStore.saveWorkload(modelRun("run-remote", "gpu1", true), workloadsDir);
    const deps = defaultHandoverDeps(workloadsDir, OPTIONS, fakeSystem().system);

    expect(deps.listLocalModelRuns()).toEqual(["run-local"]);
  });

  test("labelHost writes the managed-by label and unlabelHost removes it, keeping other labels", () => {
    modelHostStore.saveModelHost(host("a", "local", { team: "ml" }), workloadsDir);
    const deps = defaultHandoverDeps(workloadsDir, OPTIONS, fakeSystem().system);

    deps.labelHost("a", "central");
    expect(savedLabels("a")).toEqual({ team: "ml", [MANAGED_BY_LABEL]: "central" });

    deps.labelHost("a", "other");
    expect(savedLabels("a")).toEqual({ team: "ml", [MANAGED_BY_LABEL]: "other" });

    deps.unlabelHost("a");
    expect(savedLabels("a")).toEqual({ team: "ml" });
  });

  test("labelHost throws for a host the store does not hold", () => {
    const deps = defaultHandoverDeps(workloadsDir, OPTIONS, fakeSystem().system);

    expect(() => {
      deps.labelHost("missing", "central");
    }).toThrow("not found");
  });

  test("readLocalEngine maps the state sidecar, null when there is none", () => {
    const deps = defaultHandoverDeps(
      workloadsDir,
      OPTIONS,
      fakeSystem({ engines: { a: { pid: ENGINE_PID, specHash: "H1" }, b: { pid: 5 } } }).system,
    );

    expect(deps.readLocalEngine("a")).toEqual({ pid: ENGINE_PID, specHash: "H1" });
    expect(deps.readLocalEngine("b")).toEqual({ pid: 5, specHash: null });
    expect(deps.readLocalEngine("c")).toBeNull();
  });
});

describe("defaultHandoverDeps queryCentral", () => {
  test("asks the --to central and reports its controller pid, node, spec hash and live state", async () => {
    const fake = fakeSystem({ central: adoptingCentral(CENTRAL_CONTROLLER_PID) });
    const deps = defaultHandoverDeps(workloadsDir, OPTIONS, fake.system);

    const view = await deps.queryCentral("a");

    expect(fake.centralCalls).toEqual(["central:a"]);
    expect(view).toEqual({
      found: true,
      node: "m4pro",
      managedBy: null,
      specHash: hashOf(host("a")),
      live: { state: "Running", pid: ENGINE_PID, specHash: hashOf(host("a")) },
      controllerPid: CENTRAL_CONTROLLER_PID,
    });
  });

  test("a central without a live controller lock reports controllerPid null", async () => {
    for (const pid of [null, "omitted"] as const) {
      const deps = defaultHandoverDeps(
        workloadsDir,
        OPTIONS,
        fakeSystem({ central: adoptingCentral(pid) }).system,
      );
      expect((await deps.queryCentral("a")).controllerPid).toBeNull();
    }
  });

  test("describeView passes the controller pid through unchanged", () => {
    const copy = host("a", "m4pro");
    expect(describeView(describeResult(copy, {}, 31)).controllerPid).toBe(31);
    expect(describeView(describeResult(copy, {}, null)).controllerPid).toBeNull();
    expect(describeView(describeResult(copy, {}, undefined)).controllerPid).toBeNull();
  });

  test("describeView reads the central copy's managed-by label and a live error", () => {
    const copy = host("a", "m4pro", { [MANAGED_BY_LABEL]: "elsewhere" });
    const view = describeView(describeResult(copy, { error: "unreachable" }, 31));

    expect(view.managedBy).toBe("elsewhere");
    expect(view.live).toEqual({ error: "unreachable" });
  });

  test("a missing workload on the central becomes a not-found view", async () => {
    for (const err of [
      Object.assign(new Error("gone"), { code: "NOT_FOUND" }),
      new Error("ModelHost a not found at /x/a.yaml"),
    ]) {
      const deps = defaultHandoverDeps(
        workloadsDir,
        OPTIONS,
        fakeSystem({ central: () => Promise.reject(err) }).system,
      );
      const view = await deps.queryCentral("a");
      expect(view.found).toBe(false);
      expect(view.controllerPid).toBeNull();
    }
  });

  test("any other central failure is rethrown", async () => {
    const deps = defaultHandoverDeps(
      workloadsDir,
      OPTIONS,
      fakeSystem({ central: () => Promise.reject(new Error("connection refused")) }).system,
    );

    let caught: unknown = null;
    try {
      await deps.queryCentral("a");
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toBe("connection refused");
  });

  test("isMissingWorkload recognizes only not-found errors", () => {
    expect(isMissingWorkload({ code: "NOT_FOUND" })).toBe(true);
    expect(isMissingWorkload(new Error("Workload x Not Found"))).toBe(true);
    expect(isMissingWorkload(new Error("timeout"))).toBe(false);
    expect(isMissingWorkload({ code: "INTERNAL", message: "boom" })).toBe(false);
  });
});

describe("handoverKillModeProblem", () => {
  test("refuses control-group and mixed, allows process and none", async () => {
    for (const [mode, procs, refused] of [
      ["control-group", [MAIN_PID, ENGINE_PID], true],
      ["mixed", [MAIN_PID, ENGINE_PID], true],
      ["mixed", [MAIN_PID], true],
      ["control-group", null, true],
      ["process", [MAIN_PID, ENGINE_PID], false],
      ["none", [MAIN_PID, ENGINE_PID], false],
    ] as const) {
      const fake = fakeSystem({ killMode: mode, cgroupProcs: procs === null ? null : [...procs] });
      const problem = await checkLocalController(workloadsDir, OPTIONS, fake.system);
      if (refused) {
        expect(problem).toContain(`KillMode=${mode}`);
        expect(problem).toContain("KillMode=process");
      } else {
        expect(problem).toBeNull();
      }
      expect(mutatingExecs(fake.execs)).toEqual([]);
    }
  });

  test("names the engine pids in the cgroup, as llamactl update does", async () => {
    const fake = fakeSystem({ killMode: "mixed", cgroupProcs: [MAIN_PID, ENGINE_PID] });
    const problem = await checkLocalController(workloadsDir, OPTIONS, fake.system);

    expect(problem).toContain(`pid ${String(ENGINE_PID)}`);
    expect(problem).toContain(UNIT);
  });

  test("launchd jobs carry no KillMode and pass", () => {
    expect(
      handoverKillModeProblem({
        role: "controller",
        name: LABEL,
        explicit: false,
        loaded: true,
        active: true,
        pid: MAIN_PID,
        argv: [],
        cgroup: null,
        killMode: null,
        cgroupProcs: null,
        env: {},
        stdoutPath: null,
        journal: false,
        plistPath: null,
      }),
    ).toBeNull();
  });
});

describe("stopLocalController", () => {
  test("systemd: stops then disables the unit and waits for the lock to clear", async () => {
    const fake = fakeSystem({ killMode: "process" });

    const result = await stopLocalController(workloadsDir, OPTIONS, fake.system);

    expect(result.ok).toBe(true);
    expect(result.detail).toContain(`stopped ${UNIT}`);
    expect(result.detail).toContain(`disabled ${UNIT}`);
    expect(mutatingExecs(fake.execs)).toEqual([
      `systemctl --user stop ${UNIT}`,
      `systemctl --user disable ${UNIT}`,
    ]);
    expect(fake.execs[0]?.startsWith(SHOW_ARGV)).toBe(true);
  });

  test("launchd: boots the job out then disables it in the gui domain", async () => {
    const fake = fakeSystem({ platform: "darwin" });

    const result = await stopLocalController(workloadsDir, OPTIONS, fake.system);

    expect(result.ok).toBe(true);
    expect(fake.execs).toEqual([
      `launchctl print gui/501/${LABEL}`,
      `launchctl bootout gui/501/${LABEL}`,
      `launchctl disable gui/501/${LABEL}`,
    ]);
  });

  test("--controller-unit names the unit to stop and disable", async () => {
    const fake = fakeSystem();
    const opts = { ...OPTIONS, controllerUnit: "custom-controller.service" };

    expect((await stopLocalController(workloadsDir, opts, fake.system)).ok).toBe(true);
    expect(mutatingExecs(fake.execs)).toEqual([
      "systemctl --user stop custom-controller.service",
      "systemctl --user disable custom-controller.service",
    ]);
  });

  test("refuses to stop a unit whose KillMode would kill its engines", async () => {
    for (const mode of ["control-group", "mixed"]) {
      const fake = fakeSystem({ killMode: mode, cgroupProcs: [MAIN_PID, ENGINE_PID] });

      const result = await stopLocalController(workloadsDir, OPTIONS, fake.system);

      expect(result.ok).toBe(false);
      expect(result.detail).toContain(`KillMode=${mode}`);
      expect(mutatingExecs(fake.execs)).toEqual([]);
    }
  });

  test("a failed disable keeps the stop but tells the operator to disable by hand", async () => {
    const fake = fakeSystem({ disableCode: 1 });

    const result = await stopLocalController(workloadsDir, OPTIONS, fake.system);

    expect(result.ok).toBe(true);
    expect(result.detail).toContain("disable refused");
    expect(result.detail).toContain("disable it by hand");
  });

  test("a failed stop does not disable the unit", async () => {
    const fake = fakeSystem({ stopCode: 5 });

    const result = await stopLocalController(workloadsDir, OPTIONS, fake.system);

    expect(result).toEqual({ ok: false, detail: `${UNIT} stop exited 5: stop refused` });
    expect(mutatingExecs(fake.execs)).toEqual([`systemctl --user stop ${UNIT}`]);
  });

  test("does nothing when no controller holds the lock", async () => {
    const fake = fakeSystem({ holder: null });

    expect(await stopLocalController(workloadsDir, OPTIONS, fake.system)).toEqual({
      ok: true,
      detail: "no local controller running",
    });
    expect(fake.execs).toEqual([]);
  });

  test("reports a unit that is not loaded, and a platform with no service manager", async () => {
    const unloaded = fakeSystem({ loaded: false });
    const r1 = await stopLocalController(workloadsDir, OPTIONS, unloaded.system);
    expect(r1.ok).toBe(false);
    expect(r1.detail).toContain(`service ${UNIT} is not loaded`);
    expect(mutatingExecs(unloaded.execs)).toEqual([]);

    const windows = fakeSystem({ platform: "win32" });
    const r2 = await stopLocalController(workloadsDir, OPTIONS, windows.system);
    expect(r2.ok).toBe(false);
    expect(r2.detail).toContain("no service manager on win32");
    expect(windows.execs).toEqual([]);
  });

  test("reports a lock still held after the stop once the timeout passes", async () => {
    const fake = fakeSystem({ releaseOnStop: false });

    const result = await stopLocalController(
      workloadsDir,
      { ...OPTIONS, timeoutMs: 3_000, pollMs: 2_500 },
      fake.system,
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toContain(`still held by pid ${String(MAIN_PID)}`);
    expect(fake.sleeps).toEqual([1_000, 1_000, 1_000]);
  });
});

describe("waitForLockRelease", () => {
  test("polls the lock on the injected clock until it clears", async () => {
    let checks = 0;
    let t = 0;
    const sleeps: number[] = [];
    const result = await waitForLockRelease(
      workloadsDir,
      { name: UNIT, pid: MAIN_PID } as Parameters<typeof waitForLockRelease>[1],
      { timeoutMs: 10_000, pollMs: 200 },
      {
        liveLockHolder: (): number | null => {
          checks += 1;
          return checks >= 3 ? null : MAIN_PID;
        },
        now: (): number => t,
        sleep: (ms): Promise<void> => {
          sleeps.push(ms);
          t += ms;
          return Promise.resolve();
        },
      },
    );

    expect(result).toEqual({ ok: true, detail: `stopped ${UNIT} (pid ${String(MAIN_PID)})` });
    expect(sleeps).toEqual([200, 200]);
  });
});

describe("runControllerHandover with the production deps", () => {
  test("labels the store, then stops and disables the controller unit", async () => {
    modelHostStore.saveModelHost(host("a"), workloadsDir);
    const fake = fakeSystem({
      central: adoptingCentral(),
      engines: { a: { pid: ENGINE_PID, specHash: hashOf(host("a")) } },
    });

    const code = await runControllerHandover(
      OPTIONS,
      defaultHandoverDeps(workloadsDir, OPTIONS, fake.system),
    );

    expect(code).toBe(0);
    expect(savedLabels("a")).toEqual({ [MANAGED_BY_LABEL]: "central" });
    expect(mutatingExecs(fake.execs)).toEqual([
      `systemctl --user stop ${UNIT}`,
      `systemctl --user disable ${UNIT}`,
    ]);
  });

  test("a central without a live controller is never adopted: no label, no stop", async () => {
    modelHostStore.saveModelHost(host("a"), workloadsDir);
    const fake = fakeSystem({
      central: adoptingCentral(null),
      engines: { a: { pid: ENGINE_PID, specHash: hashOf(host("a")) } },
    });
    const opts = { ...OPTIONS, timeoutMs: 300 };

    const code = await runControllerHandover(
      opts,
      defaultHandoverDeps(workloadsDir, opts, fake.system),
    );

    expect(code).toBe(1);
    expect(fake.stderr.join("\n")).toContain("no live controller on central");
    expect(savedLabels("a")).toEqual({});
    expect(mutatingExecs(fake.execs)).toEqual([]);
  });

  test("a KillMode=mixed unit refuses before anything is queried or written", async () => {
    modelHostStore.saveModelHost(host("a"), workloadsDir);
    const fake = fakeSystem({
      killMode: "mixed",
      cgroupProcs: [MAIN_PID, ENGINE_PID],
      central: adoptingCentral(),
      engines: { a: { pid: ENGINE_PID, specHash: hashOf(host("a")) } },
    });

    const code = await runControllerHandover(
      OPTIONS,
      defaultHandoverDeps(workloadsDir, OPTIONS, fake.system),
    );

    expect(code).toBe(1);
    expect(fake.stderr.join("\n")).toContain("KillMode=mixed");
    expect(fake.stderr.join("\n")).toContain("nothing was labelled");
    expect(fake.centralCalls).toEqual([]);
    expect(savedLabels("a")).toEqual({});
    expect(mutatingExecs(fake.execs)).toEqual([]);
  });
});
