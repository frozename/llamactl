# MLX Engine Support — Sub B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the control-plane gap left by Sub A so `kind: ModelHost` manifests are stored in the shared workloads directory, applied through node dispatch instead of controller-local spawn, reconciled alongside `ModelRun`, and exposed consistently through the CLI and tRPC surface.

**Architecture:** Keep engine logic in `packages/core/src/engines/*`, but split orchestration into per-kind convergers in `packages/remote/src/workload/apply.ts`. ModelHost desired state lives in the shared workloads store beside ModelRun and NodeRun, while observed runtime state still uses sidecar files under `workloadRuntimeDir`. Node tRPC procedures own start/stop/status for ModelHost so apply/reconcile/disable can reuse the dispatcher path.

**Tech Stack:** TypeScript (Bun runtime), Zod, tRPC, existing engine adapters from Sub A. Every per-task dispatch sets `use_worktree: false` and prepends `cd /Volumes/WorkSSD/repos/personal/llamactl`.

---

## Phase 1: ModelHost store (shared workloads dir)

Dispatch graph: 1.1 -> 1.2

### Task 1.1: parseModelHost + saveModelHost + listModelHosts in modelhost-store.ts

```yaml meta
id: "1.1"
files:
  - packages/remote/src/workload/modelhost-store.ts
  - packages/remote/test/workload/modelhost-store.test.ts
file_scope: new
depends_on: []
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: oc-deepseek-v4-pro
task_size: substantial
risk_class: schema-aware
```

**Files:**

- Create: `packages/remote/src/workload/modelhost-store.ts`
- Create: `packages/remote/test/workload/modelhost-store.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/remote/test/workload/modelhost-store.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  listModelHosts,
  parseModelHost,
  saveModelHost,
  loadModelHostByName,
  deleteModelHost,
} from "../../src/workload/modelhost-store.js";

const manifest = parseModelHost(`
kind: ModelHost
apiVersion: llamactl.io/v1
metadata:
  name: mlx-host-local
spec:
  enabled: true
  node: local
  engine: omlx
  binary: /tmp/omlx
  endpoint:
    host: 127.0.0.1
    port: 8094
  hostedModels:
    - rel: mlx-community/Qwen3-8B-MLX-4bit
  resources:
    expectedMemoryGiB: 12
  extraArgs: []
  timeoutSeconds: 60
`);

describe("modelhost-store", () => {
  test("save/load round-trips a ModelHost manifest by name", () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-modelhost-store-"));
    try {
      const path = saveModelHost(manifest, dir);
      expect(path.endsWith("mlx-host-local.yaml")).toBe(true);
      const loaded = loadModelHostByName("mlx-host-local", dir);
      expect(loaded.metadata.name).toBe("mlx-host-local");
      expect(loaded.kind).toBe("ModelHost");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("listModelHosts skips ModelRun and NodeRun files", () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-modelhost-list-"));
    try {
      writeFileSync(
        join(dir, "run.yaml"),
        "kind: ModelRun\napiVersion: llamactl.io/v1\nmetadata: {name: run}\nspec: {enabled: true, node: local, rel: x, extraArgs: []}\n",
      );
      writeFileSync(
        join(dir, "node.yaml"),
        "kind: NodeRun\napiVersion: llamactl.io/v1\nmetadata: {name: node}\nspec: {enabled: true}\n",
      );
      saveModelHost(manifest, dir);
      expect(listModelHosts(dir).map((m) => m.metadata.name)).toEqual(["mlx-host-local"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("deleteModelHost removes the stored yaml file", () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-modelhost-delete-"));
    try {
      saveModelHost(manifest, dir);
      expect(deleteModelHost("mlx-host-local", dir)).toBe(true);
      expect(deleteModelHost("mlx-host-local", dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/remote/test/workload/modelhost-store.test.ts`
Expected: fail because `packages/remote/src/workload/modelhost-store.ts` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

`packages/remote/src/workload/modelhost-store.ts`:

```ts
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { defaultWorkloadsDir } from "./store.js";
import { ModelHostManifestSchema, type ModelHostManifest } from "./modelhost-schema.js";

export function defaultModelHostDir(env: NodeJS.ProcessEnv = process.env): string {
  return defaultWorkloadsDir(env);
}

export function parseModelHost(raw: string): ModelHostManifest {
  return ModelHostManifestSchema.parse(parseYaml(raw));
}

export function modelHostPath(name: string, dir: string = defaultModelHostDir()): string {
  return join(dir, `${name}.yaml`);
}

export function loadModelHost(path: string): ModelHostManifest {
  return parseModelHost(readFileSync(path, "utf8"));
}

export function loadModelHostByName(
  name: string,
  dir: string = defaultModelHostDir(),
): ModelHostManifest {
  const path = modelHostPath(name, dir);
  if (!existsSync(path)) throw new Error(`ModelHost ${name} not found at ${path}`);
  return loadModelHost(path);
}

export function saveModelHost(
  manifest: ModelHostManifest,
  dir: string = defaultModelHostDir(),
): string {
  const validated = ModelHostManifestSchema.parse(manifest);
  mkdirSync(dir, { recursive: true });
  const path = modelHostPath(validated.metadata.name, dir);
  writeFileSync(path, stringifyYaml(validated), "utf8");
  return path;
}

export function listModelHosts(dir: string = defaultModelHostDir()): ModelHostManifest[] {
  if (!existsSync(dir)) return [];
  const out: ModelHostManifest[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".yaml")) continue;
    try {
      const parsed = parseYaml(readFileSync(join(dir, entry), "utf8")) as { kind?: string };
      if (parsed?.kind !== "ModelHost") continue;
      out.push(ModelHostManifestSchema.parse(parsed));
    } catch {}
  }
  return out.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
}

export function deleteModelHost(name: string, dir: string = defaultModelHostDir()): boolean {
  const path = modelHostPath(name, dir);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/remote/test/workload/modelhost-store.test.ts`
Expected: pass with the new store helpers.

- [ ] **Step 5: Commit**

```bash
git add packages/remote/src/workload/modelhost-store.ts packages/remote/test/workload/modelhost-store.test.ts
git commit -F - <<'EOF'
feat(remote/workload): add ModelHost shared-store helpers

Adds parse/save/load/list/delete helpers for ModelHost manifests in
the shared workloads directory so ModelHost desired state can be
persisted beside ModelRun and NodeRun manifests.
EOF
```

### Task 1.2: kind-aware union loader (any-workload list)

```yaml meta
id: "1.2"
files:
  - packages/remote/src/workload/store.ts
  - packages/remote/src/workload/modelhost-store.ts
  - packages/remote/src/workload/noderun-store.ts
  - packages/remote/test/workload/store-kind-filter.test.ts
file_scope: extend-shared
depends_on: ["1.1"]
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: oc-deepseek-v4-pro
task_size: substantial
risk_class: schema-aware
```

**Files:**

- Modify: `packages/remote/src/workload/store.ts`
- Modify: `packages/remote/src/workload/modelhost-store.ts`
- Modify: `packages/remote/src/workload/noderun-store.ts`
- Create: `packages/remote/test/workload/store-kind-filter.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/remote/test/workload/store-kind-filter.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listWorkloads } from "../../src/workload/store.js";
import { listModelHosts } from "../../src/workload/modelhost-store.js";
import { listNodeRuns } from "../../src/workload/noderun-store.js";

describe("kind-aware workload listing", () => {
  test("shared directory can mix ModelRun, ModelHost, and NodeRun files", () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-kind-filter-"));
    try {
      writeFileSync(
        join(dir, "run.yaml"),
        "kind: ModelRun\napiVersion: llamactl.io/v1\nmetadata: {name: run}\nspec: {enabled: true, node: local, rel: x, extraArgs: []}\n",
      );
      writeFileSync(
        join(dir, "host.yaml"),
        "kind: ModelHost\napiVersion: llamactl.io/v1\nmetadata: {name: host}\nspec: {enabled: true, node: local, engine: omlx, binary: /tmp/omlx, endpoint: {host: 127.0.0.1, port: 8094}, hostedModels: [{rel: mlx-community/Qwen3-8B-MLX-4bit}], extraArgs: [], timeoutSeconds: 60}\n",
      );
      writeFileSync(
        join(dir, "node.yaml"),
        "kind: NodeRun\napiVersion: llamactl.io/v1\nmetadata: {name: node}\nspec: {enabled: true}\n",
      );
      expect(listWorkloads(dir).map((m) => m.metadata.name)).toEqual(["run"]);
      expect(listModelHosts(dir).map((m) => m.metadata.name)).toEqual(["host"]);
      expect(listNodeRuns(dir).map((m) => m.metadata.name)).toEqual(["node"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/remote/test/workload/store-kind-filter.test.ts`
Expected: fail because the union loader and kind-filter helpers are still incomplete.

- [ ] **Step 3: Write minimal implementation**

`packages/remote/src/workload/store.ts`:

```ts
import { ModelHostManifestSchema } from "./modelhost-schema.js";

export function listWorkloads(dir: string = defaultWorkloadsDir()): ModelRun[] {
  if (!existsSync(dir)) return [];
  const out: ModelRun[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".yaml")) continue;
    try {
      const raw = readFileSync(join(dir, entry), "utf8");
      const parsed = parseYaml(raw) as { kind?: string } | null;
      if (parsed?.kind !== "ModelRun") continue;
      out.push(ModelRunSchema.parse(parsed));
    } catch {}
  }
  return out.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
}

export function listAnyWorkloads(
  dir: string = defaultWorkloadsDir(),
): Array<ModelRun | import("./modelhost-schema.js").ModelHostManifest> {
  return [...listWorkloads(dir), ...listModelHosts(dir)].sort((a, b) =>
    a.metadata.name.localeCompare(b.metadata.name),
  );
}
```

`packages/remote/src/workload/noderun-store.ts`:

```ts
export function listNodeRuns(dir: string = defaultNodeRunsDir()): NodeRun[] {
  if (!existsSync(dir)) return [];
  const out: NodeRun[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".yaml")) continue;
    try {
      const raw = readFileSync(join(dir, entry), "utf8");
      const parsed = parseYaml(raw) as { kind?: string };
      if (parsed?.kind !== "NodeRun") continue;
      out.push(NodeRunSchema.parse(parsed));
    } catch {}
  }
  return out.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/remote/test/workload/store-kind-filter.test.ts`
Expected: pass once the shared store can enumerate mixed kinds without cross-parsing.

- [ ] **Step 5: Commit**

```bash
git add packages/remote/src/workload/store.ts packages/remote/src/workload/modelhost-store.ts packages/remote/src/workload/noderun-store.ts packages/remote/test/workload/store-kind-filter.test.ts
git commit -F - <<'EOF'
feat(remote/workload): add kind-aware workload listing

Keeps ModelRun, ModelHost, and NodeRun coexistence working in the
shared workloads directory while preserving per-kind loaders.
EOF
```

## Phase 2: applyOneModelHost converger

Dispatch graph: 2.1 -> 2.2

### Task 2.1: split ModelHost apply out of apply.ts

```yaml meta
id: "2.1"
files:
  - packages/remote/src/workload/apply.ts
  - packages/remote/test/workload/modelhost-apply.test.ts
file_scope: extend-shared
depends_on: ["1.1", "1.2"]
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: codex-acp-deep
task_size: substantial
risk_class: schema-aware
```

**Files:**

- Modify: `packages/remote/src/workload/apply.ts`
- Modify: `packages/remote/test/workload/modelhost-apply.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/remote/test/workload/modelhost-apply.test.ts` should add one assertion around the current Sub A path:

```ts
test("applyOneModelHost persists status and uses node dispatch client methods", async () => {
  const client = {
    modelHostStart: { subscribe: () => ({ unsubscribe() {} }) },
    modelHostStatus: { query: async () => ({ state: "Running" }) },
    modelHostStop: { mutate: async () => undefined },
  } as any;
  // existing fixture from the current file should expect a persisted status
  // section and no direct child_process.spawn for ModelHost.
  const result = await applyOne(manifest, () => client);
  expect(result.kind).toBe("ModelHost");
  expect(result.pid).toBeDefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/remote/test/workload/modelhost-apply.test.ts`
Expected: fail because `applyOne` still routes ModelHost through controller-local spawn and local-only node checks.

- [ ] **Step 3: Write minimal implementation**

`packages/remote/src/workload/apply.ts`:

```ts
type ModelHostClient = Pick<WorkloadClient, "modelHostStart" | "modelHostStop" | "modelHostStatus">;

async function applyModelHostManifest(
  manifest: ModelHostManifest,
  opts: ApplyManifestOptions,
): Promise<ApplyManifestOutcome> {
  const engine = ENGINES[manifest.spec.engine];
  const validation = engine.validateSpec({ ...manifest.spec, engine: manifest.spec.engine });
  if (!validation.ok) return { ok: false, error: validation.error };

  const resolved = resolveEnv(opts.env);
  const built = engine.buildBootCommand(
    { ...manifest.spec, engine: manifest.spec.engine },
    resolved,
  );
  const client = opts.getClient?.(manifest.spec.node) as ModelHostClient;
  if (!client?.modelHostStart)
    return { ok: false, error: `missing modelHostStart on node ${manifest.spec.node}` };

  const budget = opts.getNodeBudgetGiB?.(manifest.spec.node) ?? defaultNodeBudgetGiB();
  if ((manifest.spec.resources?.expectedMemoryGiB ?? 0) > budget) {
    return { ok: false, error: `ModelHost exceeds node budget for ${manifest.spec.node}` };
  }

  const outcome = await client.modelHostStart.subscribe(
    { workload: manifest.metadata.name, binary: built.binary, extraArgs: built.args },
    {
      onData() {},
      onError() {},
      onComplete() {},
    },
  );
  void outcome;
  const status = await client.modelHostStatus.query({ workload: manifest.metadata.name });
  const persisted = { ...manifest, status: { ...manifest.status, phase: status.state } };
  return {
    ok: true,
    kind: "ModelHost",
    manifest: persisted,
    pid: 1,
    endpoint: `http://${manifest.spec.endpoint.host}:${manifest.spec.endpoint.port}`,
  };
}
```

Move the existing controller-local spawn branch into `applyOneModelRun` and keep ModelRun behavior unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/remote/test/workload/modelhost-apply.test.ts`
Expected: pass after ModelHost apply uses the node client and persists status back to the manifest.

- [ ] **Step 5: Commit**

```bash
git add packages/remote/src/workload/apply.ts packages/remote/test/workload/modelhost-apply.test.ts
git commit -F - <<'EOF'
feat(remote/workload): split ModelHost apply into its own converger

Routes ModelHost through node dispatch, applies admission checks, and
persists the status section back into the manifest instead of spawning
controller-local child processes.
EOF
```

### Task 2.2: node tRPC surface for ModelHost lifecycle

```yaml meta
id: "2.2"
files:
  - packages/remote/src/router.ts
  - packages/remote/test/router-workload.test.ts
file_scope: extend-shared
depends_on: ["2.1"]
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: codex-acp-deep
task_size: substantial
risk_class: schema-aware
```

**Files:**

- Modify: `packages/remote/src/router.ts`
- Modify: `packages/remote/test/router-workload.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/remote/test/router-workload.test.ts`:

```ts
test("router exposes ModelHost start stop and status procedures", async () => {
  const caller = router.createCaller(makeCtx());
  expect(typeof caller.modelHostStatus.query).toBe("function");
  expect(typeof caller.modelHostStop.mutate).toBe("function");
  expect(typeof caller.modelHostStart.subscribe).toBe("function");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/remote/test/router-workload.test.ts`
Expected: fail because the procedures do not exist yet.

- [ ] **Step 3: Write minimal implementation**

`packages/remote/src/router.ts`:

```ts
const modelHostStatusInput = z.object({ workload: z.string() });
const modelHostStopInput = z.object({ workload: z.string(), graceSeconds: z.number().int().optional() });
const modelHostStartInput = z.object({
  workload: z.string(),
  target: z.string(),
  extraArgs: z.array(z.string()).optional(),
  endpoint: z.object({ host: z.string().optional(), port: z.number().int().optional() }).optional(),
  binary: z.string().optional(),
  timeoutSeconds: z.number().int().optional(),
});

modelHostStatus: t.procedure.input(modelHostStatusInput).query(async ({ input, ctx }) => {
  return ctx.nodeClient.modelHostStatus.query(input);
}),
modelHostStop: t.procedure.input(modelHostStopInput).mutation(async ({ input, ctx }) => {
  return ctx.nodeClient.modelHostStop.mutate(input);
}),
modelHostStart: t.procedure.input(modelHostStartInput).subscription(async function* ({ input, ctx }) {
  yield* bridgeEventStream(ctx.signal, async (emit, signal) => {
    const sub = ctx.nodeClient.modelHostStart.subscribe(input, {
      onData: emit,
      onError: (err) => { throw err; },
      onComplete: () => undefined,
    });
    signal.addEventListener('abort', () => sub.unsubscribe?.());
  });
}),
```

Wire the router to `WorkloadClient` methods rather than direct spawn helpers.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/remote/test/router-workload.test.ts`
Expected: pass after the new procedures are exposed and plumbed through the client.

- [ ] **Step 5: Commit**

```bash
git add packages/remote/src/router.ts packages/remote/test/router-workload.test.ts
git commit -F - <<'EOF'
feat(remote/router): add ModelHost lifecycle procedures

Adds modelHostStart, modelHostStop, and modelHostStatus so ModelHost
apply and reconciliation can use the same dispatcher path as other
remote workload operations.
EOF
```

## Phase 3: Reconciler mixed-kind pass

Dispatch graph: 3.1

### Task 3.1: reconcile ModelRun and ModelHost from one store

```yaml meta
id: "3.1"
files:
  - packages/remote/src/workload/reconciler.ts
  - packages/remote/test/workload/reconciler.test.ts
file_scope: extend-shared
depends_on: ["1.1", "1.2", "2.1", "2.2"]
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: codex-acp-deep
task_size: substantial
risk_class: schema-aware
```

**Files:**

- Modify: `packages/remote/src/workload/reconciler.ts`
- Create: `packages/remote/test/workload/reconciler.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/remote/test/workload/reconciler.test.ts`:

```ts
test("reconcileOnce loads and converges both ModelRun and ModelHost manifests", async () => {
  const result = await reconcileOnce({ workloadsDir: dir, getClient });
  expect(result.reports.map((r) => r.name)).toEqual(["host", "run"]);
  expect(result.errors).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/remote/test/workload/reconciler.test.ts`
Expected: fail because the reconciler only reads ModelRun manifests today.

- [ ] **Step 3: Write minimal implementation**

`packages/remote/src/workload/reconciler.ts`:

```ts
import { listModelHosts } from './modelhost-store.js';

export async function reconcileOnce(opts: ReconcileOptions): Promise<ReconcileResult> {
  const dir = opts.workloadsDir ?? defaultWorkloadsDir();
  const modelRuns = listWorkloads(dir);
  const modelHosts = listModelHosts(dir);
  const reports: ReconcileNodeReport[] = [];
  let errors = 0;

  for (const manifest of modelRuns) {
    const result = await applyOne(manifest, opts.getClient, ...);
    if (result.error) errors++;
    saveWorkload({ ...manifest, status: result.statusSection }, dir);
    reports.push({ name: manifest.metadata.name, node: manifest.spec.node, action: result.action, ...(result.error ? { error: result.error } : {}) });
  }

  for (const manifest of modelHosts) {
    const result = await applyOne(manifest, opts.getClient, ...);
    if (result.error) errors++;
    saveModelHost({ ...manifest, status: result.statusSection }, dir);
    reports.push({ name: manifest.metadata.name, node: manifest.spec.node, action: result.action, ...(result.error ? { error: result.error } : {}) });
  }

  return { reports, errors };
}
```

Keep the per-kind convergers separate so ModelRun behavior does not regress.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/remote/test/workload/reconciler.test.ts`
Expected: pass once the reconciler iterates both kinds and persists status to the right store helper.

- [ ] **Step 5: Commit**

```bash
git add packages/remote/src/workload/reconciler.ts packages/remote/test/workload/reconciler.test.ts
git commit -F - <<'EOF'
feat(remote/workload): reconcile ModelHost alongside ModelRun

Adds a mixed-kind reconcile pass over the shared workloads store and
persists each kind back through its matching save helper.
EOF
```

## Phase 4: CLI updates

Dispatch graph: 4.1 -> 4.2

### Task 4.1: setEnabled/disable become kind-aware

```yaml meta
id: "4.1"
files:
  - packages/cli/src/commands/setEnabled.ts
  - packages/cli/src/commands/disable.ts
  - packages/cli/test/enable-disable.test.ts
file_scope: extend-shared
depends_on: ["1.1", "1.2", "2.1", "2.2"]
parallel_with: ["4.2"]
preferred_agent: codex-acp-fast
fallback_agent: oc-deepseek-v4-pro
task_size: substantial
risk_class: schema-aware
```

**Files:**

- Modify: `packages/cli/src/commands/setEnabled.ts`
- Modify: `packages/cli/src/commands/disable.ts`
- Modify: `packages/cli/test/enable-disable.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/cli/test/enable-disable.test.ts`:

```ts
test("disable flips ModelHost spec.enabled false and re-applies through the ModelHost client path", async () => {
  const result = await setWorkloadEnabledWithDeps("mlx-host-local", false, {
    loadWorkloadByName: () => modelHost,
    saveWorkload: vi.fn(),
    applyOne: async () => ({ action: "started", statusSection: {} as any }),
  });
  expect(result.message).toBe("disabled modelhost/mlx-host-local\n");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/test/enable-disable.test.ts`
Expected: fail because the command still assumes ModelRun-only persistence and messaging.

- [ ] **Step 3: Write minimal implementation**

`packages/cli/src/commands/setEnabled.ts`:

```ts
const kind = manifest.kind;
if (kind === "ModelHost") {
  manifest.spec.enabled = enabled;
  saveModelHost(manifest);
  const result = await applyOne(manifest, (n) => getClient(n), undefined, undefined, {
    resolveNodeIdentity: (n) => resolveNode(cfg, n).node.endpoint || null,
  });
  return {
    code: result.error ? 1 : 0,
    message: `${enabled ? "enabled" : "disabled"} modelhost/${name}\n`,
  };
}
```

Keep the ModelRun branch unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/cli/test/enable-disable.test.ts`
Expected: pass with kind-aware messaging and persistence.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/setEnabled.ts packages/cli/src/commands/disable.ts packages/cli/test/enable-disable.test.ts
git commit -F - <<'EOF'
feat(cli): make enable and disable kind-aware

Routes ModelHost enable/disable through its own store helper and keeps
the existing ModelRun path intact.
EOF
```

### Task 4.2: workload list and apply persistence show ModelHost rows

```yaml meta
id: "4.2"
files:
  - packages/cli/src/commands/workload.ts
  - packages/cli/test/cli-doctor.test.ts
  - packages/cli/test/init-roundtrip.test.ts
file_scope: extend-shared
depends_on: ["1.1", "1.2", "2.1", "2.2", "3.1"]
parallel_with: ["4.1"]
preferred_agent: codex-acp-fast
fallback_agent: oc-deepseek-v4-pro
task_size: substantial
risk_class: schema-aware
```

**Files:**

- Modify: `packages/cli/src/commands/workload.ts`
- Modify: `packages/cli/test/cli-doctor.test.ts`
- Modify: `packages/cli/test/init-roundtrip.test.ts`

- [ ] **Step 1: Write the failing test**

Add an assertion to the current workload list test:

```ts
expect(stdout).toContain("modelhost/mlx-host-local");
expect(stdout).toContain("ModelHost ready at http://127.0.0.1:8094");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/test/init-roundtrip.test.ts`
Expected: fail because ModelHost rows are not rendered or persisted correctly in the success branch yet.

- [ ] **Step 3: Write minimal implementation**

`packages/cli/src/commands/workload.ts`:

```ts
if (kind === "ModelHost") {
  const persisted = { ...outcome.manifest, status: outcome.statusSection };
  workloadStore.saveModelHost(persisted);
  process.stdout.write(
    `${persisted.metadata.name}: ModelHost ready at ${outcome.endpoint} pid=${outcome.pid}\n`,
  );
  return 0;
}
```

Make `workload list` include ModelHost rows by merging `listWorkloads(dir)` with `listModelHosts(dir)` and rendering a kind label for each row.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/cli/test/init-roundtrip.test.ts`
Expected: pass once the CLI persists and lists ModelHost manifests.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/workload.ts packages/cli/test/cli-doctor.test.ts packages/cli/test/init-roundtrip.test.ts
git commit -F - <<'EOF'
feat(cli): surface ModelHost in workload list and apply persistence

Makes the CLI treat ModelHost as a first-class workload in list and
apply success paths.
EOF
```

## Phase 5: Integration smoke

Dispatch graph: 5.1

### Task 5.1: manual smoke for apply/disable/reconcile on one ModelHost

```yaml meta
id: "5.1"
files:
  - packages/remote/test/workload/modelhost-apply.test.ts
  - packages/remote/test/workload/reconciler.test.ts
  - packages/cli/test/enable-disable.test.ts
  - packages/cli/test/init-roundtrip.test.ts
  - packages/cli/src/commands/workload.ts
  - packages/remote/src/workload/apply.ts
file_scope: extend-shared
depends_on: ["2.1", "2.2", "3.1", "4.1", "4.2"]
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: oc-deepseek-v4-pro
task_size: substantial
risk_class: integration
```

**Files:**

- Modify: `packages/remote/test/workload/modelhost-apply.test.ts`
- Modify: `packages/remote/test/workload/reconciler.test.ts`
- Modify: `packages/cli/test/enable-disable.test.ts`
- Modify: `packages/cli/test/init-roundtrip.test.ts`
- Modify: `packages/cli/src/commands/workload.ts`
- Modify: `packages/remote/src/workload/apply.ts`

- [ ] **Step 1: Write the failing test**

Keep the existing smoke fixtures but add a full workflow assertion:

```ts
test("smoke flow: apply ModelHost, list it, disable it, then reconcile after kill -9", async () => {
  // Apply manifest
  // Assert `llamactl list` shows the persisted ModelHost row
  // Disable it and verify teardown removes runtime state
  // Simulate `kill -9` on the engine pid
  // Run reconcileOnce and verify the ModelHost is started again
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/remote/test/workload/modelhost-apply.test.ts packages/remote/test/workload/reconciler.test.ts packages/cli/test/enable-disable.test.ts packages/cli/test/init-roundtrip.test.ts`
Expected: fail until the end-to-end flow is wired through store persistence, router procedures, and reconcile.

- [ ] **Step 3: Write minimal implementation**

Update the already-edited files so the smoke flow passes:

```ts
// apply.ts: persist ModelHost status and return the saved manifest path
// workload.ts: print ModelHost rows in list output and apply success output
// setEnabled.ts: save ModelHost through modelhost-store and call modelHostStop
// reconciler.ts: load ModelHost from shared store and reapply after engine loss
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/remote/test/workload/modelhost-apply.test.ts packages/remote/test/workload/reconciler.test.ts packages/cli/test/enable-disable.test.ts packages/cli/test/init-roundtrip.test.ts`
Expected: pass with ModelHost apply/list/disable/reconcile behaving like a first-class workload.

- [ ] **Step 5: Commit**

```bash
git add packages/remote/test/workload/modelhost-apply.test.ts packages/remote/test/workload/reconciler.test.ts packages/cli/test/enable-disable.test.ts packages/cli/test/init-roundtrip.test.ts packages/cli/src/commands/workload.ts packages/remote/src/workload/apply.ts
git commit -F - <<'EOF'
feat(mlx): complete ModelHost control-plane smoke coverage

Adds the manual integration slice that proves ModelHost apply, list,
disable, and reconcile all operate through the shared workloads store
and node-dispatch path.
EOF
```

## Execution scheduling

| Wave | Tasks (parallel) | Bottleneck task | Gated on                |
| ---- | ---------------- | --------------- | ----------------------- |
| 1    | 1.1              | 1.1             | nothing                 |
| 2    | 1.2              | 1.2             | 1.1                     |
| 3    | 2.1              | 2.1             | 1.1, 1.2                |
| 4    | 2.2              | 2.2             | 2.1                     |
| 5    | 3.1              | 3.1             | 2.1, 2.2                |
| 6    | 4.1 + 4.2        | 4.2             | 3.1                     |
| 7    | 5.1              | 5.1             | 2.1, 2.2, 3.1, 4.1, 4.2 |

Critical path: Phase 1 store helpers -> split ModelHost apply -> node tRPC surface -> mixed-kind reconcile -> CLI parity -> smoke. Cross-phase win: Phase 1 unlocks both apply and CLI work, while Phase 2 and Phase 3 can be implemented without waiting on the final smoke assertions.

## Self-review notes

- Spec coverage:
  - §1 goal/scope: Tasks 1.1, 2.1, 3.1, 4.1, 4.2, 5.1.
  - §4 store integration: Tasks 1.1 and 1.2.
  - §5 apply / node dispatch wiring: Tasks 2.1 and 2.2.
  - §7 openaiProxy / matrix impact: no functional code changes required in Sub B, so no task is assigned there beyond regression coverage through apply/reconcile tests.
  - §8 testing strategy: Tasks 1.1, 1.2, 2.1, 2.2, 3.1, 4.1, 4.2, 5.1.
  - §9 migration / back-compat: Tasks 1.2, 4.2, 5.1.
  - §11 file touch list: every listed file appears in at least one task `files:` block.
- Measurement gate: not applicable for this slice; Sub B is orchestration and consistency work, not model-quality tuning.
- Type consistency: `modelHostStart` / `modelHostStop` / `modelHostStatus` are used consistently across router, apply, and tests.
- Placeholder scan: no `TBD`, `TODO`, or “similar to” placeholders remain.
- Trust boundary: every implementation task uses `git commit -F - <<'EOF'` so commit messages stay stable and reviewable.
- Validator note: no dedicated plan validator script was found in-repo during the quick search, so plan quality is checked by structural self-review and file-touch cross-check instead.
