/**
 * #279 DF-06 — pure `buildProfileSwitchRequest` adapter in
 * `src/residency/coordinator`, keyed on the opt-in
 * `llamactl.io/residency-profiles` annotation: annotated workloads
 * declare the profiles they serve, unannotated ones are pinned
 * `protected` so a profile switch can never evict them. The module
 * lands with the fix, so it is reached through a guarded dynamic
 * import: at base the module is absent, `.catch` yields {}, and each
 * case fails by assertion — never by a missing module or a type
 * error. The specifier stays a `string` (not a literal) so `tsc`
 * cannot resolve it at base.
 */
import type {
  OkPlan,
  PlannerWorkload,
  ProfileSwitchPlan,
  ProfileSwitchPolicy,
  ProfileSwitchRequest,
  RefusalPlan,
} from "@llamactl/core/residency/planner";

import { RESIDENCY_GROUPS } from "@llamactl/core/residency/lifecycle";
import { planProfileSwitch } from "@llamactl/core/residency/planner";
import { describe, expect, test } from "bun:test";

import type { BuildProfileSwitchRequestInput } from "../../src/residency/coordinator.js";
import type { ModelHostManifest } from "../../src/workload/modelhost-schema.js";
import type { ModelRun } from "../../src/workload/schema.js";

import { RESIDENCY_GROUP_LABEL } from "../../src/server/modelhost.js";
import { ModelHostManifestSchema } from "../../src/workload/modelhost-schema.js";
import { ModelRunSchema } from "../../src/workload/schema.js";

// Widened to `string` on purpose: a literal specifier would let `tsc`
// resolve (and fail on) the not-yet-existing module at base.
const COORDINATOR_SPEC = "../../src/residency/coordinator.js" as string;

const NODE = "n1";
const NOW_MS = 1_000_000_000;
const GROUP = "z13-large-gpu";
const PROFILES_ANNOTATION = "llamactl.io/residency-profiles";
const PROTECTED_ANNOTATION = "llamactl.io/residency-protected";

type ObservedWorkloadState = "running" | "starting" | "stopped" | "unknown";

type BuildProfileSwitchRequestResult =
  | { ok: true; request: ProfileSwitchRequest }
  | { ok: false; reason: string; workloads: string[] };

interface ResidencyCoordinatorModule {
  buildProfileSwitchRequest?: (
    input: BuildProfileSwitchRequestInput,
  ) => BuildProfileSwitchRequestResult;
  RESIDENCY_GROUP_LABEL?: string;
  RESIDENCY_PROFILES_ANNOTATION?: string;
  RESIDENCY_PROTECTED_ANNOTATION?: string;
}

async function residencyCoordinator(): Promise<ResidencyCoordinatorModule> {
  const loaded = (await import(COORDINATOR_SPEC).catch(() => ({}))) as unknown;
  return loaded as ResidencyCoordinatorModule;
}

interface ManifestOptions {
  node?: string;
  enabled?: boolean;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

function hostManifest(name: string, options: ManifestOptions = {}): ModelHostManifest {
  return ModelHostManifestSchema.parse({
    apiVersion: "llamactl/v1",
    kind: "ModelHost",
    metadata: {
      name,
      ...(options.labels === undefined ? {} : { labels: options.labels }),
      ...(options.annotations === undefined ? {} : { annotations: options.annotations }),
    },
    spec: {
      engine: "omlx",
      node: options.node ?? NODE,
      enabled: options.enabled ?? true,
      binary: "/x/engine",
      endpoint: { host: "127.0.0.1", port: 8100 },
      hostedModels: [{ rel: "org/repo/m.gguf" }],
    },
  });
}

function runManifest(name: string, options: ManifestOptions = {}): ModelRun {
  return ModelRunSchema.parse({
    apiVersion: "llamactl/v1",
    kind: "ModelRun",
    metadata: {
      name,
      ...(options.labels === undefined ? {} : { labels: options.labels }),
      ...(options.annotations === undefined ? {} : { annotations: options.annotations }),
    },
    spec: {
      node: options.node ?? NODE,
      enabled: options.enabled ?? true,
      target: { kind: "rel", value: "org/repo/run.gguf" },
    },
  });
}

function groupHostManifest(name: string, annotations: Record<string, string>): ModelHostManifest {
  return hostManifest(name, {
    labels: { [RESIDENCY_GROUP_LABEL]: GROUP },
    annotations,
  });
}

function observedOf(
  entries: Record<string, ObservedWorkloadState>,
): Map<string, ObservedWorkloadState> {
  return new Map(Object.entries(entries));
}

function memoryOf(table: Record<string, number>): (name: string) => number {
  return (name: string): number => table[name] ?? 0;
}

interface FleetSpec {
  modelHosts?: ModelHostManifest[];
  modelRuns?: ModelRun[];
  observed?: ReadonlyMap<string, ObservedWorkloadState>;
  memory?: Record<string, number>;
  to?: string;
  budgetGiB?: number | null;
  from?: string | null;
  policy?: ProfileSwitchPolicy;
  requiredServices?: string[];
  lastSwitchAtMs?: number | null;
  groups?: readonly { name: string; exclusive: boolean }[];
}

function profileSwitchInput(spec: FleetSpec): BuildProfileSwitchRequestInput {
  return {
    node: NODE,
    to: spec.to ?? "interactive",
    from: spec.from,
    budgetGiB: spec.budgetGiB === undefined ? 64 : spec.budgetGiB,
    modelHosts: spec.modelHosts ?? [],
    modelRuns: spec.modelRuns ?? [],
    observed: spec.observed ?? new Map<string, ObservedWorkloadState>(),
    memoryGiBOf: memoryOf(spec.memory ?? {}),
    nowMs: NOW_MS,
    ...(spec.policy !== undefined ? { policy: spec.policy } : {}),
    ...(spec.requiredServices !== undefined ? { requiredServices: spec.requiredServices } : {}),
    ...(spec.lastSwitchAtMs !== undefined ? { lastSwitchAtMs: spec.lastSwitchAtMs } : {}),
    ...(spec.groups !== undefined ? { groups: spec.groups } : {}),
  };
}

function maintenanceFleet(): FleetSpec {
  return {
    modelRuns: [runManifest("chat", { annotations: { [PROFILES_ANNOTATION]: "interactive" } })],
    modelHosts: [
      hostManifest("dream", { annotations: { [PROFILES_ANNOTATION]: "maintenance" } }),
      hostManifest("embed"),
    ],
    observed: observedOf({ chat: "running", dream: "stopped", embed: "running" }),
    memory: { chat: 20, dream: 24, embed: 6 },
  };
}

function okRequest(result: BuildProfileSwitchRequestResult): ProfileSwitchRequest {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`expected ok build result, got refusal ${result.reason}`);
  }
  return result.request;
}

function plannerWorkload(workloads: readonly PlannerWorkload[], id: string): PlannerWorkload {
  const workload = workloads.find((wl) => wl.id === id);
  expect(workload).toBeDefined();
  if (workload === undefined) {
    throw new Error(`missing planner workload ${id}`);
  }
  return workload;
}

function okPlan(plan: ProfileSwitchPlan): OkPlan {
  expect(plan.ok).toBe(true);
  if (!plan.ok) {
    throw new Error(`expected ok plan, got refusal ${plan.reason}`);
  }
  return plan;
}

function refusedPlan(plan: ProfileSwitchPlan): RefusalPlan {
  expect(plan.ok).toBe(false);
  if (plan.ok) {
    throw new Error("expected refused plan");
  }
  return plan;
}

describe("buildProfileSwitchRequest", () => {
  test("parses profiles annotations into planner workloads, pinning unannotated protected", async () => {
    const mod = await residencyCoordinator();
    expect(typeof mod.buildProfileSwitchRequest).toBe("function");

    const result = mod.buildProfileSwitchRequest!(
      profileSwitchInput({
        modelRuns: [
          runManifest("chat", { annotations: { [PROFILES_ANNOTATION]: " chat , code ,chat" } }),
          runManifest("tool", { annotations: {} }),
        ],
        modelHosts: [hostManifest("embed")],
        observed: observedOf({ chat: "running", embed: "running", tool: "stopped" }),
        memory: { chat: 20, embed: 6, tool: 8 },
        to: "maintenance",
      }),
    );

    const request = okRequest(result);
    expect(request.node).toBe(NODE);
    expect(request.to).toBe("maintenance");
    expect(request.budgetGiB).toBe(64);
    expect(request.nowMs).toBe(NOW_MS);
    expect(request.groups).toEqual(RESIDENCY_GROUPS);
    expect(request.workloads.map((wl) => wl.id)).toEqual(["chat", "embed", "tool"]);

    const chat = plannerWorkload(request.workloads, "chat");
    expect(chat.profiles).toEqual(["chat", "code"]);
    expect(chat.protected ?? false).toBe(false);
    expect(chat.state).toBe("ready");
    expect(chat.expectedMemoryGiB).toBe(20);

    const embed = plannerWorkload(request.workloads, "embed");
    expect(embed.profiles).toEqual([]);
    expect(embed.protected).toBe(true);
    expect(embed.state).toBe("ready");
    expect(embed.expectedMemoryGiB).toBe(6);

    const tool = plannerWorkload(request.workloads, "tool");
    expect(tool.profiles).toEqual([]);
    expect(tool.protected).toBe(true);
    expect(tool.state).toBe("downloaded");
    expect(tool.expectedMemoryGiB).toBe(8);
  });

  test("feeds planProfileSwitch end to end: victim out, protected retained, replacement in", async () => {
    const mod = await residencyCoordinator();
    expect(typeof mod.buildProfileSwitchRequest).toBe("function");

    const result = mod.buildProfileSwitchRequest!(
      profileSwitchInput({ ...maintenanceFleet(), to: "maintenance", budgetGiB: 64 }),
    );

    const plan = okPlan(planProfileSwitch(okRequest(result)));
    expect(plan.victims).toEqual(["chat"]);
    expect(plan.replacements).toEqual(["dream"]);
    expect(plan.retained).toContain("embed");
    expect(plan.protected).toContain("embed");
    expect(plan.victims).not.toContain("embed");
    expect(plan.afterGiB).toBe(30);
    expect(plan.peakGiB).toBe(30);
  });

  test("counts protected retained memory toward budgetGiB", async () => {
    const mod = await residencyCoordinator();
    expect(typeof mod.buildProfileSwitchRequest).toBe("function");

    const result = mod.buildProfileSwitchRequest!(
      profileSwitchInput({ ...maintenanceFleet(), to: "maintenance", budgetGiB: 28 }),
    );

    const plan = refusedPlan(planProfileSwitch(okRequest(result)));
    expect(plan.reason).toBe("OverBudget");
  });

  test("refuses UnknownState when an unannotated workload is observed unknown", async () => {
    const mod = await residencyCoordinator();
    expect(typeof mod.buildProfileSwitchRequest).toBe("function");

    const result = mod.buildProfileSwitchRequest!(
      profileSwitchInput({
        modelRuns: [runManifest("chat", { annotations: { [PROFILES_ANNOTATION]: "chat" } })],
        modelHosts: [hostManifest("embed")],
        observed: observedOf({ chat: "running", embed: "unknown" }),
        memory: { chat: 20, embed: 6 },
        to: "chat",
      }),
    );

    expect(result).toEqual({ ok: false, reason: "UnknownState", workloads: ["embed"] });
  });

  test("refuses UnknownState when an annotated workload is observed unknown", async () => {
    const mod = await residencyCoordinator();
    expect(typeof mod.buildProfileSwitchRequest).toBe("function");

    const result = mod.buildProfileSwitchRequest!(
      profileSwitchInput({
        modelRuns: [runManifest("chat", { annotations: { [PROFILES_ANNOTATION]: "chat" } })],
        modelHosts: [hostManifest("embed")],
        observed: observedOf({ chat: "unknown", embed: "running" }),
        memory: { chat: 20, embed: 6 },
        to: "chat",
      }),
    );

    expect(result).toEqual({ ok: false, reason: "UnknownState", workloads: ["chat"] });
  });

  test("refuses UnknownState when an on-node workload has no observed entry", async () => {
    const mod = await residencyCoordinator();
    expect(typeof mod.buildProfileSwitchRequest).toBe("function");

    const result = mod.buildProfileSwitchRequest!(
      profileSwitchInput({
        modelRuns: [runManifest("chat", { annotations: { [PROFILES_ANNOTATION]: "chat" } })],
        modelHosts: [hostManifest("embed")],
        observed: observedOf({ embed: "running" }),
        memory: { chat: 20, embed: 6 },
        to: "chat",
      }),
    );

    expect(result).toEqual({ ok: false, reason: "UnknownState", workloads: ["chat"] });
  });

  test("refuses ProtectedEviction when a protected member shares an exclusive group", async () => {
    const mod = await residencyCoordinator();
    expect(typeof mod.buildProfileSwitchRequest).toBe("function");

    const result = mod.buildProfileSwitchRequest!(
      profileSwitchInput({
        modelHosts: [
          groupHostManifest("big-a", {
            [PROFILES_ANNOTATION]: "chat",
            [PROTECTED_ANNOTATION]: "true",
          }),
          groupHostManifest("big-b", { [PROFILES_ANNOTATION]: "code" }),
        ],
        observed: observedOf({ "big-a": "running", "big-b": "stopped" }),
        memory: { "big-a": 40, "big-b": 40 },
        to: "code",
        budgetGiB: 128,
      }),
    );

    const plan = refusedPlan(planProfileSwitch(okRequest(result)));
    expect(plan.reason).toBe("ProtectedEviction");
    expect(plan.workloads).toEqual(["big-a", "big-b"]);
  });

  test("plans the exclusive-group switch once the protected annotation is dropped", async () => {
    const mod = await residencyCoordinator();
    expect(typeof mod.buildProfileSwitchRequest).toBe("function");

    const result = mod.buildProfileSwitchRequest!(
      profileSwitchInput({
        modelHosts: [
          groupHostManifest("big-a", { [PROFILES_ANNOTATION]: "chat" }),
          groupHostManifest("big-b", { [PROFILES_ANNOTATION]: "code" }),
        ],
        observed: observedOf({ "big-a": "running", "big-b": "stopped" }),
        memory: { "big-a": 40, "big-b": 40 },
        to: "code",
        budgetGiB: 128,
      }),
    );

    const plan = okPlan(planProfileSwitch(okRequest(result)));
    expect(plan.victims).toEqual(["big-a"]);
  });

  test("excludes off-node workloads before resolving observed state", async () => {
    const mod = await residencyCoordinator();
    expect(typeof mod.buildProfileSwitchRequest).toBe("function");

    const result = mod.buildProfileSwitchRequest!(
      profileSwitchInput({
        modelHosts: [
          hostManifest("remote", {
            node: "other",
            annotations: { [PROFILES_ANNOTATION]: "chat" },
          }),
        ],
        modelRuns: [runManifest("chat", { annotations: { [PROFILES_ANNOTATION]: "chat" } })],
        observed: observedOf({ chat: "running" }),
        memory: { chat: 20 },
        to: "chat",
      }),
    );

    const request = okRequest(result);
    expect(request.workloads.map((wl) => wl.id)).toEqual(["chat"]);
  });

  test("excludes an off-node annotated workload even when it is observed", async () => {
    const mod = await residencyCoordinator();
    expect(typeof mod.buildProfileSwitchRequest).toBe("function");

    const result = mod.buildProfileSwitchRequest!(
      profileSwitchInput({
        modelHosts: [
          hostManifest("remote", {
            node: "other",
            annotations: { [PROFILES_ANNOTATION]: "chat" },
          }),
        ],
        modelRuns: [runManifest("chat", { annotations: { [PROFILES_ANNOTATION]: "chat" } })],
        observed: observedOf({ chat: "running", remote: "running" }),
        memory: { chat: 20, remote: 40 },
        to: "chat",
      }),
    );

    const request = okRequest(result);
    expect(request.workloads.map((wl) => wl.id)).toEqual(["chat"]);
  });

  test("refuses DuplicateId when a ModelRun and a ModelHost share a name", async () => {
    const mod = await residencyCoordinator();
    expect(typeof mod.buildProfileSwitchRequest).toBe("function");

    const result = mod.buildProfileSwitchRequest!(
      profileSwitchInput({
        modelRuns: [runManifest("coder", { annotations: { [PROFILES_ANNOTATION]: "code" } })],
        modelHosts: [hostManifest("coder", { annotations: { [PROFILES_ANNOTATION]: "code" } })],
        observed: observedOf({ coder: "running" }),
        memory: { coder: 20 },
        to: "code",
      }),
    );

    expect(result).toEqual({ ok: false, reason: "DuplicateId", workloads: ["coder"] });
  });

  test("refuses NotOptedIn when the only annotated workload is off-node", async () => {
    const mod = await residencyCoordinator();
    expect(typeof mod.buildProfileSwitchRequest).toBe("function");

    const result = mod.buildProfileSwitchRequest!(
      profileSwitchInput({
        modelRuns: [
          runManifest("coder", { node: "other", annotations: { [PROFILES_ANNOTATION]: "code" } }),
        ],
        modelHosts: [hostManifest("embed")],
        observed: observedOf({ embed: "running" }),
        memory: { embed: 6 },
        to: "code",
      }),
    );

    expect(result).toEqual({ ok: false, reason: "NotOptedIn", workloads: [] });
  });

  test("treats a malformed profiles annotation as unannotated", async () => {
    const mod = await residencyCoordinator();
    expect(typeof mod.buildProfileSwitchRequest).toBe("function");

    const result = mod.buildProfileSwitchRequest!(
      profileSwitchInput({
        modelRuns: [
          runManifest("odd", { annotations: { [PROFILES_ANNOTATION]: " , " } }),
          runManifest("chat", { annotations: { [PROFILES_ANNOTATION]: "chat" } }),
        ],
        observed: observedOf({ odd: "running", chat: "running" }),
        memory: { odd: 4, chat: 20 },
        to: "chat",
      }),
    );

    const request = okRequest(result);
    const odd = plannerWorkload(request.workloads, "odd");
    expect(odd.profiles).toEqual([]);
    expect(odd.protected).toBe(true);
    const chat = plannerWorkload(request.workloads, "chat");
    expect(chat.profiles).toEqual(["chat"]);
  });

  test("refuses NotOptedIn when no on-node workload carries the profiles annotation", async () => {
    const mod = await residencyCoordinator();
    expect(typeof mod.buildProfileSwitchRequest).toBe("function");

    const result = mod.buildProfileSwitchRequest!(
      profileSwitchInput({
        modelHosts: [
          hostManifest("embed"),
          hostManifest("sidecar", { labels: { [RESIDENCY_GROUP_LABEL]: GROUP } }),
        ],
        modelRuns: [runManifest("chat")],
        observed: observedOf({ embed: "running", sidecar: "running", chat: "running" }),
        memory: { embed: 6, sidecar: 40, chat: 20 },
      }),
    );

    expect(result).toEqual({ ok: false, reason: "NotOptedIn", workloads: [] });
  });

  test("refuses NotOptedIn when the only profiles annotation is malformed", async () => {
    const mod = await residencyCoordinator();
    expect(typeof mod.buildProfileSwitchRequest).toBe("function");

    const result = mod.buildProfileSwitchRequest!(
      profileSwitchInput({
        modelRuns: [runManifest("odd", { annotations: { [PROFILES_ANNOTATION]: " , " } })],
        observed: observedOf({ odd: "running" }),
        memory: { odd: 4 },
      }),
    );

    expect(result).toEqual({ ok: false, reason: "NotOptedIn", workloads: [] });
  });

  test("exports the residency annotation and group-label constants", async () => {
    const mod = await residencyCoordinator();
    expect(typeof mod.buildProfileSwitchRequest).toBe("function");

    expect(mod.RESIDENCY_GROUP_LABEL).toBe(RESIDENCY_GROUP_LABEL);
    expect(mod.RESIDENCY_PROFILES_ANNOTATION).toBe("llamactl.io/residency-profiles");
    expect(mod.RESIDENCY_PROTECTED_ANNOTATION).toBe("llamactl.io/residency-protected");
  });

  test("leaves inputs untouched and returns deep-equal results across calls", async () => {
    const mod = await residencyCoordinator();
    expect(typeof mod.buildProfileSwitchRequest).toBe("function");

    const modelHosts = [hostManifest("embed")];
    const modelRuns = [
      runManifest("chat", { annotations: { [PROFILES_ANNOTATION]: "chat , code" } }),
    ];
    const observed = observedOf({ chat: "running", embed: "running" });
    const input = profileSwitchInput({
      modelHosts,
      modelRuns,
      observed,
      memory: { chat: 20, embed: 6 },
      to: "code",
    });

    const manifestsBefore = structuredClone({ modelHosts, modelRuns });
    const observedBefore = structuredClone([...observed]);

    const first = mod.buildProfileSwitchRequest!(input);
    const second = mod.buildProfileSwitchRequest!(input);

    expect(structuredClone({ modelHosts, modelRuns })).toEqual(manifestsBefore);
    expect(structuredClone([...observed])).toEqual(observedBefore);
    expect(second).toEqual(first);
  });

  test("maps stopped ModelRun with enabled:false to disabled:true in planner workload", async () => {
    const mod = await residencyCoordinator();
    expect(typeof mod.buildProfileSwitchRequest).toBe("function");

    const result = mod.buildProfileSwitchRequest!(
      profileSwitchInput({
        modelRuns: [
          runManifest("chat", {
            annotations: { [PROFILES_ANNOTATION]: "interactive" },
            enabled: false,
          }),
        ],
        observed: observedOf({ chat: "stopped" }),
        memory: { chat: 20 },
        to: "interactive",
      }),
    );

    const request = okRequest(result);
    const chat = plannerWorkload(request.workloads, "chat");
    expect(chat.disabled).toBe(true);
    expect(chat.state).toBe("downloaded");

    const plan = okPlan(planProfileSwitch(request));
    expect(plan.skipped).toContain("chat");
    expect(plan.replacements).not.toContain("chat");
  });

  test("maps stopped ModelHost with enabled:false to disabled:true in planner workload", async () => {
    const mod = await residencyCoordinator();
    expect(typeof mod.buildProfileSwitchRequest).toBe("function");

    const result = mod.buildProfileSwitchRequest!(
      profileSwitchInput({
        modelHosts: [
          hostManifest("dream", {
            annotations: { [PROFILES_ANNOTATION]: "maintenance" },
            enabled: false,
          }),
        ],
        observed: observedOf({ dream: "stopped" }),
        memory: { dream: 24 },
        to: "maintenance",
      }),
    );

    const request = okRequest(result);
    const dream = plannerWorkload(request.workloads, "dream");
    expect(dream.disabled).toBe(true);
    expect(dream.state).toBe("downloaded");

    const plan = okPlan(planProfileSwitch(request));
    expect(plan.skipped).toContain("dream");
    expect(plan.replacements).not.toContain("dream");
  });

  test("maps 'starting' observed state to 'loading' planner state", async () => {
    const mod = await residencyCoordinator();
    expect(typeof mod.buildProfileSwitchRequest).toBe("function");

    const result = mod.buildProfileSwitchRequest!(
      profileSwitchInput({
        modelRuns: [runManifest("chat", { annotations: { [PROFILES_ANNOTATION]: "chat" } })],
        observed: observedOf({ chat: "starting" }),
        memory: { chat: 20 },
        to: "chat",
      }),
    );

    const request = okRequest(result);
    const chat = plannerWorkload(request.workloads, "chat");
    expect(chat.state).toBe("loading");
  });

  test("passes through from, policy, requiredServices, lastSwitchAtMs and groups", async () => {
    const mod = await residencyCoordinator();
    expect(typeof mod.buildProfileSwitchRequest).toBe("function");

    const policy: ProfileSwitchPolicy = {
      minResidencySeconds: 300,
      switchCooldownSeconds: 600,
    };
    const requiredServices = ["vector-db", "cache"];
    const groups = [{ name: "custom-group", exclusive: false }];

    const result = mod.buildProfileSwitchRequest!(
      profileSwitchInput({
        modelRuns: [runManifest("chat", { annotations: { [PROFILES_ANNOTATION]: "chat" } })],
        observed: observedOf({ chat: "running" }),
        memory: { chat: 20 },
        to: "code",
        from: "interactive",
        policy,
        requiredServices,
        lastSwitchAtMs: 900_000_000,
        groups,
      }),
    );

    const request = okRequest(result);
    expect(request.from).toBe("interactive");
    expect(request.policy).toEqual(policy);
    expect(request.requiredServices).toEqual(requiredServices);
    expect(request.lastSwitchAtMs).toBe(900_000_000);
    expect(request.groups).toEqual(groups);

    const requiredCopy = request.requiredServices;
    const inputRequired = requiredServices;
    expect(requiredCopy).not.toBe(inputRequired);
  });

  test("refuses switch when cooldown period has not elapsed", async () => {
    const mod = await residencyCoordinator();
    expect(typeof mod.buildProfileSwitchRequest).toBe("function");

    const policy: ProfileSwitchPolicy = {
      switchCooldownSeconds: 600,
    };

    const result = mod.buildProfileSwitchRequest!(
      profileSwitchInput({
        modelRuns: [runManifest("chat", { annotations: { [PROFILES_ANNOTATION]: "chat" } })],
        observed: observedOf({ chat: "running" }),
        memory: { chat: 20 },
        to: "code",
        policy,
        lastSwitchAtMs: NOW_MS - 200_000,
      }),
    );

    const plan = refusedPlan(planProfileSwitch(okRequest(result)));
    expect(plan.reason).toBe("Cooldown");
  });

  test("refuses switch when required service is unavailable", async () => {
    const mod = await residencyCoordinator();
    expect(typeof mod.buildProfileSwitchRequest).toBe("function");

    const result = mod.buildProfileSwitchRequest!(
      profileSwitchInput({
        modelRuns: [runManifest("chat", { annotations: { [PROFILES_ANNOTATION]: "chat" } })],
        observed: observedOf({ chat: "running" }),
        memory: { chat: 20 },
        to: "code",
        requiredServices: ["vector-db"],
      }),
    );

    const plan = refusedPlan(planProfileSwitch(okRequest(result)));
    expect(plan.reason).toBe("RequiredServiceUnavailable");
  });
});
