# Fleet Supervisor — Phased TDD Plan

**Spec**: `docs/superpowers/specs/2026-05-22-fleet-supervisor-spec.md`
**Scope**: L1 (observability) + L5 (predictive admission) in week 1; L2 (reactive ops) in week 2; L3/L4 deferred.
**Package**: `packages/fleet-supervisor/` — new, mirrors `packages/agents/healer/` structure.

---

## Design decisions baked in

| Open question                        | Decision                                                                                                                                                                                                                                                                                                        |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pressure threshold derivation        | `free_mb < headroom_min_mb AND compressor_mb > compressor_warn_mb` for N=3 **consecutive** ticks. No SMA averaging — consecutive avoids false positives from brief Metal bursts. Defaults: `headroom_min_mb=512`, `compressor_warn_mb=2048`. Derivation: 2026-05-22 incident had free=15MB + compressor=2600MB. |
| Per-port request/error accounting    | Pure HTTP probe: `/health` non-2xx or timeout → increment error counter. `/v1/models` → reachability + model list. No log-tailing, no proxy coupling. Request rate from `/v1/metrics` if available; null otherwise.                                                                                             |
| Eviction tie-break at equal priority | RSS descending (evict largest → recover most memory), then alphabetical for determinism.                                                                                                                                                                                                                        |
| mcr live-tuning vs restart           | Propose restart with new args for v1. No live config mutation.                                                                                                                                                                                                                                                  |
| Admission overhead factor            | `projected_free = current_free_mb - expectedMemoryGiB * 1024 * 1.3`. Derived from bench: Qwen3-8B 7 GiB spec → ~10 GiB reality = 1.43×; granite-3b 3 GiB spec → ~4 GiB = 1.33×; use 1.3 as floor. Configurable via `--overhead-factor`.                                                                         |
| Eviction severity tier               | Tier 3 (destructive). Never auto-executed unless `--severity-threshold=3`. Marking `degraded` is Tier 2 (auto-allowed by default).                                                                                                                                                                              |
| Supervisor self-monitoring           | Emit `kind: 'fleet-heartbeat'` every tick. Missing heartbeat = stale.                                                                                                                                                                                                                                           |
| Cross-node v1                        | Per-node supervisor instances run independently. mac-mini runs its own via launchd (same pattern as `install-agent-macos.sh`).                                                                                                                                                                                  |

---

## Package layout

```
packages/fleet-supervisor/
  src/
    types.ts           ← all journal + snapshot types
    node-probe.ts      ← vm_stat parser + NodeMemSnapshot
    workload-probe.ts  ← HTTP probe per endpoint
    journal.ts         ← append-only jsonl writer
    policy.ts          ← pressure + degradation detection
    admission.ts       ← live pre-flight check
    loop.ts            ← startSupervisorLoop
    index.ts           ← public exports
  test/
    node-probe.test.ts
    workload-probe.test.ts
    journal.test.ts
    policy-pressure.test.ts
    policy-degradation.test.ts
    admission.test.ts
    loop.test.ts
  package.json
  tsconfig.json
```

CLI additions:

- `packages/cli/src/commands/supervisor.ts` — `llamactl supervisor serve`
- `packages/cli/src/commands/admit.ts` — `llamactl admit <workload>`
- `packages/cli/src/commands/enable.ts` — wire pre-flight check before `spec.enabled=true`

---

## Phase 1 — Node memory probe

**Goal**: Parse macOS `vm_stat` into a typed `NodeMemSnapshot`.

### 1.1 Failing test

**File**: `packages/fleet-supervisor/test/node-probe.test.ts`
**Test name**: `parseVmStatOutput: produces correct NodeMemSnapshot from known output`

```typescript
import { describe, it, expect } from "bun:test";
import { parseVmStatOutput } from "../src/node-probe.js";

const FAKE_VM_STAT = `
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                         1031.
Pages active:                        912.
Pages inactive:                      839.
Pages wired down:                    320.
Pages occupied by compressor:       2600.
Swapins:                               0.
Swapouts:                              0.
`.trim();

describe("parseVmStatOutput", () => {
  it("produces correct NodeMemSnapshot from known output", () => {
    const snap = parseVmStatOutput(FAKE_VM_STAT);
    expect(snap.free_mb).toBeCloseTo((1031 * 16384) / 1024 / 1024, 0);
    expect(snap.active_mb).toBeCloseTo((912 * 16384) / 1024 / 1024, 0);
    expect(snap.compressor_mb).toBeCloseTo((2600 * 16384) / 1024 / 1024, 0);
    expect(snap.swap_in).toBe(0);
    expect(snap.swap_out).toBe(0);
  });
});
```

**Assertion**: all numeric fields derived from page counts × page_size / 1024².

### 1.2 Implementation

**File**: `packages/fleet-supervisor/src/node-probe.ts`

- `parseVmStatOutput(raw: string): NodeMemSnapshot` — regex-parse each `Pages X: N.` line; extract `page size of N bytes` header; multiply.
- `probeNodeMem(opts?: { exec?: (cmd: string) => Promise<string> }): Promise<NodeMemSnapshot>` — default exec runs `vm_stat`; tests inject a fake.
- `NodeMemSnapshot` interface lives in `types.ts`.

### 1.3 Verify

```bash
bun test packages/fleet-supervisor/test/node-probe.test.ts
```

---

## Phase 2 — Workload HTTP probe

**Goal**: Probe a ModelHost/ModelRun endpoint for reachability, latency, and model list.

### 2.1 Failing test

**File**: `packages/fleet-supervisor/test/workload-probe.test.ts`
**Test name**: `probeWorkload: healthy endpoint → reachable:true with latency and models`

```typescript
import { describe, it, expect } from "bun:test";
import { probeWorkload } from "../src/workload-probe.js";

describe("probeWorkload", () => {
  it("healthy endpoint → reachable:true with latency and models", async () => {
    const fakeFetch = async (url: string) => {
      if (url.endsWith("/health")) return new Response("ok", { status: 200 });
      if (url.endsWith("/v1/models"))
        return new Response(JSON.stringify({ data: [{ id: "Qwen3-8B" }] }), { status: 200 });
      return new Response("", { status: 404 });
    };
    const result = await probeWorkload(
      { name: "qwen-host", endpoint: "http://127.0.0.1:8090" },
      { fetch: fakeFetch as typeof fetch, timeoutMs: 500 },
    );
    expect(result.reachable).toBe(true);
    expect(result.healthLatencyMs).toBeGreaterThanOrEqual(0);
    expect(result.models).toEqual(["Qwen3-8B"]);
    expect(result.consecutiveErrors).toBe(0);
  });

  it("502 response → reachable:false, consecutiveErrors incremented", async () => {
    const fakeFetch = async () => new Response("Bad Gateway", { status: 502 });
    const result = await probeWorkload(
      { name: "granite-mini-3b", endpoint: "http://mac-mini.ai:8086" },
      { fetch: fakeFetch as typeof fetch, timeoutMs: 500, priorConsecutiveErrors: 3 },
    );
    expect(result.reachable).toBe(false);
    expect(result.consecutiveErrors).toBe(4);
  });
});
```

### 2.2 Implementation

**File**: `packages/fleet-supervisor/src/workload-probe.ts`

- `probeWorkload(target: WorkloadTarget, opts: WorkloadProbeOptions): Promise<WorkloadProbeResult>`
- Races `/health` GET against `timeoutMs`; records latency.
- On 2xx: fetches `/v1/models`, parses `data[*].id`.
- On non-2xx or timeout: `reachable: false`, `consecutiveErrors = priorConsecutiveErrors + 1`.

### 2.3 Verify

```bash
bun test packages/fleet-supervisor/test/workload-probe.test.ts
```

---

## Phase 3 — Journal writer

**Goal**: Append-only JSONL journal at `~/.llamactl/fleet-supervisor/journal.jsonl`.

### 3.1 Failing test

**File**: `packages/fleet-supervisor/test/journal.test.ts`
**Test name**: `appendFleetJournal: fleet-snapshot written to disk and parses back correctly`

```typescript
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendFleetJournal } from "../src/journal.js";
import type { FleetSnapshotEntry } from "../src/types.js";

describe("appendFleetJournal", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("fleet-snapshot written to disk and parses back correctly", () => {
    dir = mkdtempSync(join(tmpdir(), "fleet-journal-test-"));
    const path = join(dir, "journal.jsonl");
    const entry: FleetSnapshotEntry = {
      kind: "fleet-snapshot",
      ts: "2026-05-22T17:00:00.000Z",
      node: "local",
      node_mem: {
        free_mb: 1031,
        active_mb: 912,
        inactive_mb: 839,
        wired_mb: 320,
        compressor_mb: 2600,
        swap_in: 0,
        swap_out: 0,
      },
      workloads: [
        {
          name: "qwen-host",
          kind: "ModelHost",
          endpoint: "http://127.0.0.1:8090",
          rss_mb: null,
          request_rate_5m: null,
          error_rate_5m: 0,
          p50_ms: 240,
          p95_ms: 480,
          models: ["Qwen3-8B"],
          reachable: true,
          consecutiveErrors: 0,
        },
      ],
    };
    appendFleetJournal(entry, path);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.kind).toBe("fleet-snapshot");
    expect(parsed.node).toBe("local");
    expect(parsed.workloads[0].name).toBe("qwen-host");
    expect(parsed.node_mem.compressor_mb).toBe(2600);
  });
});
```

### 3.2 Implementation

**File**: `packages/fleet-supervisor/src/types.ts`

```typescript
export interface NodeMemSnapshot {
  free_mb: number;
  active_mb: number;
  inactive_mb: number;
  wired_mb: number;
  compressor_mb: number;
  swap_in: number;
  swap_out: number;
}

export interface WorkloadSnapshot {
  name: string;
  kind: "ModelHost" | "ModelRun";
  endpoint: string;
  rss_mb: number | null;
  request_rate_5m: number | null;
  error_rate_5m: number;
  p50_ms: number;
  p95_ms: number;
  models: string[];
  reachable: boolean;
  consecutiveErrors: number;
}

export interface FleetSnapshotEntry {
  kind: "fleet-snapshot";
  ts: string;
  node: string;
  node_mem: NodeMemSnapshot;
  workloads: WorkloadSnapshot[];
}

export interface FleetHeartbeatEntry {
  kind: "fleet-heartbeat";
  ts: string;
  node: string;
}

export interface FleetTransitionEntry {
  kind: "fleet-transition";
  ts: string;
  node: string;
  subject: string;
  subjectKind: "workload" | "node";
  signal: "pressure" | "degraded";
  from: string;
  to: string;
}

export type FleetProposalAction =
  | { type: "evict"; workload: string; reason: string }
  | { type: "restart"; workload: string; reason: string }
  | { type: "mark-degraded"; workload: string; reason: string };

export interface FleetProposalEntry {
  kind: "fleet-proposal";
  ts: string;
  node: string;
  proposalId: string;
  transition: Pick<FleetTransitionEntry, "subject" | "subjectKind" | "signal" | "from" | "to">;
  action: FleetProposalAction;
}

export type FleetJournalEntry =
  | FleetSnapshotEntry
  | FleetHeartbeatEntry
  | FleetTransitionEntry
  | FleetProposalEntry;
```

**File**: `packages/fleet-supervisor/src/journal.ts`

- `appendFleetJournal(entry: FleetJournalEntry, path: string): void` — `mkdirSync(dirname(path), { recursive: true })` + `appendFileSync`.
- `defaultFleetJournalPath(): string` — `~/.llamactl/fleet-supervisor/journal.jsonl` (respects `DEV_STORAGE`).

### 3.3 Verify

```bash
bun test packages/fleet-supervisor/test/journal.test.ts
```

---

## Phase 4 — Supervisor loop (one tick)

**Goal**: `startSupervisorLoop` probes all declared workloads + node mem, emits `fleet-snapshot` + `fleet-heartbeat` per tick.

### 4.1 Failing test

**File**: `packages/fleet-supervisor/test/loop.test.ts`
**Test name**: `startSupervisorLoop: one tick emits fleet-snapshot + fleet-heartbeat`

```typescript
import { describe, it, expect } from "bun:test";
import { startSupervisorLoop } from "../src/loop.js";
import type { FleetJournalEntry } from "../src/types.js";

describe("startSupervisorLoop", () => {
  it("one tick emits fleet-snapshot + fleet-heartbeat to writeJournal", async () => {
    const entries: FleetJournalEntry[] = [];
    const handle = startSupervisorLoop({
      node: "local",
      once: true,
      workloads: [{ name: "qwen-host", endpoint: "http://127.0.0.1:8090", kind: "ModelHost" }],
      fetch: async () => new Response("ok", { status: 200 }),
      probeNodeMem: async () => ({
        free_mb: 1031,
        active_mb: 912,
        inactive_mb: 839,
        wired_mb: 320,
        compressor_mb: 100,
        swap_in: 0,
        swap_out: 0,
      }),
      writeJournal: (entry) => entries.push(entry),
    });
    await handle.done;
    const kinds = entries.map((e) => e.kind);
    expect(kinds).toContain("fleet-snapshot");
    expect(kinds).toContain("fleet-heartbeat");
  });
});
```

### 4.2 Implementation

**File**: `packages/fleet-supervisor/src/loop.ts`

```typescript
export interface SupervisorLoopOptions {
  node: string;
  once?: boolean;
  intervalMs?: number;
  workloads: WorkloadTarget[];
  fetch?: typeof globalThis.fetch;
  probeNodeMem?: () => Promise<NodeMemSnapshot>;
  writeJournal?: (entry: FleetJournalEntry) => void;
  journalPath?: string;
  onTick?: (snapshot: FleetSnapshotEntry) => void;
  thresholds?: PressureThresholds;
  auto?: boolean;
  severityThreshold?: 1 | 2 | 3;
}

export interface SupervisorLoopHandle {
  stop(): void;
  done: Promise<void>;
}

export function startSupervisorLoop(opts: SupervisorLoopOptions): SupervisorLoopHandle;
```

Per tick: probe node mem → probe all workloads → emit `fleet-snapshot` → emit `fleet-heartbeat` → run pressure policy → run per-workload degradation policy.

### 4.3 Verify

```bash
bun test packages/fleet-supervisor/test/loop.test.ts
```

---

## Phase 5 — Predictive admission (L5)

**Goal**: Reject `llamactl enable` when projected free memory falls below `headroom_min_mb`.

### 5.1 Failing test

**File**: `packages/fleet-supervisor/test/admission.test.ts`
**Test names**: reject / admit / skip-when-null

```typescript
import { describe, it, expect } from "bun:test";
import { admitWithLiveCheck } from "../src/admission.js";

const NORMAL_MEM = async () => ({
  free_mb: 8192,
  active_mb: 0,
  inactive_mb: 0,
  wired_mb: 0,
  compressor_mb: 0,
  swap_in: 0,
  swap_out: 0,
});
const LOW_MEM = async () => ({
  free_mb: 500,
  active_mb: 0,
  inactive_mb: 0,
  wired_mb: 0,
  compressor_mb: 0,
  swap_in: 0,
  swap_out: 0,
});

describe("admitWithLiveCheck", () => {
  it("rejects when projected free memory below headroom", async () => {
    // 0.6 GiB * 1024 * 1.3 = 798 MB; 500 - 798 = -298 < 200 headroom
    const result = await admitWithLiveCheck({
      expectedMemoryGiB: 0.6,
      overheadFactor: 1.3,
      headroomMb: 200,
      probeNodeMem: LOW_MEM,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/headroom/i);
  });

  it("admits when projected free memory exceeds headroom", async () => {
    // 3 GiB * 1024 * 1.3 = 3994 MB; 8192 - 3994 = 4198 > 512 headroom
    const result = await admitWithLiveCheck({
      expectedMemoryGiB: 3,
      overheadFactor: 1.3,
      headroomMb: 512,
      probeNodeMem: NORMAL_MEM,
    });
    expect(result.ok).toBe(true);
  });

  it("skips check when expectedMemoryGiB is null", async () => {
    const result = await admitWithLiveCheck({
      expectedMemoryGiB: null,
      overheadFactor: 1.3,
      headroomMb: 512,
      probeNodeMem: LOW_MEM,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.skipped).toBe(true);
  });
});
```

### 5.2 Implementation

**File**: `packages/fleet-supervisor/src/admission.ts`

```typescript
export interface AdmitLiveInput {
  expectedMemoryGiB: number | null;
  overheadFactor?: number; // default 1.3
  headroomMb?: number; // default 512
  probeNodeMem?: () => Promise<NodeMemSnapshot>;
}
export type AdmitLiveResult =
  | { ok: true; projectedFreeMb: number; headroomMb: number; skipped?: boolean }
  | { ok: false; projectedFreeMb: number; headroomMb: number; reason: string };

export async function admitWithLiveCheck(input: AdmitLiveInput): Promise<AdmitLiveResult>;
```

Logic: null → skip. `requiredMb = expectedMemoryGiB * 1024 * factor`. `projected = free_mb - requiredMb`. Reject if `projected < headroomMb`.

**Wire into CLI `enable`**: call `admitWithLiveCheck` before writing `spec.enabled = true`; if `!ok` print error + exit 1.

**New command** `packages/cli/src/commands/admit.ts`:

```
llamactl admit <workload-name> [--headroom-mb=512] [--overhead-factor=1.3] [--json]
```

Reads manifest, calls `admitWithLiveCheck`, exits 0 (admit) / 1 (reject).

### 5.3 Verify

```bash
bun test packages/fleet-supervisor/test/admission.test.ts
llamactl admit gains-host-35b-local
```

---

## Phase 6 — Pressure policy (L2 memory)

**Goal**: Detect N consecutive high-pressure ticks → emit `fleet-transition` + `fleet-proposal` (evict).

### 6.1 Failing test

**File**: `packages/fleet-supervisor/test/policy-pressure.test.ts`
**Test name**: `detectPressure: 3 consecutive high-pressure ticks → transition HIGH + evict largest`

```typescript
import { describe, it, expect } from "bun:test";
import { PressureWindow, detectPressure } from "../src/policy.js";
import type { NodeMemSnapshot, WorkloadSnapshot } from "../src/types.js";

const THRESHOLDS = { headroomMinMb: 512, compressorWarnMb: 2048, consecutiveTicks: 3 };

const HIGH: NodeMemSnapshot = {
  free_mb: 30,
  compressor_mb: 4000,
  active_mb: 0,
  inactive_mb: 0,
  wired_mb: 0,
  swap_in: 0,
  swap_out: 0,
};
const NORMAL: NodeMemSnapshot = {
  free_mb: 4096,
  compressor_mb: 200,
  active_mb: 0,
  inactive_mb: 0,
  wired_mb: 0,
  swap_in: 0,
  swap_out: 0,
};

const WLS: WorkloadSnapshot[] = [
  {
    name: "gains-host-35b-local",
    kind: "ModelHost",
    endpoint: "http://127.0.0.1:8096",
    rss_mb: 36864,
    reachable: true,
    consecutiveErrors: 0,
    request_rate_5m: 2,
    error_rate_5m: 0,
    p50_ms: 240,
    p95_ms: 480,
    models: [],
  },
  {
    name: "granite-3b-local",
    kind: "ModelHost",
    endpoint: "http://127.0.0.1:8083",
    rss_mb: 4096,
    reachable: true,
    consecutiveErrors: 0,
    request_rate_5m: 1,
    error_rate_5m: 0,
    p50_ms: 100,
    p95_ms: 200,
    models: [],
  },
];

describe("detectPressure", () => {
  it("3 consecutive HIGH ticks → level HIGH + evict largest RSS", () => {
    const window = new PressureWindow(3);
    for (let i = 0; i < 3; i++) window.push(HIGH, WLS);
    const result = detectPressure(window, THRESHOLDS);
    expect(result).not.toBeNull();
    expect(result!.level).toBe("HIGH");
    expect(result!.proposal.action.type).toBe("evict");
    expect(result!.proposal.action.workload).toBe("gains-host-35b-local"); // largest RSS
  });

  it("returns null under normal pressure", () => {
    const window = new PressureWindow(3);
    for (let i = 0; i < 3; i++) window.push(NORMAL, WLS);
    expect(detectPressure(window, THRESHOLDS)).toBeNull();
  });

  it("returns null with only 2 consecutive HIGH ticks (not yet N=3)", () => {
    const window = new PressureWindow(3);
    window.push(NORMAL, WLS);
    window.push(HIGH, WLS);
    window.push(HIGH, WLS);
    expect(detectPressure(window, THRESHOLDS)).toBeNull();
  });
});
```

### 6.2 Implementation

**File**: `packages/fleet-supervisor/src/policy.ts`

- `PressureWindow` — ring buffer of `{ node_mem, workloads }`, capacity N.
- `detectPressure(window, thresholds): PressureResult | null` — non-null only when all N entries are HIGH. Eviction candidate = max `rss_mb`, then alphabetical.
- Wire into `loop.ts`: per-tick pressure check; on `NORMAL→HIGH` flip emit `fleet-transition` + `fleet-proposal`.

### 6.3 Verify

```bash
bun test packages/fleet-supervisor/test/policy-pressure.test.ts
```

---

## Phase 7 — Degradation policy (L2 workload)

**Goal**: Detect consecutive workload errors → emit transition + proposal (restart).

### 7.1 Failing test

**File**: `packages/fleet-supervisor/test/policy-degradation.test.ts`
**Test name**: `detectDegradation: 4 consecutive 502s → degraded + restart proposal`

```typescript
import { describe, it, expect } from "bun:test";
import { detectDegradation } from "../src/policy.js";
import type { WorkloadSnapshot } from "../src/types.js";

const THRESHOLDS = { consecutiveErrorsForDegraded: 3, p95DegradedMs: 5000 };

describe("detectDegradation", () => {
  it("4 consecutive errors → state degraded + restart proposal", () => {
    const workload: WorkloadSnapshot = {
      name: "granite-mini-3b",
      kind: "ModelRun",
      endpoint: "http://mac-mini.ai:8086",
      rss_mb: null,
      request_rate_5m: null,
      error_rate_5m: 1.0,
      p50_ms: 0,
      p95_ms: 0,
      models: [],
      reachable: false,
      consecutiveErrors: 4,
    };
    const result = detectDegradation(workload, "healthy", THRESHOLDS);
    expect(result).not.toBeNull();
    expect(result!.to).toBe("degraded");
    expect(result!.proposal.action.type).toBe("restart");
    expect(result!.proposal.action.workload).toBe("granite-mini-3b");
  });

  it("healthy workload emits no transition", () => {
    const workload: WorkloadSnapshot = {
      name: "qwen-host",
      kind: "ModelHost",
      endpoint: "http://127.0.0.1:8090",
      rss_mb: 10240,
      request_rate_5m: 2,
      error_rate_5m: 0,
      p50_ms: 240,
      p95_ms: 480,
      models: ["Qwen3-8B"],
      reachable: true,
      consecutiveErrors: 0,
    };
    expect(detectDegradation(workload, "healthy", THRESHOLDS)).toBeNull();
  });

  it("degraded → healthy recovery emits transition + no proposal", () => {
    const workload: WorkloadSnapshot = {
      name: "granite-mini-3b",
      kind: "ModelRun",
      endpoint: "http://mac-mini.ai:8086",
      rss_mb: 2048,
      request_rate_5m: 1,
      error_rate_5m: 0,
      p50_ms: 120,
      p95_ms: 200,
      models: [],
      reachable: true,
      consecutiveErrors: 0,
    };
    const result = detectDegradation(workload, "degraded", THRESHOLDS);
    expect(result).not.toBeNull();
    expect(result!.to).toBe("healthy");
  });
});
```

### 7.2 Implementation

**File**: `packages/fleet-supervisor/src/policy.ts` (extend)

- `detectDegradation(workload, priorState, thresholds): DegradationResult | null` — null when state unchanged. Degraded = `consecutiveErrors >= threshold OR p95_ms > p95DegradedMs`. Recovery = `reachable && consecutiveErrors === 0`.
- Wire into `loop.ts`: per-workload state map; emit on flip.

### 7.3 Verify

```bash
bun test packages/fleet-supervisor/test/policy-degradation.test.ts
```

---

## Phase 8 — CLI commands

**Goal**: `llamactl supervisor serve` and `llamactl admit` operational.

### 8.1 Failing test

**File**: `packages/cli/test/supervisor.test.ts`
**Test name**: `llamactl supervisor serve --once exits 0 and writes fleet-snapshot`

```typescript
import { describe, it, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("llamactl supervisor serve", () => {
  it("--once exits 0 and writes fleet-snapshot to journal", () => {
    const dir = mkdtempSync(join(tmpdir(), "supervisor-test-"));
    try {
      const journal = join(dir, "journal.jsonl");
      const result = spawnSync(
        "bun",
        [
          "run",
          "packages/cli/src/index.ts",
          "supervisor",
          "serve",
          "--once",
          `--journal=${journal}`,
          "--no-workloads",
        ],
        { encoding: "utf8", timeout: 10_000 },
      );
      expect(result.status).toBe(0);
      const lines = readFileSync(journal, "utf8").trim().split("\n");
      expect(lines.length).toBeGreaterThanOrEqual(1);
      expect(JSON.parse(lines[0]).kind).toBe("fleet-snapshot");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

### 8.2 Implementation

**File**: `packages/cli/src/commands/supervisor.ts`

Flags:

```
--interval=<s>            Seconds between ticks. Default 30.
--once                    One tick then exit.
--journal=<path>          Override journal path.
--auto                    Execute Tier-2 proposals automatically.
--severity-threshold=<n>  1|2|3. Default 2.
--headroom-mb=<n>         Admission headroom MiB. Default 512.
--overhead-factor=<f>     Memory overhead multiplier. Default 1.3.
--no-workloads            Skip workload probing (empty workload list).
--node=<name>             Node label. Default 'local'.
--quiet                   Suppress per-tick stderr.
```

**File**: `packages/cli/src/commands/admit.ts`

```
llamactl admit <workload-name> [--headroom-mb=512] [--overhead-factor=1.3] [--json]
```

Register both commands in the CLI command registry alongside `heal`.

### 8.3 Verify

```bash
bun test packages/cli/test/supervisor.test.ts
llamactl supervisor serve --once --quiet
llamactl admit gains-host-35b-local
```

---

## Full verification suite

```bash
bun test packages/fleet-supervisor/
bun test packages/cli/test/supervisor.test.ts
bun test packages/remote/src/workload/admission.test.ts   # regression: static check unchanged
llamactl supervisor serve --once --quiet
llamactl admit gains-host-35b-local
```

---

## Thresholds reference (bench-informed)

| Threshold                       | Default | Derivation                                                                           |
| ------------------------------- | ------- | ------------------------------------------------------------------------------------ |
| `headroom_min_mb`               | 512 MB  | 2026-05-22: free=15MB = cascade risk. 512MB gives ~1 model-worth of headroom.        |
| `compressor_warn_mb`            | 2048 MB | 2026-05-22: compressor=2600MB with 3 co-loaded models. 2048 = warning before crisis. |
| `consecutive_ticks` (pressure)  | 3       | Avoids Metal-init spikes (~60s at default 30s interval).                             |
| `consecutive_errors` (degraded) | 3       | granite-mini-3b returned 502s for hours; 3 ticks = ~90s at 30s interval.             |
| `p95_degraded_ms`               | 5000 ms | 10× normal p95 (480ms).                                                              |
| `overhead_factor`               | 1.3×    | Qwen3-8B 7GiB→10GiB = 1.43×; granite-3b 3GiB→4GiB = 1.33×; 1.3 as floor.             |

---

## L3/L4 deferred (follow-on plan)

- **L4 `spec.priority`**: add `priority: z.number().int().min(0).max(100).default(50)` to `ModelHostSpecSchema` + `ModelRunSpecSchema`. Phase 6 eviction sorts by priority asc first, RSS desc as tie-break.
- **L3 mcr reshape**: propose-restart-with-new-args; no live config mutation until engines support it.
- **Cross-node role failover**: agentchat pool reordering via tRPC mutation; deferred to L4 follow-on.

---

## Dispatch graph (week 1)

```
Phase 1 (node-probe)  ─────┐
Phase 2 (workload-probe) ──┤ parallel
                            ↓
                     Phase 3 (journal + types)
                            ↓
                     Phase 4 (loop)
                            ↓
                     Phase 5 (admission + CLI admit)   ← shippable after Phase 4
                            ↓
                     Phase 6 (pressure policy) ─┐
                     Phase 7 (degradation) ──────┤ parallel
                                                  ↓
                                           Phase 8 (CLI supervisor serve)
```

Phases 1+2 are independent — dispatch in parallel. Phases 6+7 both extend `policy.ts` but are disjoint functions — dispatch in parallel if the file is coordinated upfront (define the shared `PressureWindow` + types in Phase 6, import in Phase 7).
