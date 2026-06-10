# Fleet Supervisor — Cross-Node Workload Stability + Adaptability

**Spec**: `docs/superpowers/specs/2026-05-22-fleet-supervisor-spec.md`  
**Date**: 2026-05-22  
**Scope**: L1 (observability) + L5 (predictive admission) as shippable week-1 slice; L2 (reactive ops) in week 2. L3/L4 deferred.

## Phasing rationale

L5 (predictive admission) ships **before** the full L1 loop because it closes the most acute
2026-05-22 incident (capacity-blind `llamactl enable` OOM-killing siblings) and it only needs
one shared building block from L1 (the node-mem probe). Everything else is a pure function
and a CLI gate.

Order: **Phase 1** (types + node-mem + journal) → **Phase 2** (L5 admission) → **Phase 3**
(L1 workload probe + supervisor loop) → **Phase 4** (L2 policy engine + proposals) →
**Phase 5** (CLI surface).

## Package boundary

New subdirectory `packages/agents/src/fleet-supervisor/` mirrors `packages/agents/src/healer/`.
No new top-level package for v1. CLI commands land in `packages/cli/src/commands/supervisor.ts`
and `packages/cli/src/commands/admit.ts`.

## Design decisions (resolved for plan execution)

| Question                  | Decision                                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pressure threshold        | Dual-condition: `free_mb < 400 AND compressor_mb > 2000` for N consecutive ticks. Single-threshold misfire rate too high on macOS under normal compressor activity. |
| Request/error rate source | `/health` probe failure counts as error in the rolling window. No log-tailing or proxy instrumentation for v1 (coupling cost too high).                             |
| Eviction tie-break        | Priority asc → RSS desc (highest consumer on a priority tie).                                                                                                       |
| mcr reshape               | Propose-only restart with new args. No live-config for v1.                                                                                                          |
| Admission overhead        | 1.25× `expectedMemoryGiB` configurable via `--overhead-factor`.                                                                                                     |
| Supervisor stall          | Heartbeat journal entry every tick; missing heartbeat = detectable stall.                                                                                           |

---

## Phase 1 — Types + Node-Memory Probe + Journal

Dispatch graph: 1.1 ∥ 1.2 → 1.3

### Task 1.1 — Fleet snapshot + config types

```yaml meta
id: 1.1
files:
  - packages/agents/src/fleet-supervisor/types.ts
file_scope: new
depends_on: []
parallel_with: [1.2]
preferred_agent: gemini-acp-pro
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

**Failing test** — `packages/agents/test/fleet-supervisor-types.test.ts`:

```ts
// test: FleetSnapshotSchema_roundtrips_valid_snapshot
import { FleetSnapshotSchema, SupervisorConfigSchema } from "../src/fleet-supervisor/types.js";

const snap = {
  ts: "2026-05-22T17:00:00Z",
  kind: "fleet-snapshot",
  node: "local",
  node_mem: { free_mb: 122, compressor_mb: 4045, active_mb: 912, inactive_mb: 839, wired_mb: 320 },
  workloads: [
    {
      name: "gains-host-35b-local",
      kind: "ModelHost",
      endpoint: "http://127.0.0.1:8096",
      rss_mb: null,
      request_rate_5m: 2.3,
      error_rate_5m: 0,
      p50_ms: 240,
      p95_ms: 480,
      models: ["Qwen3.6-35B-A3B-4bit"],
      reachable: true,
      health: "healthy",
    },
  ],
};
expect(() => FleetSnapshotSchema.parse(snap)).not.toThrow();
expect(() => SupervisorConfigSchema.parse({})).not.toThrow(); // defaults only
```

Import fails (file does not exist) → red.

**Implementation**: `packages/agents/src/fleet-supervisor/types.ts`

- `NodeMemSnapshotSchema` — `z.object({ free_mb, compressor_mb, active_mb, inactive_mb, wired_mb })`
  all `z.number()`.
- `WorkloadHealthState` — `z.enum(['healthy', 'degraded', 'unreachable'])`.
- `WorkloadSnapshotSchema` — name, kind (`ModelHost|ModelRun`), endpoint, `rss_mb: z.number().nullable()`,
  request_rate_5m, error_rate_5m, p50_ms, p95_ms, models, reachable, health.
- `FleetSnapshotSchema` — ts, `kind: z.literal('fleet-snapshot')`, node, node_mem, workloads.
- `FleetHeartbeatEntrySchema` — kind `'fleet-heartbeat'`, ts, node, tick number.
- `FleetTransitionEntrySchema` — kind `'fleet-transition'`, ts, node, workloadName (optional),
  subject (`'node'|'workload'`), from, to.
- `FleetProposalActionSchema` — `z.discriminatedUnion('type', [...])` covering
  `evict` (workloadName, tier 3), `restart` (workloadName, tier 3), `mark_degraded` (tier 2).
- `FleetProposalEntrySchema` — kind `'fleet-proposal'`, ts, node, action, reasoning, proposalId.
- `FleetErrorEntrySchema` — kind `'fleet-error'`, ts, node, message.
- `FleetJournalEntrySchema` — discriminated union of all entry schemas.
- `SupervisorConfigSchema` — all optional with defaults:
  `pressure_high_free_mb: 400`, `pressure_high_compressor_mb: 2000`,
  `pressure_consecutive_ticks: 3`, `p95_degraded_ms: 3000`,
  `error_rate_degraded: 0.1`, `degradation_consecutive_ticks: 3`,
  `headroom_min_mb: 400`, `admission_overhead_factor: 1.25`,
  `interval_ms: 60_000`.
- Export all inferred types.

**Verify**: `cd packages/agents && bun test test/fleet-supervisor-types.test.ts`

---

### Task 1.2 — macOS node-memory probe

```yaml meta
id: 1.2
files:
  - packages/agents/src/fleet-supervisor/node-mem.ts
file_scope: new
depends_on: []
parallel_with: [1.1]
preferred_agent: gemini-acp-pro
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

**Failing test** — `packages/agents/test/fleet-supervisor-node-mem.test.ts`:

```ts
// test: parseVmStat_converts_pages_to_mb_correctly
import { parseVmStat } from "../src/fleet-supervisor/node-mem.js";
const fakeOutput = `Pages free:                             500.
Pages active:                          1000.
Pages inactive:                         800.
Pages wired down:                       320.
Pages occupied by compressor:          4000.
`;
const result = parseVmStat(fakeOutput, 4096);
// 500 pages * 4096 bytes / 1024^2 = 1.953 MB
expect(result.free_mb).toBeCloseTo((500 * 4096) / 1024 / 1024, 1);
expect(result.compressor_mb).toBeCloseTo((4000 * 4096) / 1024 / 1024, 1);
expect(result.active_mb).toBeCloseTo((1000 * 4096) / 1024 / 1024, 1);

// test: readNodeMem_returns_zeros_on_non_darwin
import { readNodeMem } from "../src/fleet-supervisor/node-mem.js";
// pass fake exec that throws to simulate non-darwin / vm_stat missing
const fakeExec = () => Promise.reject(new Error("command not found"));
const fallback = await readNodeMem({ exec: fakeExec, warnOnFallback: false });
expect(fallback.free_mb).toBe(0);
```

Import fails → red.

**Implementation**: `packages/agents/src/fleet-supervisor/node-mem.ts`

- `parseVmStat(output: string, pageBytes: number): NodeMemSnapshot` — regex-match
  `Pages <label>:\s+(\d+)\.` lines. Label → field map:
  `free→free_mb`, `active→active_mb`, `inactive→inactive_mb`,
  `wired down→wired_mb`, `occupied by compressor→compressor_mb`.
  Convert: `pages * pageBytes / (1024 * 1024)`.
- `readNodeMem(opts?: { exec?: (cmd: string) => Promise<string>; warnOnFallback?: boolean }): Promise<NodeMemSnapshot>` —
  runs `vm_stat` then `pagesize` via `exec` (defaults to `child_process.execFile`).
  On any error: if `warnOnFallback !== false`, writes one stderr line; returns zero-filled snapshot.

**Verify**: `cd packages/agents && bun test test/fleet-supervisor-node-mem.test.ts`

---

### Task 1.3 — Fleet journal writer

```yaml meta
id: 1.3
files:
  - packages/agents/src/fleet-supervisor/journal.ts
file_scope: new
depends_on: [1.1, 1.2]
parallel_with: []
preferred_agent: gemini-acp-pro
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

**Failing test** — `packages/agents/test/fleet-supervisor-journal.test.ts`:

```ts
// test: appendFleetJournal_writes_parseable_jsonl
import { appendFleetJournal, defaultFleetJournalPath } from "../src/fleet-supervisor/journal.js";
import { readFileSync } from "node:fs";
const tmpPath = `/tmp/fleet-test-${Date.now()}.jsonl`;
const entry = {
  kind: "fleet-heartbeat" as const,
  ts: new Date().toISOString(),
  node: "local",
  tick: 1,
};
appendFleetJournal(entry, tmpPath);
const line = readFileSync(tmpPath, "utf8").trim();
expect(JSON.parse(line)).toMatchObject({ kind: "fleet-heartbeat", node: "local", tick: 1 });

// test: defaultFleetJournalPath_uses_home_llamactl
const p = defaultFleetJournalPath({});
expect(p).toContain(".llamactl/fleet-supervisor/journal.jsonl");
```

**Implementation**: mirrors `packages/agents/src/healer/journal.ts`:

- `defaultFleetJournalPath(env = process.env): string` →
  `${DEV_STORAGE || ~/.llamactl}/fleet-supervisor/journal.jsonl`.
- `appendFleetJournal(entry: FleetJournalEntry, path?: string): void` →
  `mkdirSync(dirname(path), { recursive: true }); appendFileSync(path, JSON.stringify(entry) + '\n', 'utf8')`.

**Verify**: `cd packages/agents && bun test test/fleet-supervisor-journal.test.ts`

**Integration**: Phase 1 delivers the type contract, node-mem probe, and journal sink.
No daemon restart. `bun test packages/agents` must stay green.

---

## Phase 2 — Predictive Admission (L5)

Dispatch graph: 2.1 → 2.2 → 2.3 ∥ 2.4

### Task 2.1 — Schema: `spec.priority` + `spec.expectedMemoryGiB`

```yaml meta
id: 2.1
files:
  - packages/remote/src/workload/noderun-schema.ts
file_scope: modify-existing
depends_on: [1.1]
parallel_with: []
preferred_agent: gemini-acp-pro
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: schema-aware
```

**Failing test** — extend `packages/remote/test/noderun-schema.test.ts` (or create if absent):

```ts
// test: NodeRunSchema_accepts_priority_and_expectedMemoryGiB
// Build a minimal valid NodeRun YAML object, add spec.priority + spec.expectedMemoryGiB.
const manifest = { /* valid base */ spec: { ...baseSpec, priority: 50, expectedMemoryGiB: 24.5 } };
expect(() => NodeRunSchema.parse(manifest)).not.toThrow();
const parsed = NodeRunSchema.parse(manifest);
expect(parsed.spec.priority).toBe(50);
expect(parsed.spec.expectedMemoryGiB).toBeCloseTo(24.5);

// test: NodeRunSchema_still_accepts_manifest_without_new_fields
expect(() => NodeRunSchema.parse(baseManifest)).not.toThrow();
expect(NodeRunSchema.parse(baseManifest).spec.priority).toBe(50); // default
```

`spec.priority` doesn't exist on the schema yet → parse either strips or errors.

**Implementation**: in `packages/remote/src/workload/noderun-schema.ts`, inside the `spec` object schema add:

```ts
priority: z.number().int().min(0).max(100).default(50),
expectedMemoryGiB: z.number().positive().optional(),
```

No existing manifests break — both fields are optional/defaulted.

**Verify**: `cd packages/remote && bun test` (all existing tests pass, new assertions green)

---

### Task 2.2 — `admitWorkload()` pure function

```yaml meta
id: 2.2
files:
  - packages/agents/src/fleet-supervisor/admission.ts
file_scope: new
depends_on: [2.1, 1.1]
parallel_with: []
preferred_agent: gemini-acp-pro
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

**Failing test** — `packages/agents/test/fleet-supervisor-admission.test.ts`:

```ts
// test: admitWorkload_rejects_when_projected_free_below_headroom
import { admitWorkload } from "../src/fleet-supervisor/admission.js";
// projected = 500 - (1.0 * 1024 * 1.25) = -780 < headroom 400
const r = admitWorkload({
  currentFreeMb: 500,
  expectedGiB: 1.0,
  overheadFactor: 1.25,
  headroomMinMb: 400,
});
expect(r.ok).toBe(false);
expect(r.reason).toMatch(/insufficient memory/i);
expect(r.projectedFreeMb).toBeCloseTo(-780, 0);

// test: admitWorkload_accepts_when_projected_above_headroom
// projected = 8000 - (2.0 * 1024 * 1.25) = 8000 - 2560 = 5440 > 400
const ok = admitWorkload({
  currentFreeMb: 8000,
  expectedGiB: 2.0,
  overheadFactor: 1.25,
  headroomMinMb: 400,
});
expect(ok.ok).toBe(true);
expect(ok.projectedFreeMb).toBeCloseTo(5440, 0);

// test: admitWorkload_skips_check_when_expectedGiB_undefined
const skip = admitWorkload({
  currentFreeMb: 10,
  expectedGiB: undefined,
  overheadFactor: 1.25,
  headroomMinMb: 400,
});
expect(skip.ok).toBe(true);
expect(skip.skipped).toBe(true);
```

**Implementation**: `packages/agents/src/fleet-supervisor/admission.ts`

```ts
export interface AdmitOptions {
  currentFreeMb: number;
  expectedGiB: number | undefined;
  overheadFactor: number;
  headroomMinMb: number;
}
export interface AdmitResult {
  ok: boolean;
  projectedFreeMb?: number;
  skipped?: boolean;
  reason?: string;
}
export function admitWorkload(opts: AdmitOptions): AdmitResult {
  if (opts.expectedGiB === undefined) return { ok: true, skipped: true };
  const requiredMb = opts.expectedGiB * 1024 * opts.overheadFactor;
  const projectedFreeMb = opts.currentFreeMb - requiredMb;
  if (projectedFreeMb < opts.headroomMinMb) {
    return {
      ok: false,
      projectedFreeMb,
      reason: `insufficient memory: projected free ${projectedFreeMb.toFixed(0)} MB < headroom ${opts.headroomMinMb} MB`,
    };
  }
  return { ok: true, projectedFreeMb };
}
```

**Verify**: `cd packages/agents && bun test test/fleet-supervisor-admission.test.ts`

---

### Task 2.3 — Wire pre-flight into `llamactl enable`

```yaml meta
id: 2.3
files:
  - packages/cli/src/commands/noderun-helpers.ts
file_scope: modify-existing
depends_on: [2.2]
parallel_with: [2.4]
preferred_agent: gemini-acp-pro
fallback_agent: claude-acp-sonnet
task_size: substantial
risk_class: schema-aware
```

**Failing test** — `packages/cli/test/noderun-helpers-admission.test.ts`:

```ts
// test: enable_throws_when_admission_fails
// Stub readNodeMem to return { free_mb: 100, ... }
// Load a workload with spec.expectedMemoryGiB = 24 (granite-26B class)
// Expect enableWorkload() (or equivalent) to throw with /insufficient memory/
import { enableWorkload } from "../src/commands/noderun-helpers.js"; // adjust to real export
await expect(
  enableWorkload("some-26b-workload", {
    readNodeMem: async () => ({
      free_mb: 100,
      compressor_mb: 5000,
      active_mb: 200,
      inactive_mb: 100,
      wired_mb: 100,
    }),
  }),
).rejects.toThrow(/insufficient memory/);

// test: enable_succeeds_when_expectedMemoryGiB_not_set
// Workload without expectedMemoryGiB → admission skipped, no throw
```

**Implementation**: in the enable path of `packages/cli/src/commands/noderun-helpers.ts`:

1. Load the manifest to get `spec.expectedMemoryGiB` and `spec.priority`.
2. If `expectedMemoryGiB` is set, call `readNodeMem()` (or injectable override) and `admitWorkload()`.
3. On `admit.ok === false`: throw `new Error(admit.reason)`. CLI surfaces this as a fatal error with
   the message (no stack trace in production output).
4. On success: log `[supervisor] projected free: ${projectedFreeMb.toFixed(0)} MB` at debug level.
5. Accept an optional `opts.readNodeMem` for test injection.

**Verify**:

```
cd packages/cli && bun test test/noderun-helpers-admission.test.ts
cd packages/cli && bun test   # full suite — no regressions
```

---

### Task 2.4 — `llamactl admit <workload>` dry-run command

```yaml meta
id: 2.4
files:
  - packages/cli/src/commands/admit.ts
file_scope: new
depends_on: [2.2]
parallel_with: [2.3]
preferred_agent: gemini-acp-pro
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

**Failing test** — `packages/cli/test/admit.test.ts`:

```ts
// test: admit_command_prints_ok_and_projected_free_when_sufficient
// Fake readNodeMem returning free_mb: 8000
// Run admit logic with workload manifest expectedMemoryGiB: 2.0
// Expect output to contain 'ok' and '5440'

// test: admit_command_prints_reject_reason_when_insufficient
// Fake readNodeMem returning free_mb: 100
// Expect output to contain 'insufficient memory' and exit non-zero
```

**Implementation**: `packages/cli/src/commands/admit.ts`

- Positional arg: `<workload-name>`.
- Options: `--node=local|macmini` (default local), `--overhead-factor=1.25`,
  `--headroom-min-mb=400`.
- Load workload YAML, extract `spec.expectedMemoryGiB`; if not set, print
  `"no expectedMemoryGiB on spec — nothing to check"` and exit 0.
- Call `readNodeMem()` → `admitWorkload()`.
- Print a two-row table: `status | projected_free_mb | required_mb | headroom_min_mb`.
- Exit code 1 on reject, 0 on accept.
- Register in CLI entry point.

**Verify**: `cd packages/cli && bun test test/admit.test.ts`  
Manual: `llamactl admit gains-host-35b-local`

**Integration**: Phase 2 closes the capacity-blind admission gap. `llamactl enable` now rejects
workloads that would push free memory below headroom. `llamactl admit` is a dry-run planning tool.
Daemon restart not required.

---

## Phase 3 — Workload Probe + Supervisor Loop (L1)

Dispatch graph: 3.1 ∥ 3.2 → 3.3 → 3.4

### Task 3.1 — Per-workload HTTP prober

```yaml meta
id: 3.1
files:
  - packages/agents/src/fleet-supervisor/workload-probe.ts
file_scope: new
depends_on: [1.1]
parallel_with: [3.2]
preferred_agent: gemini-acp-pro
fallback_agent: claude-acp-sonnet
task_size: substantial
risk_class: paste-ready
```

**Failing test** — `packages/agents/test/fleet-supervisor-probe.test.ts`:

```ts
// test: probeWorkload_marks_unreachable_on_fetch_error
import { probeWorkload } from "../src/fleet-supervisor/workload-probe.js";
const result = await probeWorkload({
  name: "w1",
  endpoint: "http://127.0.0.1:9999",
  kind: "ModelHost",
  fetch: () => Promise.reject(new Error("ECONNREFUSED")),
  now: () => 0,
  timeoutMs: 100,
});
expect(result.reachable).toBe(false);
expect(result.health).toBe("unreachable");
expect(result.p50_ms).toBe(0);

// test: probeWorkload_returns_healthy_with_models_on_200
const fakeFetch = async (url: string) => {
  if (url.includes("/health")) return new Response("ok", { status: 200 });
  if (url.includes("/v1/models"))
    return new Response(JSON.stringify({ data: [{ id: "Qwen3.6-35B-A3B-4bit" }] }), {
      status: 200,
    });
  return new Response("", { status: 404 });
};
let t = 0;
const r = await probeWorkload({
  name: "w1",
  endpoint: "http://127.0.0.1:8096",
  kind: "ModelHost",
  fetch: fakeFetch,
  now: () => (t += 50),
  timeoutMs: 1000,
});
expect(r.reachable).toBe(true);
expect(r.health).toBe("healthy");
expect(r.models).toContain("Qwen3.6-35B-A3B-4bit");
expect(r.latency_ms).toBeGreaterThan(0);
```

**Implementation**: `packages/agents/src/fleet-supervisor/workload-probe.ts`

```ts
export interface WorkloadTarget {
  name: string;
  kind: "ModelHost" | "ModelRun";
  endpoint: string;
  pid?: number;
}
export interface WorkloadProbeResult extends WorkloadTarget {
  reachable: boolean;
  health: WorkloadHealthState;
  latency_ms: number;
  models: string[];
  rss_mb: number | null;
}
export interface WorkloadProbeOptions extends WorkloadTarget {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  timeoutMs?: number;
  exec?: (cmd: string) => Promise<string>;
}
```

- `probeWorkload(opts): Promise<WorkloadProbeResult>` — fires `/health` (timed) and `/v1/models`
  concurrently with AbortController timeout. Latency from `/health` only.
  On any fetch throw → `reachable: false, health: 'unreachable', latency_ms: 0, models: []`.
  On `/health` non-200 → `reachable: true, health: 'degraded'`.
  RSS: `ps -o rss= -p <pid>` via exec if `pid` provided; null otherwise.
- `probeFleetWorkloads(targets: WorkloadTarget[], opts): Promise<WorkloadProbeResult[]>` —
  `Promise.all` fan-out.

**Verify**: `cd packages/agents && bun test test/fleet-supervisor-probe.test.ts`

---

### Task 3.2 — Latency + error-rate ring buffer

```yaml meta
id: 3.2
files:
  - packages/agents/src/fleet-supervisor/ring-buffer.ts
file_scope: new
depends_on: [1.1]
parallel_with: [3.1]
preferred_agent: gemini-acp-pro
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

**Failing test** — `packages/agents/test/fleet-supervisor-ring-buffer.test.ts`:

```ts
// test: RingBuffer_percentile_p95_of_ten_items
import { RingBuffer } from "../src/fleet-supervisor/ring-buffer.js";
const rb = new RingBuffer<number>(10);
for (let i = 1; i <= 10; i++) rb.push(i * 100); // 100..1000
// nearest-rank p95: ceil(0.95 * 10) = 10 → sorted[9] = 1000
expect(rb.percentile(0.95)).toBe(1000);

// test: RingBuffer_overwrites_oldest_at_capacity
const small = new RingBuffer<number>(3);
[1, 2, 3, 4].forEach((v) => small.push(v));
expect(small.values()).toEqual([2, 3, 4]);

// test: RingBuffer_sma_returns_mean
const rb2 = new RingBuffer<number>(4);
[10, 20, 30, 40].forEach((v) => rb2.push(v));
expect(rb2.sma()).toBe(25);
```

**Implementation**: `packages/agents/src/fleet-supervisor/ring-buffer.ts`

```ts
export class RingBuffer<T> {
  private buf: Array<T | undefined>;
  private head = 0;
  private count = 0;
  constructor(public readonly capacity: number) {
    this.buf = new Array(capacity);
  }
  push(v: T): void {
    this.buf[this.head] = v;
    this.head = (this.head + 1) % this.capacity;
    this.count = Math.min(this.count + 1, this.capacity);
  }
  values(): T[] {
    /* oldest-first reconstruction */
  }
  get size(): number {
    return this.count;
  }
  percentile(p: number): number {
    /* nearest-rank on sorted values() cast to number */
  }
  sma(): number {
    /* sum / count */
  }
}
```

**Verify**: `cd packages/agents && bun test test/fleet-supervisor-ring-buffer.test.ts`

---

### Task 3.3 — Snapshot assembler

```yaml meta
id: 3.3
files:
  - packages/agents/src/fleet-supervisor/snapshot.ts
file_scope: new
depends_on: [3.1, 3.2, 1.1, 1.2]
parallel_with: []
preferred_agent: gemini-acp-pro
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

**Failing test** — `packages/agents/test/fleet-supervisor-snapshot.test.ts`:

```ts
// test: assembleSnapshot_produces_valid_FleetSnapshot
import { assembleSnapshot } from "../src/fleet-supervisor/snapshot.js";
const nodeMem = {
  free_mb: 500,
  compressor_mb: 1000,
  active_mb: 800,
  inactive_mb: 300,
  wired_mb: 200,
};
const probes = [
  {
    name: "w1",
    kind: "ModelHost" as const,
    endpoint: "http://127.0.0.1:8096",
    reachable: true,
    health: "healthy" as const,
    latency_ms: 200,
    models: ["M1"],
    rss_mb: null,
    p50_ms: 0,
    p95_ms: 0,
    request_rate_5m: 0,
    error_rate_5m: 0,
  },
];
const snap = assembleSnapshot({
  node: "local",
  nodeMem,
  probes,
  latencyRings: new Map(),
  errorRings: new Map(),
  ts: "2026-05-22T17:00:00Z",
});
expect(snap.kind).toBe("fleet-snapshot");
expect(snap.node_mem.free_mb).toBe(500);
expect(snap.workloads[0].name).toBe("w1");
// p50/p95 from empty rings = 0
expect(snap.workloads[0].p95_ms).toBe(0);
```

**Implementation**: `packages/agents/src/fleet-supervisor/snapshot.ts`

- `assembleSnapshot(opts: { node, nodeMem, probes, latencyRings: Map<string, RingBuffer<number>>, errorRings: Map<string, RingBuffer<number>>, ts }): FleetSnapshot`
- For each probe result: push `probe.latency_ms` into `latencyRings.get(name)` (create if absent,
  capacity matches `degradation_consecutive_ticks * 2`), compute p50/p95 from ring.
- Push `probe.error_rate_5m` into `errorRings.get(name)`.
- Build workload snapshot merging probe + ring stats.
- Validate via `FleetSnapshotSchema.parse()` and return.

**Verify**: `cd packages/agents && bun test test/fleet-supervisor-snapshot.test.ts`

---

### Task 3.4 — Supervisor tick loop

```yaml meta
id: 3.4
files:
  - packages/agents/src/fleet-supervisor/loop.ts
  - packages/agents/src/fleet-supervisor/config.ts
  - packages/agents/src/fleet-supervisor/index.ts
file_scope: new
depends_on: [3.3, 1.3]
parallel_with: []
preferred_agent: gemini-acp-pro
fallback_agent: claude-acp-sonnet
task_size: substantial
risk_class: paste-ready
```

**Failing test** — `packages/agents/test/fleet-supervisor-loop.test.ts`:

```ts
// test: startSupervisorLoop_once_journals_snapshot_and_heartbeat
import { startSupervisorLoop } from "../src/fleet-supervisor/loop.js";
const entries: unknown[] = [];
const handle = startSupervisorLoop({
  node: "local",
  once: true,
  workloadTargets: [{ name: "w1", endpoint: "http://127.0.0.1:9999", kind: "ModelHost" }],
  readNodeMem: async () => ({
    free_mb: 500,
    compressor_mb: 100,
    active_mb: 200,
    inactive_mb: 100,
    wired_mb: 100,
  }),
  probeFetch: () => Promise.reject(new Error("offline")),
  writeJournal: (e) => entries.push(e),
});
await handle.done;
expect(entries.some((e) => (e as any).kind === "fleet-snapshot")).toBe(true);
expect(entries.some((e) => (e as any).kind === "fleet-heartbeat")).toBe(true);

// test: startSupervisorLoop_stop_halts_before_next_tick
const looping = startSupervisorLoop({ node: "local", intervalMs: 10_000 /* ... */ });
looping.stop();
await looping.done;
// done resolves without running a second tick
```

**Implementation**:

`packages/agents/src/fleet-supervisor/config.ts`:

- `defaultSupervisorConfig(): SupervisorConfig` — returns `SupervisorConfigSchema.parse({})`.

`packages/agents/src/fleet-supervisor/loop.ts`:

- `SupervisorLoopOptions`: node, workloadTargets, intervalMs, once, journalPath, writeJournal,
  readNodeMem (injectable), probeFetch (injectable `typeof fetch`), onSnapshot, config.
- `SupervisorLoopHandle`: `{ stop(): void; done: Promise<void> }`.
- `startSupervisorLoop(opts): SupervisorLoopHandle` — mirrors `startHealerLoop` shape:
  - Maintains `latencyRings` and `errorRings` Maps in closure.
  - Each tick: `readNodeMem` → `probeFleetWorkloads` → `assembleSnapshot` →
    `writeJournal(snapshot)` → `writeJournal(heartbeat)`.
  - Heartbeat: `{ kind: 'fleet-heartbeat', ts, node, tick: counter++ }`.
  - On any error: write `fleet-error` entry and continue (never crash the loop).
  - `opts.onSnapshot?.(snapshot)` called after each tick.

`packages/agents/src/fleet-supervisor/index.ts` — re-exports all public symbols from
types, node-mem, admission, journal, workload-probe, ring-buffer, snapshot, loop, config.

**Verify**: `cd packages/agents && bun test test/fleet-supervisor-loop.test.ts`

**Integration**: Phase 3 delivers full L1 observability. The journal accumulates per-tick
snapshots at `~/.llamactl/fleet-supervisor/journal.jsonl`. No daemon restart required.
Full agents test suite: `cd packages/agents && bun test`.

---

## Phase 4 — Policy Engine + Proposals (L2)

Dispatch graph: 4.1 ∥ 4.2 → 4.3 → 4.4

### Task 4.1 — Pressure + degradation classifiers

```yaml meta
id: 4.1
files:
  - packages/agents/src/fleet-supervisor/policy.ts
file_scope: new
depends_on: [3.2, 1.1]
parallel_with: [4.2]
preferred_agent: gemini-acp-pro
fallback_agent: claude-acp-sonnet
task_size: substantial
risk_class: paste-ready
```

**Failing test** — `packages/agents/test/fleet-supervisor-policy.test.ts`:

```ts
// test: PressureClassifier_emits_HIGH_after_n_consecutive_ticks_dual_condition
import { PressureClassifier, DegradationClassifier } from "../src/fleet-supervisor/policy.js";
const cfg = { freeThresholdMb: 400, compressorThresholdMb: 2000, consecutiveTicks: 3 };
const clf = new PressureClassifier(cfg);
const badMem = {
  free_mb: 30,
  compressor_mb: 5000,
  active_mb: 200,
  inactive_mb: 100,
  wired_mb: 100,
};
expect(clf.ingest(badMem).level).toBe("NORMAL"); // tick 1
expect(clf.ingest(badMem).level).toBe("NORMAL"); // tick 2
expect(clf.ingest(badMem).level).toBe("HIGH"); // tick 3
// recovery — resets immediately
const goodMem = {
  free_mb: 2000,
  compressor_mb: 50,
  active_mb: 500,
  inactive_mb: 200,
  wired_mb: 100,
};
expect(clf.ingest(goodMem).level).toBe("NORMAL");

// test: PressureClassifier_stays_NORMAL_when_only_one_threshold_breached
const clf2 = new PressureClassifier(cfg);
const halfBad = { free_mb: 30, compressor_mb: 50, ...rest }; // low free, low compressor
for (let i = 0; i < 3; i++) expect(clf2.ingest(halfBad).level).toBe("NORMAL");

// test: DegradationClassifier_marks_degraded_when_p95_exceeds_threshold
const dc = new DegradationClassifier({ p95ThresholdMs: 3000, consecutiveTicks: 3 });
const ws = {
  name: "w1",
  p95_ms: 5000,
  error_rate_5m: 0,
  reachable: true,
  health: "healthy" as const,
};
expect(dc.ingest(ws).state).toBe("healthy"); // tick 1
expect(dc.ingest(ws).state).toBe("healthy"); // tick 2
expect(dc.ingest(ws).state).toBe("degraded"); // tick 3

// test: DegradationClassifier_marks_unreachable_immediately
const dc2 = new DegradationClassifier({ p95ThresholdMs: 3000, consecutiveTicks: 3 });
expect(dc2.ingest({ ...ws, reachable: false, health: "unreachable" }).state).toBe("unreachable");
```

**Implementation**: `packages/agents/src/fleet-supervisor/policy.ts`

```ts
export type PressureLevel = "NORMAL" | "HIGH";

export class PressureClassifier {
  private count = 0;
  constructor(
    private cfg: {
      freeThresholdMb: number;
      compressorThresholdMb: number;
      consecutiveTicks: number;
    },
  ) {}
  ingest(mem: NodeMemSnapshot): { level: PressureLevel; consecutiveCount: number } {
    const breached =
      mem.free_mb < this.cfg.freeThresholdMb && mem.compressor_mb > this.cfg.compressorThresholdMb;
    this.count = breached ? this.count + 1 : 0;
    return {
      level: this.count >= this.cfg.consecutiveTicks ? "HIGH" : "NORMAL",
      consecutiveCount: this.count,
    };
  }
}

export class DegradationClassifier {
  private count = 0;
  constructor(private cfg: { p95ThresholdMs: number; consecutiveTicks: number }) {}
  ingest(ws: {
    reachable: boolean;
    health: WorkloadHealthState;
    p95_ms: number;
    error_rate_5m: number;
  }): { state: WorkloadHealthState; reason?: string } {
    if (!ws.reachable) {
      this.count = 0;
      return { state: "unreachable" };
    }
    const slow = ws.p95_ms > this.cfg.p95ThresholdMs;
    this.count = slow ? this.count + 1 : 0;
    if (this.count >= this.cfg.consecutiveTicks)
      return { state: "degraded", reason: `p95 ${ws.p95_ms}ms > ${this.cfg.p95ThresholdMs}ms` };
    return { state: "healthy" };
  }
}
```

**Verify**: `cd packages/agents && bun test test/fleet-supervisor-policy.test.ts`

---

### Task 4.2 — Proposal builder + eviction policy

```yaml meta
id: 4.2
files:
  - packages/agents/src/fleet-supervisor/proposals.ts
file_scope: new
depends_on: [1.1]
parallel_with: [4.1]
preferred_agent: gemini-acp-pro
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

**Failing test** — `packages/agents/test/fleet-supervisor-proposals.test.ts`:

```ts
// test: pickEvictionTarget_returns_lowest_priority_workload
import {
  pickEvictionTarget,
  buildEvictionProposal,
  buildRestartProposal,
} from "../src/fleet-supervisor/proposals.js";
const ws = [
  { name: "w1", priority: 80, rss_mb: 10000 },
  { name: "w2", priority: 20, rss_mb: 5000 }, // evict first (lowest priority)
  { name: "w3", priority: 50, rss_mb: 8000 },
];
expect(pickEvictionTarget(ws)).toBe("w2");

// test: pickEvictionTarget_breaks_tie_by_rss_descending
const tied = [
  { name: "a", priority: 50, rss_mb: 20000 }, // higher RSS → evict first
  { name: "b", priority: 50, rss_mb: 5000 },
];
expect(pickEvictionTarget(tied)).toBe("a");

// test: pickEvictionTarget_returns_null_for_empty_list
expect(pickEvictionTarget([])).toBeNull();

// test: buildEvictionProposal_produces_tier3_fleet_proposal
const p = buildEvictionProposal("w2", "HIGH", 30, 5000);
expect(p.kind).toBe("fleet-proposal");
expect(p.action.type).toBe("evict");
expect(p.action.tier).toBe(3);
expect(p.proposalId).toMatch(/^[0-9a-f]{8}/);
```

**Implementation**: `packages/agents/src/fleet-supervisor/proposals.ts`

- `pickEvictionTarget(ws: Array<{name: string; priority: number; rss_mb: number | null}>): string | null` —
  sort by priority asc, rss_mb desc (null last); return first name or null if empty.
- `buildEvictionProposal(workloadName, pressureLevel, freeMb, compressorMb): FleetProposalEntry` —
  `action: { type: 'evict', workloadName, tier: 3 }`,
  reasoning string, `proposalId: createHash('sha1').update(...).digest('hex').slice(0, 8)`.
- `buildRestartProposal(workloadName, reason): FleetProposalEntry` —
  `action: { type: 'restart', workloadName, tier: 3 }`.
- `buildMarkDegradedProposal(workloadName, reason): FleetProposalEntry` —
  `action: { type: 'mark_degraded', workloadName, tier: 2 }`.

**Verify**: `cd packages/agents && bun test test/fleet-supervisor-proposals.test.ts`

---

### Task 4.3 — Wire policy + proposals into the supervisor loop

```yaml meta
id: 4.3
files:
  - packages/agents/src/fleet-supervisor/loop.ts
file_scope: modify-existing
depends_on: [4.1, 4.2, 3.4]
parallel_with: []
preferred_agent: gemini-acp-pro
fallback_agent: claude-acp-sonnet
task_size: substantial
risk_class: schema-aware
```

**Failing test** — extend `packages/agents/test/fleet-supervisor-loop.test.ts`:

```ts
// test: loop_emits_eviction_proposal_on_pressure_HIGH
const entries: unknown[] = [];
const handle = startSupervisorLoop({
  node: "local",
  once: true,
  workloadTargets: [
    { name: "w1", endpoint: "http://127.0.0.1:8001", kind: "ModelHost", priority: 80 },
    { name: "w2", endpoint: "http://127.0.0.1:8002", kind: "ModelHost", priority: 20 },
  ],
  readNodeMem: async () => ({
    free_mb: 30,
    compressor_mb: 5000,
    active_mb: 200,
    inactive_mb: 100,
    wired_mb: 100,
  }),
  probeFetch: () => Promise.reject(new Error("offline")),
  writeJournal: (e) => entries.push(e),
  // 1-tick window so once-mode triggers immediately
  config: { ...defaultSupervisorConfig(), pressure_consecutive_ticks: 1 },
});
await handle.done;
const proposal = entries.find(
  (e) => (e as any).kind === "fleet-proposal" && (e as any).action?.type === "evict",
);
expect(proposal).toBeDefined();
expect((proposal as any).action.workloadName).toBe("w2"); // lowest priority

// test: loop_emits_degraded_proposal_after_n_slow_ticks
// Run loop twice (interval=0ms) with fake fetch returning 200 but slow (p95 > threshold)
// Expect fleet-proposal with action.type='restart' or 'mark_degraded' on second invocation
```

**Implementation**: extend `packages/agents/src/fleet-supervisor/loop.ts`:

1. Instantiate `PressureClassifier` + `Map<string, DegradationClassifier>` in loop closure.
2. After assembling snapshot, run `pressureClassifier.ingest(snap.node_mem)`.
   - On level flip to `HIGH`: pick eviction target via `pickEvictionTarget`, emit `buildEvictionProposal`.
   - Re-arm on return to `NORMAL` (same tick-flip pattern as healer's `stateTransitions`).
3. For each workload in snapshot, run `degradationClassifier.ingest(ws)`.
   - On state flip to `'degraded'`: emit `buildRestartProposal` (or `buildMarkDegradedProposal` for tier-2).
   - On `'unreachable'`: emit `buildRestartProposal` immediately.
4. Add `mode: 'propose' | 'auto'` and `severityThreshold: Tier` options (defaults: propose, 2).
   - In propose mode: journal proposals, never execute.
   - In auto mode: tier-3 proposals → journal as refused; tier-2 proposals → execute (future: wire
     to tRPC `workload.restart` when available).
5. Expose `onProposal?: (entry: FleetProposalEntry) => void` callback.

**Verify**: `cd packages/agents && bun test test/fleet-supervisor-loop.test.ts`

**Integration**: Phase 4 closes L2. The journal now carries `fleet-proposal` entries for pressure
and degradation events. All tier-3 actions (evict, restart) are propose-only by default.
Full suite: `cd packages/agents && bun test`.

---

## Phase 5 — CLI Surface

Dispatch graph: 5.1 → 5.2

### Task 5.1 — `llamactl supervisor serve` + `status` commands

```yaml meta
id: 5.1
files:
  - packages/cli/src/commands/supervisor.ts
file_scope: new
depends_on: [4.3]
parallel_with: []
preferred_agent: gemini-acp-pro
fallback_agent: claude-acp-sonnet
task_size: substantial
risk_class: paste-ready
```

**Failing test** — `packages/cli/test/supervisor.test.ts`:

```ts
// test: supervisor_serve_once_exits_without_error
// Build SupervisorLoopOptions with injectable readNodeMem + probeFetch (both error-returning)
// Call runSupervisorServe({ once: true, ...fakeOpts })
// Expect: resolves without throwing, at least one journal entry written

// test: supervisor_status_reads_and_formats_journal
// Write 3 fake journal entries to a temp path
// Call runSupervisorStatus({ journalPath: tmpPath, tail: 3 })
// Expect: returns array of parsed entries
```

**Implementation**: `packages/cli/src/commands/supervisor.ts`

`supervisor serve` subcommand:

- Options: `--node`, `--interval=60s`, `--once`, `--auto`, `--severity-threshold=2`,
  `--journal=<path>`, `--config=<yaml-path>`.
- Loads workload list from `listNodeRuns()` (and ModelHost equivalents from daemon state or
  kubeconfig `clusters.nodes` with `kind:ModelHost`).
- Builds `workloadTargets` from enabled workloads.
- Starts `startSupervisorLoop`, pipes tick summaries to stdout in `heal`-style one-liner format:
  `[tick 1] local: free=500MB pressure=NORMAL w1=healthy w2=healthy`.
- Prints proposals inline with `[PROPOSAL]` prefix.

`supervisor status` subcommand:

- Options: `--journal=<path>`, `--tail=N` (default 20), `--proposals-only`.
- Reads journal JSONL tail, formats as table.
- `--proposals-only` filters to `fleet-proposal` entries only.

**Verify**: `cd packages/cli && bun test test/supervisor.test.ts`

---

### Task 5.2 — Register commands + integration smoke

```yaml meta
id: 5.2
files:
  - packages/cli/src/index.ts
file_scope: modify-existing
depends_on: [5.1, 2.4]
parallel_with: []
preferred_agent: gemini-acp-pro
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: schema-aware
```

**Failing test** — `packages/cli/test/cli-registration.test.ts` (extend existing):

```ts
// test: cli_registers_supervisor_subcommands
// Parse `--help` output or introspect registered commands
// Expect 'supervisor' command with 'serve' and 'status' subcommands
// Expect 'admit' command with positional <workload-name>
```

**Implementation**:

- Import and register `supervisorCommand` from `./commands/supervisor.js` under the root CLI.
- Import and register `admitCommand` from `./commands/admit.js`.
- Ensure `bun run build` (or equivalent) produces updated CLI bundle.

**Verify**:

```
cd packages/cli && bun test test/cli-registration.test.ts
llamactl supervisor --help   # smoke: shows serve + status
llamactl admit --help        # smoke: shows positional + options
llamactl supervisor serve --once --node=local   # integration smoke
```

**Integration**: Phase 5 wraps the supervisor in a `llamactl supervisor serve` daemon-mode entry
point and a `llamactl supervisor status` read path. Full cross-package check:
`cd packages/agents && bun test && cd ../cli && bun test`.

---

## Open items — deferred to follow-on plan

| Item                                                | Reason deferred                                                                                                                                                                              |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L3: dynamic mcr/max-model-memory reshape            | oMLX requires restart; no live-config primitive yet. Propose-only journaling of reshape recommendations is Phase 4's `buildRestartProposal`. Revisit when engine gains `/admin/reconfigure`. |
| L4: `spec.priority` eviction ordering in controller | Phase 2.1 adds the field; the controller's `noderun-reconciler.ts` doesn't yet consult it for eviction ordering. Depends on having a running supervisor producing pressure signals.          |
| L4: Cross-node role failover proposal               | Requires tRPC surface on agentchat pool to swap members at runtime. Out of scope for v1.                                                                                                     |
| Prometheus metrics endpoint                         | `llamactl supervisor serve --metrics-port=9100` emitting node_mem + workload health gauges. One-file addition after Phase 5 stabilizes.                                                      |
| Retention policy for journal                        | Capped ring-buffer flush is clean enough for v1; a `--retention-days=7` pruner is a one-shot cron addition.                                                                                  |

---

## Validation

After writing, run:

```
penumbra plan validate docs/superpowers/plans/2026-05-22-fleet-supervisor.md
```

Expected passes:

- `parallel_with` reciprocity: (1.1↔1.2), (2.3↔2.4), (3.1↔3.2), (4.1↔4.2). ✓
- No `depends_on` cycles. ✓
- No `file_scope: new` collisions — each new file appears in exactly one task. ✓
- All agent names in registry: `gemini-acp-pro`, `claude-acp-sonnet`. ✓

## Execution options

**Subagent-driven**: dispatch Phase 1 tasks 1.1 ∥ 1.2 in parallel (two `chain_start` calls),
await both, then dispatch 1.3 → Phase 2 serially. Apply the
`/dispatch-quality-gates` check before each `chain_start`. Worktrees: use `use_worktree: true`
per task and `dispatch_land` each phase branch before starting the next.

**Inline**: implement Phase 1–2 directly (small tasks, clear contracts) and dispatch Phase 3–4
(substantial + cross-file) to `gemini-acp-pro`.
