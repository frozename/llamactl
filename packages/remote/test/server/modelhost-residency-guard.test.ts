// #557 S5: residency-group start guard. The two disabled z13 libosmos
// arms share the exclusive `llamactl.io/residency-group: z13-large-gpu`
// label, so only one may hold the group's memory at a time. These cases
// pin the guard contract against REAL spawns of the fake osmos-api: a
// peer recorded as Running, Starting, or Unknown must refuse a same-group
// start with { ok:false, pid:null, residencyConflict } and must not
// persist its manifest. R1/R2/R4 fail by assertion at base; R3/G1/G2 are
// non-regression pins that stay green. Every test owns a fresh mkdtemp
// root and stops both host keys in finally so a RED failure cannot leave
// Running sidecars behind.

import { afterAll, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { PidIdentityDeps } from "../../../core/src/pidIdentity.js";

import { readModelHostStarting } from "../../../core/src/engines/state.js";
import { resolveEnv } from "../../../core/src/env.js";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";
import {
  startModelHost,
  type StartModelHostOptions,
  type StartModelHostResult,
  stopModelHost,
} from "../../src/server/modelhost.js";
import { modelHostPath } from "../../src/workload/modelhost-store.js";
import { type LoadedModelHostTemplate, loadModelHostTemplate } from "../workload/template-arms.js";

const NAME_A = "libosmos-ds41-ud-iq1m";
const NAME_B = "libosmos-ds41-ud-iq1s";
const TEMPLATE_A = "libosmos-ds41-ud-iq1m-z13.yaml";
const TEMPLATE_B = "libosmos-ds41-ud-iq1s-z13.yaml";
const RESIDENCY_LABEL = "llamactl.io/residency-group";
const GROUP = "z13-large-gpu";

const fakeOsmsApi = join(import.meta.dir, "..", "fixtures", "fake-osmos-api.ts");
const spawnedPids = new Set<number>();

// Backstop for pids recorded before a mid-test failure: the per-test
// finally stops hosts through their state records, this only covers a
// start that returned ok after the finally's stop window.
afterAll(() => {
  for (const pid of spawnedPids) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already gone
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
});

interface ArmTemplates {
  a: LoadedModelHostTemplate;
  b: LoadedModelHostTemplate;
}

let templates: ArmTemplates | null = null;

function armTemplates(): ArmTemplates {
  templates ??= {
    a: loadModelHostTemplate(TEMPLATE_A),
    b: loadModelHostTemplate(TEMPLATE_B),
  };
  return templates;
}

interface TestRoot {
  root: string;
  modelsDir: string;
  runtimeDir: string;
  workloadsDir: string;
  env: NodeJS.ProcessEnv;
  wrapper: string;
  portA: number;
  portB: number;
}

async function freePorts(count: number): Promise<number[]> {
  const servers = Array.from({ length: count }, () =>
    Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") }),
  );
  const ports = servers.map((server) => server.port ?? 0);
  await Promise.all(servers.map((server) => server.stop()));
  return ports;
}

// argv0 must read as osmos-api to the pid-identity argv0 check, so the
// wrapper execs the bun binary under that name (modelhost-libosmos.test.ts
// pattern). Both templates' hostedModels rels need an existing file under
// the models dir or libosmos prepareLaunch refuses the launch.
async function setupRoot(root: string, arms: ArmTemplates): Promise<TestRoot> {
  const modelsDir = join(root, "models");
  const runtimeDir = join(root, "runtime");
  const workloadsDir = join(root, "workloads");
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(modelsDir, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(workloadsDir, { recursive: true });

  const wrapper = join(binDir, "osmos-api");
  writeFileSync(
    wrapper,
    `#!/bin/bash\nexec -a osmos-api "${process.execPath}" "${fakeOsmsApi}" "$@"\n`,
    { mode: 0o755 },
  );

  for (const template of [arms.a, arms.b]) {
    for (const hosted of template.manifest.spec.hostedModels) {
      const file = join(modelsDir, hosted.rel);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "");
    }
  }

  const [portA = 0, portB = 0] = await freePorts(2);
  return {
    root,
    modelsDir,
    runtimeDir,
    workloadsDir,
    env: {
      ...process.env,
      LLAMACTL_MODELS_DIR: modelsDir,
      LLAMA_CPP_MODELS: modelsDir,
    },
    wrapper,
    portA,
    portB,
  };
}

async function stopBoth(root: string): Promise<void> {
  const runtimeDir = join(root, "runtime");
  await Promise.all([
    stopModelHost({ key: { name: NAME_A }, runtimeDir }).catch(() => undefined),
    stopModelHost({ key: { name: NAME_B }, runtimeDir }).catch(() => undefined),
  ]);
}

function startManifest(
  template: LoadedModelHostTemplate,
  opts: { port: number; binary: string; residencyGroup?: string | null },
): Record<string, unknown> {
  const spec = template.manifest.spec;
  const labels = { ...(template.manifest.metadata.labels ?? {}) };
  if (opts.residencyGroup === null) {
    Reflect.deleteProperty(labels, RESIDENCY_LABEL);
  } else if (opts.residencyGroup !== undefined) {
    labels[RESIDENCY_LABEL] = opts.residencyGroup;
  }
  return {
    apiVersion: "llamactl/v1",
    kind: "ModelHost",
    metadata: { name: template.manifest.metadata.name, labels },
    spec: {
      ...spec,
      node: "local",
      enabled: true,
      binary: opts.binary,
      endpoint: { host: "127.0.0.1", port: opts.port },
      extraArgs: ["--max-context", "65536", "--no-guess"],
    },
  };
}

function startHost(
  ctx: TestRoot,
  template: LoadedModelHostTemplate,
  port: number,
  extra?: {
    identity?: PidIdentityDeps;
    probeReady?: StartModelHostOptions["probeReady"];
    residencyGroup?: string | null;
  },
): Promise<StartModelHostResult> {
  return startModelHost({
    key: { name: template.manifest.metadata.name },
    runtimeDir: ctx.runtimeDir,
    workloadsDir: ctx.workloadsDir,
    env: ctx.env,
    manifest: startManifest(template, {
      port,
      binary: ctx.wrapper,
      ...(extra?.residencyGroup !== undefined ? { residencyGroup: extra.residencyGroup } : {}),
    }),
    ...(extra?.identity !== undefined ? { identity: extra.identity } : {}),
    ...(extra?.probeReady !== undefined ? { probeReady: extra.probeReady } : {}),
  });
}

function residencyConflict(result: StartModelHostResult): unknown {
  return (result as unknown as Record<string, unknown>)["residencyConflict"];
}

function recordPid(result: StartModelHostResult): void {
  if (result.pid !== null) spawnedPids.add(result.pid);
}

interface ReadinessGate {
  promise: Promise<{ ready: boolean; modelIds: string[] }>;
  open: () => void;
}

function readinessGate(): ReadinessGate {
  let release: (value: { ready: boolean; modelIds: string[] }) => void = () => undefined;
  const promise = new Promise<{ ready: boolean; modelIds: string[] }>((resolve) => {
    release = resolve;
  });
  return {
    promise,
    open: (): void => {
      release({ ready: true, modelIds: [] });
    },
  };
}

// Bounded condition wait: polls every 5 ms for at most 2 s, never a fixed sleep.
async function waitFor(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  throw new Error(`timed out waiting for ${label}`);
}

test("R1: refuses a same-group start while a peer is Running", async () => {
  const arms = armTemplates();
  const root = mkdtempSync(join(tmpdir(), "llamactl-residency-guard-"));
  try {
    const ctx = await setupRoot(root, arms);

    const resultA = await startHost(ctx, arms.a, ctx.portA);
    expect(resultA.ok).toBe(true);
    recordPid(resultA);

    const resultB = await startHost(ctx, arms.b, ctx.portB);
    recordPid(resultB);

    expect(resultB.ok).toBe(false);
    expect(resultB.pid).toBeNull();
    expect(resultB.error).toContain(NAME_A);
    expect(resultB.error).toContain(GROUP);
    expect(residencyConflict(resultB)).toEqual({
      group: GROUP,
      host: NAME_A,
      state: "Running",
    });
    expect(existsSync(modelHostPath(NAME_B, ctx.workloadsDir))).toBe(false);
  } finally {
    await stopBoth(root);
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test("R2: refuses a same-group start while a peer is Starting", async () => {
  const arms = armTemplates();
  const root = mkdtempSync(join(tmpdir(), "llamactl-residency-guard-"));
  const gate = readinessGate();
  let startA: Promise<StartModelHostResult> | null = null;
  try {
    const ctx = await setupRoot(root, arms);
    const resolved = resolveEnv({ LOCAL_AI_RUNTIME_DIR: ctx.runtimeDir });
    const keyA = { name: NAME_A };

    startA = startHost(ctx, arms.a, ctx.portA, { probeReady: () => gate.promise });
    await waitFor(() => readModelHostStarting(keyA, resolved) !== null, "host A starting record");

    const resultB = await startHost(ctx, arms.b, ctx.portB);
    recordPid(resultB);

    gate.open();
    const resultA = await startA;
    recordPid(resultA);
    expect(resultA.ok).toBe(true);

    expect(resultB.ok).toBe(false);
    expect(resultB.pid).toBeNull();
    expect(residencyConflict(resultB)).toEqual({
      group: GROUP,
      host: NAME_A,
      state: "Starting",
    });
    expect(existsSync(modelHostPath(NAME_B, ctx.workloadsDir))).toBe(false);
  } finally {
    gate.open();
    if (startA !== null) await startA.catch(() => undefined);
    await stopBoth(root);
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test("R4: fails closed when a same-group peer's pid identity is Unknown", async () => {
  const arms = armTemplates();
  const root = mkdtempSync(join(tmpdir(), "llamactl-residency-guard-"));
  try {
    const ctx = await setupRoot(root, arms);

    const resultA = await startHost(ctx, arms.a, ctx.portA);
    expect(resultA.ok).toBe(true);
    recordPid(resultA);

    const resultB = await startHost(ctx, arms.b, ctx.portB, {
      identity: { processStartMs: () => null },
    });
    recordPid(resultB);

    expect(resultB.ok).toBe(false);
    expect(resultB.pid).toBeNull();
    expect(residencyConflict(resultB)).toEqual({
      group: GROUP,
      host: NAME_A,
      state: "Unknown",
    });
    expect(existsSync(modelHostPath(NAME_B, ctx.workloadsDir))).toBe(false);
  } finally {
    await stopBoth(root);
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test("R3: allows a same-group start after the peer stops", async () => {
  const arms = armTemplates();
  const root = mkdtempSync(join(tmpdir(), "llamactl-residency-guard-"));
  try {
    const ctx = await setupRoot(root, arms);

    const resultA = await startHost(ctx, arms.a, ctx.portA);
    expect(resultA.ok).toBe(true);
    recordPid(resultA);

    const stopped = await stopModelHost({ key: { name: NAME_A }, runtimeDir: ctx.runtimeDir });
    expect(stopped.ok).toBe(true);

    const resultB = await startHost(ctx, arms.b, ctx.portB);
    recordPid(resultB);
    expect(resultB.ok).toBe(true);
  } finally {
    await stopBoth(root);
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test("G1: a different residency group does not conflict", async () => {
  const arms = armTemplates();
  const root = mkdtempSync(join(tmpdir(), "llamactl-residency-guard-"));
  try {
    const ctx = await setupRoot(root, arms);

    const resultA = await startHost(ctx, arms.a, ctx.portA);
    expect(resultA.ok).toBe(true);
    recordPid(resultA);

    const resultB = await startHost(ctx, arms.b, ctx.portB, {
      residencyGroup: "z13-other",
    });
    recordPid(resultB);
    expect(resultB.ok).toBe(true);
  } finally {
    await stopBoth(root);
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test("G2: an unlabelled host does not conflict with a labelled peer", async () => {
  const arms = armTemplates();
  const root = mkdtempSync(join(tmpdir(), "llamactl-residency-guard-"));
  try {
    const ctx = await setupRoot(root, arms);

    const resultA = await startHost(ctx, arms.a, ctx.portA);
    expect(resultA.ok).toBe(true);
    recordPid(resultA);

    const resultB = await startHost(ctx, arms.b, ctx.portB, { residencyGroup: null });
    recordPid(resultB);
    expect(resultB.ok).toBe(true);
  } finally {
    await stopBoth(root);
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test("G2 reverse: a labelled host is not blocked by an unlabelled peer", async () => {
  const arms = armTemplates();
  const root = mkdtempSync(join(tmpdir(), "llamactl-residency-guard-"));
  try {
    const ctx = await setupRoot(root, arms);

    const resultA = await startHost(ctx, arms.a, ctx.portA, { residencyGroup: null });
    expect(resultA.ok).toBe(true);
    recordPid(resultA);

    const resultB = await startHost(ctx, arms.b, ctx.portB);
    recordPid(resultB);
    expect(resultB.ok).toBe(true);
  } finally {
    await stopBoth(root);
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test("G3: two unlabelled hosts do not conflict — second start succeeds when peer is Running", async () => {
  const arms = armTemplates();
  const root = mkdtempSync(join(tmpdir(), "llamactl-residency-guard-"));
  try {
    const ctx = await setupRoot(root, arms);

    const resultA = await startHost(ctx, arms.a, ctx.portA, { residencyGroup: null });
    expect(resultA.ok).toBe(true);
    recordPid(resultA);

    const resultB = await startHost(ctx, arms.b, ctx.portB, { residencyGroup: null });
    recordPid(resultB);
    expect(resultB.ok).toBe(true);
    expect(residencyConflict(resultB)).toBeUndefined();
  } finally {
    await stopBoth(root);
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
