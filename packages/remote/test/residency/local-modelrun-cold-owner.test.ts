import type { ColdEngineDispatch } from "@llamactl/core/residency/engine-forwarder";

import { afterEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TrustedColdOwner } from "../../src/residency/cold-owner-admission.js";
import type {
  LocalModelRunColdPlan,
  LocalModelRunReadyRoute,
  LocalModelRunResidentProof,
} from "../../src/residency/local-modelrun-cold-owner.js";

import { createColdOwnerAdmission } from "../../src/residency/cold-owner-admission.js";
import { createLocalModelRunColdOwner } from "../../src/residency/local-modelrun-cold-owner.js";
import { createOwnerAdmission } from "../../src/residency/owner-admission.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";
import { ModelRunSchema } from "../../src/workload/schema.js";
import { saveWorkload } from "../../src/workload/store.js";

const OWNER = "test-owner";
const WORKLOAD = "cold-run";
const MODEL = "declared";
const REL = "org/model.gguf";
const ENDPOINT = { host: "127.0.0.1", port: 18200 };
const SPEC = "1".repeat(64);
const ARTIFACT = `sha256:${"2".repeat(64)}`;
const POLICY = `sha256:${"3".repeat(64)}`;
const GENERATION = "generation-a";
const PID = 147;
const DECLARATION: ColdEngineDispatch["declaration"] = {
  id: MODEL,
  workload: WORKLOAD,
  kind: "ModelRun",
  ownerNodeId: OWNER,
  state: "cold",
  autoLoadEligible: true,
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function store(dir: string, opts: { context?: number; alias?: string; node?: string } = {}): void {
  saveWorkload(
    ModelRunSchema.parse({
      apiVersion: "llamactl/v1",
      kind: "ModelRun",
      metadata: { name: WORKLOAD },
      spec: {
        node: opts.node ?? "local",
        target: { kind: "rel", value: REL },
        extraArgs: ["--alias", opts.alias ?? MODEL, "--ctx-size", String(opts.context ?? 128)],
        endpoint: ENDPOINT,
        resources: { expectedMemoryGiB: 4 },
      },
    }),
    dir,
  );
}

interface FixtureState {
  declarations: ColdEngineDispatch["declaration"][];
  resident?: LocalModelRunResidentProof | undefined;
  routes: LocalModelRunReadyRoute[];
  compileEndpoint: typeof ENDPOINT;
  artifactRel?: string | undefined;
  artifactRevision: string;
  policyRevision: string;
  ignoreLaunchGuard: boolean;
  beforeGuard(): void;
  launchEffects: Readonly<LocalModelRunColdPlan<string[]>>[];
}

function fixture(): {
  owner: TrustedColdOwner;
  state: FixtureState;
  publish: (generation: string) => void;
  workloadsDir: string;
} {
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-cold-owner-"));
  dirs.push(workloadsDir);
  store(workloadsDir);
  const state: FixtureState = {
    declarations: [DECLARATION],
    routes: [],
    compileEndpoint: ENDPOINT,
    artifactRevision: ARTIFACT,
    policyRevision: POLICY,
    ignoreLaunchGuard: false,
    beforeGuard: (): void => undefined,
    launchEffects: [],
  };
  const publish = (generation: string): void => {
    state.resident = {
      effectiveSpecDigest: SPEC,
      contextTokens: 128,
      artifactRevision: state.artifactRevision,
      policyRevision: state.policyRevision,
      endpoint: ENDPOINT,
      pid: PID,
      runtimeGeneration: generation,
    };
    state.routes = [
      {
        ...ENDPOINT,
        pid: PID,
        model: MODEL,
        workload: WORKLOAD,
        engine: "llamacpp",
        kind: "ModelRun",
        runtimeGeneration: generation,
      },
    ];
  };
  const owner = createLocalModelRunColdOwner({
    ownerNodeId: OWNER,
    workloadsDir,
    readDeclarations: () => state.declarations,
    // Holding the stub's spec digest fixed verifies that the explicit engine
    // context proof is required independently of the compiler digest.
    compile: (manifest) => ({
      launch: manifest.spec.extraArgs,
      effectiveSpecDigest: SPEC,
      artifactRel: state.artifactRel ?? manifest.spec.target.value,
      artifactRevision: state.artifactRevision,
      policyRevision: state.policyRevision,
      endpoint: state.compileEndpoint,
      contextTokens: Number(manifest.spec.extraArgs[3]),
    }),
    launchManaged: async (plan, { stillCurrent }) => {
      await Promise.resolve();
      state.beforeGuard();
      if (!state.ignoreLaunchGuard && !stillCurrent()) return { kind: "refused" };
      state.launchEffects.push(plan);
      publish(GENERATION);
      return { kind: "ready", runtimeGeneration: GENERATION };
    },
    readResident: () => state.resident,
    readReadyRoutes: () => state.routes,
  });
  return { owner, state, publish, workloadsDir };
}

test("an exact locally stored ModelRun activates through the guarded launch and proves its own ready route", async () => {
  const { owner, state } = fixture();
  const pin = owner.pin(DECLARATION);
  expect(pin).toMatchObject({
    model: MODEL,
    ownerNodeId: OWNER,
    workload: WORKLOAD,
    endpoint: "http://127.0.0.1:18200",
    artifactRevision: ARTIFACT,
    policyRevision: POLICY,
  });
  if (pin === undefined) throw new Error("expected owner pin");
  const signal = new AbortController().signal;
  expect(await owner.ready(pin, signal)).toBeUndefined();
  expect(await owner.activate(pin, signal)).toBe("ready");
  expect(state.launchEffects).toHaveLength(1);
  expect(state.launchEffects[0]?.launch).toEqual(["--alias", MODEL, "--ctx-size", "128"]);
  const proof = await owner.ready(pin, signal);
  expect(proof).toEqual({ pin, runtimeGeneration: GENERATION });
  if (proof === undefined) throw new Error("expected ready proof");
  expect(owner.stillOwns(proof)).toBe(true);
});

test("alias collision, stored alias churn and a different target owner each refuse before launch", async () => {
  const { owner, state, workloadsDir } = fixture();
  const pin = owner.pin(DECLARATION);
  if (pin === undefined) throw new Error("expected owner pin");
  const signal = new AbortController().signal;
  state.declarations.push({ ...DECLARATION, workload: "other-host", kind: "ModelHost" });
  expect(owner.pin(DECLARATION)).toBeUndefined();
  expect(await owner.activate(pin, signal)).toBe("refused");
  state.declarations.pop();
  store(workloadsDir, { alias: "new-alias" });
  expect(owner.pin(DECLARATION)).toBeUndefined();
  store(workloadsDir, { node: "remote" });
  expect(owner.pin(DECLARATION)).toBeUndefined();
  expect(state.launchEffects).toEqual([]);
});

test("missed artifact, policy, endpoint and finite engine context qualification do not yield a pin", () => {
  const { owner, state, workloadsDir } = fixture();
  state.artifactRevision = REL;
  expect(owner.pin(DECLARATION)).toBeUndefined();
  state.artifactRevision = ARTIFACT;
  state.artifactRel = "org/other-model.gguf";
  expect(owner.pin(DECLARATION)).toBeUndefined();
  delete state.artifactRel;
  state.policyRevision = "";
  expect(owner.pin(DECLARATION)).toBeUndefined();
  state.policyRevision = POLICY;
  state.compileEndpoint = { ...ENDPOINT, host: "0.0.0.0" };
  expect(owner.pin(DECLARATION)).toBeUndefined();
  state.compileEndpoint = { ...ENDPOINT, port: 18201 };
  expect(owner.pin(DECLARATION)).toBeUndefined();
  state.compileEndpoint = ENDPOINT;
  for (const context of [0, Infinity, 1.5]) {
    store(workloadsDir, { context });
    expect(owner.pin(DECLARATION)).toBeUndefined();
  }
});

test("ctx-size drift with an unchanged alias is caught inside managed admission before mutation", async () => {
  const { owner, state, workloadsDir } = fixture();
  const pin = owner.pin(DECLARATION);
  if (pin === undefined) throw new Error("expected owner pin");
  state.beforeGuard = (): void => {
    store(workloadsDir, { context: 256 });
  };
  expect(await owner.activate(pin, new AbortController().signal)).toBe("refused");
  expect(state.launchEffects).toEqual([]);
  expect(owner.pin(DECLARATION)?.model).toBe(MODEL);
  expect(owner.pin(DECLARATION)?.deploymentId).not.toBe(pin.deploymentId);
  expect(await owner.ready(pin, new AbortController().signal)).toBeUndefined();
});

test("a launch callback that skips locked revalidation cannot establish readiness", async () => {
  const { owner, state } = fixture();
  const pin = owner.pin(DECLARATION);
  if (pin === undefined) throw new Error("expected owner pin");
  state.ignoreLaunchGuard = true;
  expect(await owner.activate(pin, new AbortController().signal)).toBe("uncertain");
});

test("a fresh ready declaration with missing runtime proof never triggers a cold launch", async () => {
  const { owner, state } = fixture();
  const pin = owner.pin(DECLARATION);
  if (pin === undefined) throw new Error("expected owner pin");
  state.declarations = [{ ...DECLARATION, state: "ready", autoLoadEligible: false }];
  expect(await owner.activate(pin, new AbortController().signal)).toBe("refused");
  expect(state.launchEffects).toEqual([]);
});

test("a new ctx-size cannot claim an older resident route under the same stored alias", async () => {
  const { owner, publish, workloadsDir } = fixture();
  publish(GENERATION);
  store(workloadsDir, { context: 256 });
  const pin = owner.pin(DECLARATION);
  if (pin === undefined) throw new Error("expected owner pin");
  expect(await owner.ready(pin, new AbortController().signal)).toBeUndefined();
});

test("a stale or colliding ready route cannot be attributed to the resident generation", async () => {
  const { owner, state, publish } = fixture();
  const pin = owner.pin(DECLARATION);
  if (pin === undefined) throw new Error("expected owner pin");
  const signal = new AbortController().signal;
  publish(GENERATION);
  const route = state.routes[0];
  if (route === undefined) throw new Error("expected fixture route");
  state.routes = [{ ...route, runtimeGeneration: "older-generation" }];
  expect(await owner.ready(pin, signal)).toBeUndefined();
  expect(await owner.activate(pin, signal)).toBe("refused");
  expect(state.launchEffects).toEqual([]);
  state.routes = [route, { ...route, workload: "collision" }];
  expect(await owner.ready(pin, signal)).toBeUndefined();
  state.routes = [route];
  expect(await owner.ready(pin, signal)).toBeDefined();
});

test("a launch receipt cannot be rebound to a replacement generation at the same alias and endpoint", async () => {
  const { owner, publish } = fixture();
  const pin = owner.pin(DECLARATION);
  if (pin === undefined) throw new Error("expected owner pin");
  const signal = new AbortController().signal;
  expect(await owner.activate(pin, signal)).toBe("ready");
  const proof = await owner.ready(pin, signal);
  if (proof === undefined) throw new Error("expected ready proof");
  publish("generation-b");
  expect(await owner.ready(pin, signal)).toBeUndefined();
  expect(owner.stillOwns(proof)).toBe(false);
});

test("the composed owner checks the exact resident and route generation immediately before dialing", async () => {
  const { owner, publish } = fixture();
  const limits = {
    maxExecutions: 1,
    maxQueued: 4,
    maxQueuedBytes: 1000,
    maxQueueWaitMs: 5000,
    maxPerPrincipal: 4,
    starvationBoundMs: 5000,
    maxContextTokens: 128,
    retryAfterMs: 100,
  };
  const warm = createOwnerAdmission([
    {
      name: "test-device",
      foregroundPorts: [ENDPOINT.port],
      backgroundPorts: [18210],
      foregroundConcurrency: 1,
      maxCompletionTokens: 8,
      maxQueued: limits.maxQueued,
      maxQueuedBytes: limits.maxQueuedBytes,
      maxQueueWaitMs: limits.maxQueueWaitMs,
      maxPerPrincipal: limits.maxPerPrincipal,
      starvationBoundMs: limits.starvationBoundMs,
      maxContextTokens: limits.maxContextTokens,
    },
  ]);
  let dials = 0;
  let replaceBeforeDial = true;
  const cold = createColdOwnerAdmission({
    ownerNodeId: OWNER,
    limits,
    owner,
    warm: {
      ...warm,
      forward: (dispatch) => {
        if (replaceBeforeDial) publish("generation-b");
        return warm.forward(dispatch);
      },
    },
  });
  try {
    const dispatch: ColdEngineDispatch = {
      declaration: DECLARATION,
      path: "/v1/completions",
      deadlineMs: Date.now() + 5000,
      body: '{"model":"declared","prompt":[1,2],"max_tokens":3}',
      clientSignal: new AbortController().signal,
      principal: { bearer: null },
      send: (target) => {
        expect(target).toBe("http://127.0.0.1:18200/v1/completions");
        dials++;
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    };
    expect((await cold.forward(dispatch)).status).toBe(503);
    expect(dials).toBe(0);
    replaceBeforeDial = false;
    expect((await cold.forward(dispatch)).status).toBe(204);
    expect(dials).toBe(1);
  } finally {
    cold.stop();
    warm.stop();
  }
});
