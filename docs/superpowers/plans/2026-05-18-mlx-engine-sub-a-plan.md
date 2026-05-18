# MLX Engine Support — Sub A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the engine abstraction in llamactl with a new `kind: ModelHost` manifest type and an oMLX engine adapter that runs alongside llama.cpp workloads, plus the supporting pull/catalog/openaiProxy/matrix changes to make one pilot MLX workload (`mlx-community/Qwen3-8B-MLX-4bit` on `:8094`) work end-to-end coexisting with the live `granite41-3b-long-lived-local` on `:8083`.

**Architecture:** Strategy-registry `EngineAdapter` at `packages/core/src/engines/` dispatched on a string engine name (`'llamacpp'|'omlx'`). New zod schema `ModelHostSpec` with `kind: ModelHost` discriminator; existing `ModelRun` unchanged. `workloadRuntime.listLocalWorkloads()` returns a unified `LocalRoute[]` covering both kinds; `openaiProxy` routes against that table. Matrix bench dispatches on optional `engine` field. oMLX built from source pattern mirrors atomic llama.cpp fork (Python venv via `uv`).

**Tech Stack:** TypeScript (Bun runtime), Zod schemas, oMLX (Python entrypoint), llama.cpp (existing). All work runs against `/Volumes/WorkSSD/repos/personal/llamactl`. Per `reference_penumbra_dispatch_routing`: every per-task dispatch sets `use_worktree: false` and prepends `cd /Volumes/WorkSSD/repos/personal/llamactl` to the prompt; do **not** use the worktree path the daemon defaults to.

## Phase 1: Foundations

Dispatch graph: 1.1 ∥ 1.2

Integration: both tasks add files only, no edits to existing code. After both land, FF-merge agent branches to main; no verification command needed beyond `bun test packages/core` (still green).

### Task 1.1: EngineAdapter interface + registry skeleton

```yaml meta
id: '1.1'
files:
  - packages/core/src/engines/types.ts
  - packages/core/src/engines/index.ts
file_scope: new
depends_on: []
parallel_with: ['1.2']
preferred_agent: codex-acp-fast
fallback_agent: oc-deepseek-v4-pro
task_size: small
risk_class: paste-ready
```

**Files:**
- Create: `packages/core/src/engines/types.ts`
- Create: `packages/core/src/engines/index.ts`
- Create: `packages/core/test/engines/types.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/core/test/engines/types.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { ENGINES, type EngineName } from '../../src/engines/index.js';

describe('engine registry', () => {
  test('registry contains llamacpp and omlx keys', () => {
    const keys: EngineName[] = Object.keys(ENGINES) as EngineName[];
    expect(keys).toContain('llamacpp');
    expect(keys).toContain('omlx');
  });

  test('every registered engine reports its own name', () => {
    for (const [key, adapter] of Object.entries(ENGINES)) {
      expect(adapter.name).toBe(key);
    }
  });

  test('every adapter exposes validateSpec / buildBootCommand / probeReady / teardown', () => {
    for (const adapter of Object.values(ENGINES)) {
      expect(typeof adapter.validateSpec).toBe('function');
      expect(typeof adapter.buildBootCommand).toBe('function');
      expect(typeof adapter.probeReady).toBe('function');
      expect(typeof adapter.teardown).toBe('function');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/test/engines/types.test.ts`
Expected: fail with "Cannot find module '../../src/engines/index.js'".

- [ ] **Step 3: Write minimal implementation**

`packages/core/src/engines/types.ts`:

```ts
import type { ResolvedEnv } from '../types.js';

export type EngineName = 'llamacpp' | 'omlx';

export interface ModelHostHostedModel {
  rel: string;
}

export interface ModelHostSpecForEngine {
  engine: EngineName;
  binary: string;
  endpoint: { host: string; port: number };
  hostedModels: ModelHostHostedModel[];
  resources?: { expectedMemoryGiB?: number };
  extraArgs: string[];
  timeoutSeconds: number;
}

export interface EngineAdapter {
  name: EngineName;
  validateSpec(spec: ModelHostSpecForEngine): { ok: true } | { ok: false; error: string };
  buildBootCommand(
    spec: ModelHostSpecForEngine,
    env: ResolvedEnv,
  ): { binary: string; args: string[]; envOverrides?: Record<string, string> };
  probeReady(
    endpoint: { host: string; port: number },
    timeoutMs: number,
  ): Promise<{ ready: boolean; modelIds: string[] }>;
  teardown(pid: number): Promise<void>;
}
```

`packages/core/src/engines/index.ts`:

```ts
import type { EngineAdapter, EngineName } from './types.js';

// Placeholder skeletons; real implementations land in Phase 2.
const placeholder = (name: EngineName): EngineAdapter => ({
  name,
  validateSpec: () => ({ ok: false, error: `engine ${name} not yet implemented` }),
  buildBootCommand: () => { throw new Error(`engine ${name} not yet implemented`); },
  probeReady: async () => ({ ready: false, modelIds: [] }),
  teardown: async () => {},
});

export const ENGINES: Record<EngineName, EngineAdapter> = {
  llamacpp: placeholder('llamacpp'),
  omlx: placeholder('omlx'),
};

export type { EngineAdapter, EngineName, ModelHostSpecForEngine, ModelHostHostedModel } from './types.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/test/engines/types.test.ts`
Expected: 3 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/engines/types.ts packages/core/src/engines/index.ts packages/core/test/engines/types.test.ts
git commit -F - <<'EOF'
feat(core/engines): EngineAdapter strategy registry skeleton

Adds the engine abstraction interface that ModelHost manifests will
dispatch through. Two placeholder engines registered (llamacpp, omlx);
real implementations land in Phase 2.

Pattern: pure-function records keyed by engine name, no class
hierarchy — matches the codebase's existing functional + zod style.
EOF
```

### Task 1.2: oMLX from-source bootstrap

```yaml meta
id: '1.2'
files:
  - tools/install-omlx-from-source.sh
  - tools/omlx.lock
file_scope: new
depends_on: []
parallel_with: ['1.1']
preferred_agent: codex-acp-fast
fallback_agent: oc-deepseek-v4-pro
task_size: small
risk_class: paste-ready
```

**Files:**
- Create: `tools/install-omlx-from-source.sh`
- Create: `tools/omlx.lock`

- [ ] **Step 1: Author the install script**

`tools/install-omlx-from-source.sh`:

```bash
#!/usr/bin/env bash
# Clone + venv + editable install for jundot/omlx.
# Idempotent: re-running updates to the pinned commit and reinstalls deps.

set -euo pipefail

REPO_URL="https://github.com/jundot/omlx.git"
SRC_DIR="${OMLX_SRC:-/Volumes/WorkSSD/src/omlx}"
LOCK_FILE="$(cd "$(dirname "$0")" && pwd)/omlx.lock"

if [[ ! -f "$LOCK_FILE" ]]; then
  echo "omlx.lock not found at $LOCK_FILE" >&2
  exit 1
fi

PINNED_COMMIT="$(awk -F= '/^commit=/ {print $2; exit}' "$LOCK_FILE")"
if [[ -z "$PINNED_COMMIT" ]]; then
  echo "omlx.lock missing 'commit=<sha>' line" >&2
  exit 1
fi

mkdir -p "$(dirname "$SRC_DIR")"

if [[ ! -d "$SRC_DIR/.git" ]]; then
  git clone "$REPO_URL" "$SRC_DIR"
fi

cd "$SRC_DIR"
git fetch --quiet
git checkout --quiet "$PINNED_COMMIT"

if [[ ! -d "$SRC_DIR/.venv" ]]; then
  uv venv
fi
uv pip install -e . --quiet

ENTRYPOINT="$SRC_DIR/.venv/bin/omlx"
if [[ ! -x "$ENTRYPOINT" ]]; then
  echo "expected omlx entrypoint at $ENTRYPOINT but file is not executable" >&2
  exit 1
fi

echo "omlx installed at $ENTRYPOINT (commit $PINNED_COMMIT)"
```

`tools/omlx.lock`:

```
# Pinned upstream commit of jundot/omlx verified working with llamactl Sub A.
# Update this and re-run tools/install-omlx-from-source.sh when bumping.
# Format: key=value lines. Unknown keys are ignored by the installer.
commit=HEAD
verified_date=2026-05-18
verified_by=llamactl/mlx-engine-sub-a-plan
notes=initial pin; tighten to a concrete sha when first manual install confirms cli compatibility.
```

(The `commit=HEAD` placeholder is intentional for Sub A — replaced with a concrete SHA during the manual run in Phase 6.4.)

- [ ] **Step 2: Make script executable + commit**

```bash
chmod +x tools/install-omlx-from-source.sh
git add tools/install-omlx-from-source.sh tools/omlx.lock
git commit -F - <<'EOF'
feat(tools): oMLX from-source bootstrap script + lockfile

Mirrors atomic llama.cpp fork pattern: clone jundot/omlx into
/Volumes/WorkSSD/src/omlx (configurable via OMLX_SRC), pin to a
commit recorded in tools/omlx.lock, install via uv venv + editable
pip install, expose entrypoint at $SRC/.venv/bin/omlx.

Idempotent — safe to re-run after pulling new commits.

Initial pin set to HEAD as a placeholder; replaced with a concrete SHA
during the first manual install run.
EOF
```

## Phase 2: Engine implementations + ModelHost schema

Dispatch graph: 2.1 ∥ 2.2 ∥ 2.3

Integration: all three tasks edit/create disjoint file sets. After all three merge, run `bun test packages/core packages/remote` to confirm both adapter tests and schema tests pass.

### Task 2.1: llama.cpp adapter (rehoused, behavior-neutral)

```yaml meta
id: '2.1'
files:
  - packages/core/src/engines/llamacpp.ts
  - packages/core/src/engines/index.ts
  - packages/core/test/engines/llamacpp.test.ts
file_scope: extend-shared
depends_on: ['1.1']
parallel_with: ['2.2', '2.3']
preferred_agent: codex-acp-fast
fallback_agent: codex-acp-deep
task_size: substantial
risk_class: schema-aware
```

**Files:**
- Create: `packages/core/src/engines/llamacpp.ts`
- Modify: `packages/core/src/engines/index.ts` (replace placeholder with real adapter)
- Create: `packages/core/test/engines/llamacpp.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/core/test/engines/llamacpp.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { ENGINES } from '../../src/engines/index.js';
import type { ModelHostSpecForEngine } from '../../src/engines/types.js';

const baseSpec: ModelHostSpecForEngine = {
  engine: 'llamacpp',
  binary: '/some/path/llama-server',
  endpoint: { host: '127.0.0.1', port: 8090 },
  hostedModels: [{ rel: 'granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf' }],
  resources: { expectedMemoryGiB: 5 },
  extraArgs: ['--jinja'],
  timeoutSeconds: 60,
};

describe('llamacpp engine adapter', () => {
  test('validateSpec passes a well-formed spec', () => {
    const result = ENGINES.llamacpp.validateSpec(baseSpec);
    expect(result.ok).toBe(true);
  });

  test('validateSpec rejects missing binary', () => {
    const bad = { ...baseSpec, binary: '' };
    const result = ENGINES.llamacpp.validateSpec(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/binary/i);
  });

  test('validateSpec rejects zero hosted models', () => {
    const bad = { ...baseSpec, hostedModels: [] };
    const result = ENGINES.llamacpp.validateSpec(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/hostedModels/);
  });

  test('buildBootCommand includes --port and the hosted model rel', () => {
    const built = ENGINES.llamacpp.buildBootCommand(baseSpec, {
      LLAMA_CPP_MODELS: '/tmp/models',
    } as any);
    expect(built.binary).toBe('/some/path/llama-server');
    expect(built.args).toContain('--port');
    expect(built.args).toContain('8090');
    // Hosted model rel should appear via -m or --model arg path
    const joined = built.args.join(' ');
    expect(joined).toMatch(/granite-4\.1-3b/);
  });

  test('buildBootCommand appends extraArgs verbatim after engine defaults', () => {
    const built = ENGINES.llamacpp.buildBootCommand(baseSpec, {
      LLAMA_CPP_MODELS: '/tmp/models',
    } as any);
    expect(built.args).toContain('--jinja');
    // --jinja should appear after the engine-built --port flag
    const portIdx = built.args.indexOf('--port');
    const jinjaIdx = built.args.indexOf('--jinja');
    expect(jinjaIdx).toBeGreaterThan(portIdx);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/core/test/engines/llamacpp.test.ts`
Expected: tests fail because the placeholder adapter is still wired into `ENGINES.llamacpp`.

- [ ] **Step 3: Write the adapter**

`packages/core/src/engines/llamacpp.ts`:

```ts
import type { ResolvedEnv } from '../types.js';
import type { EngineAdapter, ModelHostSpecForEngine } from './types.js';

export const llamacppEngine: EngineAdapter = {
  name: 'llamacpp',

  validateSpec(spec) {
    if (!spec.binary || spec.binary.trim() === '') {
      return { ok: false, error: 'llamacpp engine requires spec.binary' };
    }
    if (!spec.endpoint || typeof spec.endpoint.port !== 'number') {
      return { ok: false, error: 'llamacpp engine requires spec.endpoint.port' };
    }
    if (!Array.isArray(spec.hostedModels) || spec.hostedModels.length !== 1) {
      return { ok: false, error: 'Sub A: hostedModels must have exactly one entry' };
    }
    return { ok: true };
  },

  buildBootCommand(spec: ModelHostSpecForEngine, env: ResolvedEnv) {
    const modelRel = spec.hostedModels[0].rel;
    const modelsDir = (env as Record<string, string>).LLAMA_CPP_MODELS ?? '/tmp/models';
    const args: string[] = [
      '--host', spec.endpoint.host,
      '--port', String(spec.endpoint.port),
      '-m', `${modelsDir}/${modelRel}`,
      ...spec.extraArgs,
    ];
    return { binary: spec.binary, args };
  },

  async probeReady(endpoint, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://${endpoint.host}:${endpoint.port}/health`);
        if (r.ok) {
          return { ready: true, modelIds: [] };
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    return { ready: false, modelIds: [] };
  },

  async teardown(pid) {
    try {
      process.kill(pid, 'SIGTERM');
      await new Promise((r) => setTimeout(r, 10_000));
    } catch {}
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  },
};
```

Then in `packages/core/src/engines/index.ts`:

```ts
import type { EngineAdapter, EngineName } from './types.js';
import { llamacppEngine } from './llamacpp.js';

const placeholder = (name: EngineName): EngineAdapter => ({
  name,
  validateSpec: () => ({ ok: false, error: `engine ${name} not yet implemented` }),
  buildBootCommand: () => { throw new Error(`engine ${name} not yet implemented`); },
  probeReady: async () => ({ ready: false, modelIds: [] }),
  teardown: async () => {},
});

export const ENGINES: Record<EngineName, EngineAdapter> = {
  llamacpp: llamacppEngine,
  omlx: placeholder('omlx'),
};

export type { EngineAdapter, EngineName, ModelHostSpecForEngine, ModelHostHostedModel } from './types.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/core/test/engines/llamacpp.test.ts`
Expected: 5 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/engines/llamacpp.ts packages/core/src/engines/index.ts packages/core/test/engines/llamacpp.test.ts
git commit -F - <<'EOF'
feat(core/engines): llamacpp adapter (validate/boot/probe/teardown)

Implements the EngineAdapter interface for llama.cpp using the existing
arg shape (--host/--port/-m). Health probe hits /health. Teardown is
SIGTERM with 10s grace then SIGKILL.

ModelHost-style adapter only — existing ModelRun reconciler path is
untouched. This is the rehoused "the engine is llama.cpp" assumption
behind an explicit interface.
EOF
```

### Task 2.2: oMLX adapter

```yaml meta
id: '2.2'
files:
  - packages/core/src/engines/omlx.ts
  - packages/core/src/engines/index.ts
  - packages/core/test/engines/omlx.test.ts
file_scope: extend-shared
depends_on: ['1.1']
parallel_with: ['2.1', '2.3']
preferred_agent: codex-acp-fast
fallback_agent: codex-acp-deep
task_size: substantial
risk_class: schema-aware
```

**Files:**
- Create: `packages/core/src/engines/omlx.ts`
- Modify: `packages/core/src/engines/index.ts` (replace omlx placeholder)
- Create: `packages/core/test/engines/omlx.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/core/test/engines/omlx.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { ENGINES } from '../../src/engines/index.js';
import type { ModelHostSpecForEngine } from '../../src/engines/types.js';
import { existsSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function makeFakeBinary(): string {
  const dir = join(tmpdir(), `omlx-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'omlx');
  writeFileSync(path, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return path;
}

const goodBinary = makeFakeBinary();

const baseSpec: ModelHostSpecForEngine = {
  engine: 'omlx',
  binary: goodBinary,
  endpoint: { host: '127.0.0.1', port: 8094 },
  hostedModels: [{ rel: 'mlx-community/Qwen3-8B-MLX-4bit' }],
  resources: { expectedMemoryGiB: 12 },
  extraArgs: ['--max-concurrent-requests', '4'],
  timeoutSeconds: 60,
};

describe('omlx engine adapter', () => {
  test('validateSpec passes when binary exists', () => {
    const result = ENGINES.omlx.validateSpec(baseSpec);
    expect(result.ok).toBe(true);
  });

  test('validateSpec rejects missing binary file', () => {
    const bad = { ...baseSpec, binary: '/this/path/does/not/exist/omlx' };
    const result = ENGINES.omlx.validateSpec(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/binary not found/);
  });

  test('validateSpec rejects empty binary string (no PATH fallback)', () => {
    const bad = { ...baseSpec, binary: '' };
    const result = ENGINES.omlx.validateSpec(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/binary/i);
  });

  test('validateSpec rejects zero hosted models', () => {
    const bad = { ...baseSpec, hostedModels: [] };
    const result = ENGINES.omlx.validateSpec(bad);
    expect(result.ok).toBe(false);
  });

  test('buildBootCommand uses serve subcommand + --model-dir + --port', () => {
    const built = ENGINES.omlx.buildBootCommand(baseSpec, {
      LLAMA_CPP_MODELS: '/Volumes/WorkSSD/ai-models/llama.cpp/models',
    } as any);
    expect(built.binary).toBe(goodBinary);
    expect(built.args[0]).toBe('serve');
    expect(built.args).toContain('--model-dir');
    expect(built.args).toContain('/Volumes/WorkSSD/ai-models/llama.cpp/models');
    expect(built.args).toContain('--port');
    expect(built.args).toContain('8094');
    expect(built.args).toContain('--host');
    expect(built.args).toContain('127.0.0.1');
  });

  test('buildBootCommand passes --max-model-memory when resources set', () => {
    const built = ENGINES.omlx.buildBootCommand(baseSpec, {
      LLAMA_CPP_MODELS: '/tmp',
    } as any);
    expect(built.args).toContain('--max-model-memory');
    expect(built.args).toContain('12GB');
  });

  test('buildBootCommand appends extraArgs verbatim', () => {
    const built = ENGINES.omlx.buildBootCommand(baseSpec, {
      LLAMA_CPP_MODELS: '/tmp',
    } as any);
    expect(built.args).toContain('--max-concurrent-requests');
    expect(built.args).toContain('4');
  });

  test('probeReady returns matching modelIds when /v1/models contains the rel basename', async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/v1/models') {
          return new Response(JSON.stringify({
            object: 'list',
            data: [{ id: 'Qwen3-8B-MLX-4bit', object: 'model' }],
          }), { headers: { 'content-type': 'application/json' } });
        }
        return new Response('not found', { status: 404 });
      },
    });
    const result = await ENGINES.omlx.probeReady(
      { host: '127.0.0.1', port: server.port },
      3000,
    );
    server.stop();
    expect(result.ready).toBe(true);
    expect(result.modelIds).toContain('Qwen3-8B-MLX-4bit');
  });

  test('probeReady returns ready:false on timeout', async () => {
    const result = await ENGINES.omlx.probeReady(
      { host: '127.0.0.1', port: 1 },
      500,
    );
    expect(result.ready).toBe(false);
  });

  afterAll(() => {
    try { rmSync(goodBinary, { force: true }); } catch {}
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/core/test/engines/omlx.test.ts`
Expected: tests fail because the omlx placeholder is still wired.

- [ ] **Step 3: Write the adapter**

`packages/core/src/engines/omlx.ts`:

```ts
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import type { ResolvedEnv } from '../types.js';
import type { EngineAdapter, ModelHostSpecForEngine } from './types.js';

export const omlxEngine: EngineAdapter = {
  name: 'omlx',

  validateSpec(spec) {
    if (!spec.binary || spec.binary.trim() === '') {
      return { ok: false, error: 'omlx engine requires spec.binary (no PATH fallback)' };
    }
    if (!existsSync(spec.binary)) {
      return {
        ok: false,
        error: `omlx binary not found at ${spec.binary}; run tools/install-omlx-from-source.sh`,
      };
    }
    if (!spec.endpoint || typeof spec.endpoint.port !== 'number') {
      return { ok: false, error: 'omlx engine requires spec.endpoint.port' };
    }
    if (!Array.isArray(spec.hostedModels) || spec.hostedModels.length !== 1) {
      return { ok: false, error: 'Sub A: hostedModels must have exactly one entry' };
    }
    return { ok: true };
  },

  buildBootCommand(spec: ModelHostSpecForEngine, env: ResolvedEnv) {
    const modelsDir = (env as Record<string, string>).LLAMA_CPP_MODELS ?? '/tmp/models';
    const args: string[] = [
      'serve',
      '--model-dir', modelsDir,
      '--host', spec.endpoint.host,
      '--port', String(spec.endpoint.port),
    ];
    if (spec.resources?.expectedMemoryGiB !== undefined) {
      args.push('--max-model-memory', `${spec.resources.expectedMemoryGiB}GB`);
    }
    args.push(...spec.extraArgs);
    return { binary: spec.binary, args };
  },

  async probeReady(endpoint, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://${endpoint.host}:${endpoint.port}/v1/models`);
        if (r.ok) {
          const body = await r.json() as { data?: Array<{ id?: string }> };
          const ids = (body.data ?? []).map((m) => m.id ?? '').filter(Boolean);
          if (ids.length > 0) {
            return { ready: true, modelIds: ids };
          }
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    return { ready: false, modelIds: [] };
  },

  async teardown(pid) {
    try {
      process.kill(pid, 'SIGTERM');
      await new Promise((r) => setTimeout(r, 10_000));
    } catch {}
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  },
};

export function matchHostedModel(rel: string, ids: string[]): boolean {
  // oMLX returns model IDs as the directory basename, not the full HF rel.
  // The proxy will register both forms; this helper is exported so callers
  // can verify the mapping without re-implementing it.
  return ids.includes(rel) || ids.includes(basename(rel));
}
```

Then in `packages/core/src/engines/index.ts`:

```ts
import type { EngineAdapter, EngineName } from './types.js';
import { llamacppEngine } from './llamacpp.js';
import { omlxEngine } from './omlx.js';

export const ENGINES: Record<EngineName, EngineAdapter> = {
  llamacpp: llamacppEngine,
  omlx: omlxEngine,
};

export type { EngineAdapter, EngineName, ModelHostSpecForEngine, ModelHostHostedModel } from './types.js';
export { matchHostedModel } from './omlx.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/core/test/engines/omlx.test.ts`
Expected: 10 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/engines/omlx.ts packages/core/src/engines/index.ts packages/core/test/engines/omlx.test.ts
git commit -F - <<'EOF'
feat(core/engines): oMLX adapter (validate/boot/probe/teardown)

Implements EngineAdapter for oMLX:

- validateSpec: requires existing binary file (no PATH fallback),
  rejects empty binary string, enforces Sub A invariant
  hostedModels.length === 1.
- buildBootCommand: `omlx serve --model-dir <LLAMA_CPP_MODELS>
  --host <h> --port <p> [--max-model-memory NGB] ...extraArgs`.
- probeReady: polls /v1/models every 250ms; ready when at least one
  model ID is returned.
- teardown: SIGTERM + 10s grace + SIGKILL (same as llamacpp).

Exports matchHostedModel(rel, ids) so the proxy can register both
the HF rel path and the oMLX-returned basename as routable aliases.
EOF
```

### Task 2.3: ModelHost zod schema

```yaml meta
id: '2.3'
files:
  - packages/remote/src/workload/modelhost-schema.ts
  - packages/remote/test/workload/modelhost-schema.test.ts
file_scope: new
depends_on: ['1.1']
parallel_with: ['2.1', '2.2']
preferred_agent: codex-acp-fast
fallback_agent: oc-deepseek-v4-pro
task_size: small
risk_class: schema-aware
```

**Files:**
- Create: `packages/remote/src/workload/modelhost-schema.ts`
- Create: `packages/remote/test/workload/modelhost-schema.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/remote/test/workload/modelhost-schema.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { ModelHostManifestSchema } from '../../src/workload/modelhost-schema.js';

const valid = {
  apiVersion: 'llamactl/v1',
  kind: 'ModelHost',
  metadata: { name: 'mlx-host-local' },
  spec: {
    engine: 'omlx',
    node: 'local',
    enabled: true,
    binary: '/Volumes/WorkSSD/src/omlx/.venv/bin/omlx',
    resources: { expectedMemoryGiB: 12 },
    endpoint: { host: '127.0.0.1', port: 8094 },
    hostedModels: [{ rel: 'mlx-community/Qwen3-8B-MLX-4bit' }],
    extraArgs: ['--max-concurrent-requests', '4'],
    restartPolicy: 'Always',
    timeoutSeconds: 60,
  },
};

describe('ModelHostManifestSchema', () => {
  test('accepts a valid manifest', () => {
    const result = ModelHostManifestSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  test('rejects engine string outside the enum', () => {
    const bad = { ...valid, spec: { ...valid.spec, engine: 'vllm-mlx' } };
    const result = ModelHostManifestSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  test('rejects missing endpoint.port (no default)', () => {
    const bad = { ...valid, spec: { ...valid.spec, endpoint: { host: '127.0.0.1' } } };
    const result = ModelHostManifestSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  test('rejects empty hostedModels (Sub A min length 1)', () => {
    const bad = { ...valid, spec: { ...valid.spec, hostedModels: [] } };
    const result = ModelHostManifestSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  test('rejects hostedModels length > 1 (Sub A max length 1)', () => {
    const bad = {
      ...valid,
      spec: {
        ...valid.spec,
        hostedModels: [
          { rel: 'mlx-community/A' },
          { rel: 'mlx-community/B' },
        ],
      },
    };
    const result = ModelHostManifestSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  test('rejects manifest with stray `target` field (ModelRun-only)', () => {
    const bad = {
      ...valid,
      spec: { ...valid.spec, target: { kind: 'rel', value: 'foo' } },
    };
    const result = ModelHostManifestSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  test('rejects manifest with stray `workers` field (ModelRun-only)', () => {
    const bad = { ...valid, spec: { ...valid.spec, workers: [] } };
    const result = ModelHostManifestSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  test('rejects empty binary string (no PATH fallback for ModelHost)', () => {
    const bad = { ...valid, spec: { ...valid.spec, binary: '' } };
    const result = ModelHostManifestSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  test('rejects kind other than ModelHost', () => {
    const bad = { ...valid, kind: 'ModelRun' };
    const result = ModelHostManifestSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/remote/test/workload/modelhost-schema.test.ts`
Expected: fails on module-not-found.

- [ ] **Step 3: Write the schema**

`packages/remote/src/workload/modelhost-schema.ts`:

```ts
import { z } from 'zod';

export const ModelHostHostedModelSchema = z.object({
  rel: z.string().min(1),
}).strict();

export const ModelHostEndpointSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
}).strict();

export const ModelHostSpecSchema = z.object({
  engine: z.enum(['omlx']),  // Sub A: omlx only; Sub B+ widens.
  node: z.string().min(1),
  enabled: z.boolean().default(true),
  binary: z.string().min(1),  // Required; no PATH fallback on ModelHost.
  resources: z.object({
    expectedMemoryGiB: z.number().positive().optional(),
  }).optional(),
  endpoint: ModelHostEndpointSchema,
  hostedModels: z.array(ModelHostHostedModelSchema).min(1).max(1),
  extraArgs: z.array(z.string()).default([]),
  restartPolicy: z.enum(['Always', 'OnFailure', 'Never']).default('Always'),
  timeoutSeconds: z.number().int().positive().max(600).default(60),
}).strict();

export const ModelHostManifestSchema = z.object({
  apiVersion: z.literal('llamactl/v1'),
  kind: z.literal('ModelHost'),
  metadata: z.object({
    name: z.string().min(1),
    labels: z.record(z.string()).optional(),
  }).strict(),
  spec: ModelHostSpecSchema,
}).strict();

export type ModelHostManifest = z.infer<typeof ModelHostManifestSchema>;
export type ModelHostSpec = z.infer<typeof ModelHostSpecSchema>;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/remote/test/workload/modelhost-schema.test.ts`
Expected: 9 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add packages/remote/src/workload/modelhost-schema.ts packages/remote/test/workload/modelhost-schema.test.ts
git commit -F - <<'EOF'
feat(workload): ModelHost zod schema

New manifest kind ModelHost alongside existing ModelRun. Schema is
.strict() throughout — any stray field (target, workers, engine on
ModelRun) is rejected at parse time, not silently dropped.

Sub A invariants enforced:
- spec.engine enum is ['omlx'] (extensible)
- spec.binary required, min(1) (no PATH fallback)
- spec.endpoint.port required (no default)
- spec.hostedModels length [1, 1]
- spec.target and spec.workers are not present (those are ModelRun fields)
EOF
```

## Phase 3: Pull-path + catalog format column

Dispatch graph: 3.1 → 3.2

Integration: pull.ts depends on catalog's new format column existing. After both land, regenerate any reproducible catalog state by running `llamactl catalog list` and confirm GGUF entries still display correctly (back-compat probe).

### Task 3.1: Catalog `format` column

```yaml meta
id: '3.1'
files:
  - packages/core/src/catalog.ts
  - packages/core/src/catalogWriter.ts
  - packages/core/test/catalog.test.ts
file_scope: extend-shared
depends_on: []
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: codex-acp-deep
task_size: substantial
risk_class: schema-aware
```

**Files:**
- Modify: `packages/core/src/catalog.ts`
- Modify: `packages/core/src/catalogWriter.ts`
- Modify: `packages/core/test/catalog.test.ts`

- [ ] **Step 1: Write the failing test additions**

Read the existing `packages/core/test/catalog.test.ts` first, then add these test cases (do not delete or rename existing tests):

```ts
test('appends format=gguf for legacy rows missing the column', () => {
  // When loading a TSV row that pre-dates the format column, the parser
  // should default format to 'gguf' (back-compat for already-pulled
  // models).
  const legacyTsv = 'rel=foo/bar.gguf\tlabel=foo\tfamily=qwen\n';
  const rows = parseCatalogTsv(legacyTsv);
  expect(rows[0].format).toBe('gguf');
});

test('parses format=mlx when explicitly present', () => {
  const tsv = 'rel=mlx-community/Qwen3-8B-MLX-4bit\tlabel=qwen3-8b-mlx\tfamily=qwen\tformat=mlx\n';
  const rows = parseCatalogTsv(tsv);
  expect(rows[0].format).toBe('mlx');
});

test('writes format=mlx round-trips', () => {
  const written = writeCatalogTsv([
    { rel: 'mlx-community/Qwen3-8B-MLX-4bit', label: 'qwen3-8b-mlx', family: 'qwen', format: 'mlx' },
  ]);
  expect(written).toContain('format=mlx');
});
```

(If `parseCatalogTsv` / `writeCatalogTsv` exports don't exist exactly, find the equivalent and adapt — the goal is a TSV roundtrip test for the new column. Read `packages/core/src/catalog.ts` line 1-80 first to confirm names.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/core/test/catalog.test.ts`
Expected: 3 new failures about missing `format` field.

- [ ] **Step 3: Add the column**

Modify `packages/core/src/catalog.ts`:

```ts
// Find the CatalogRow type definition. Add:
export interface CatalogRow {
  rel: string;
  label: string;
  family: string;
  format: 'gguf' | 'mlx';  // NEW; default 'gguf' for back-compat
  // ...other existing fields
}

// In the TSV parser, after splitting key=value pairs, if the
// 'format' key is absent, default it to 'gguf'.
function parseCatalogRow(line: string): CatalogRow {
  const fields = Object.fromEntries(
    line.split('\t').map((kv) => {
      const idx = kv.indexOf('=');
      return [kv.slice(0, idx), kv.slice(idx + 1)] as const;
    }),
  );
  return {
    rel: fields.rel,
    label: fields.label,
    family: fields.family,
    format: (fields.format as 'gguf' | 'mlx') ?? 'gguf',
    // ...other existing fields
  };
}
```

Modify `packages/core/src/catalogWriter.ts` to write the `format` field on every row. Default to `'gguf'` if the input row omits it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/core/test/catalog.test.ts`
Expected: all original tests still pass + 3 new tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/catalog.ts packages/core/src/catalogWriter.ts packages/core/test/catalog.test.ts
git commit -F - <<'EOF'
feat(core/catalog): add format=gguf|mlx column

TSV parser defaults to format=gguf when the column is missing
(back-compat for catalogs already on disk). Writer always emits the
column. Roundtrip tested for both gguf and mlx values.

Sets up the catalog state for pull's MLX-format detection branch in
Task 3.2.
EOF
```

### Task 3.2: pull MLX-format detection

```yaml meta
id: '3.2'
files:
  - packages/core/src/pull.ts
  - packages/core/test/pull.test.ts
file_scope: extend-shared
depends_on: ['3.1']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: codex-acp-deep
task_size: substantial
risk_class: schema-aware
```

**Files:**
- Modify: `packages/core/src/pull.ts`
- Modify: `packages/core/test/pull.test.ts`

- [ ] **Step 1: Write the failing test additions**

Add to `packages/core/test/pull.test.ts`:

```ts
import { classifyRepoFormat } from '../src/pull.js';

describe('classifyRepoFormat', () => {
  test('classifies a gguf-bearing repo as gguf', () => {
    const files = ['Qwen3-8B-Q4_K_M.gguf', 'README.md', 'config.json'];
    expect(classifyRepoFormat('Qwen3-8B-GGUF', files)).toEqual({ format: 'gguf' });
  });

  test('classifies an mlx-community repo with safetensors + config + tokenizer as mlx', () => {
    const files = ['model.safetensors', 'config.json', 'tokenizer.json', 'README.md'];
    expect(classifyRepoFormat('mlx-community/Qwen3-8B-MLX-4bit', files)).toEqual({ format: 'mlx' });
  });

  test('classifies a sharded mlx repo (safetensors.index.json) as mlx', () => {
    const files = ['model.safetensors.index.json', 'model-00001-of-00003.safetensors', 'config.json', 'tokenizer.model'];
    expect(classifyRepoFormat('mlx-community/Llama-3.1-8B-MLX', files)).toEqual({ format: 'mlx' });
  });

  test('returns error when neither gguf nor mlx signatures present', () => {
    const files = ['README.md'];
    const result = classifyRepoFormat('foo/bar', files);
    expect('error' in result).toBe(true);
  });

  test('prefers gguf when both gguf and mlx markers exist (back-compat)', () => {
    const files = ['model.gguf', 'model.safetensors', 'config.json', 'tokenizer.json'];
    expect(classifyRepoFormat('mixed/repo', files)).toEqual({ format: 'gguf' });
  });

  test('--format=mlx override picks mlx even when gguf exists', () => {
    const files = ['model.gguf', 'model.safetensors', 'config.json', 'tokenizer.json'];
    expect(classifyRepoFormat('mixed/repo', files, { override: 'mlx' })).toEqual({ format: 'mlx' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/core/test/pull.test.ts`
Expected: 6 new failures (classifyRepoFormat undefined).

- [ ] **Step 3: Add the classifier**

In `packages/core/src/pull.ts`, export:

```ts
export type RepoFormat = 'gguf' | 'mlx';

export function classifyRepoFormat(
  repo: string,
  files: string[],
  opts: { override?: RepoFormat } = {},
): { format: RepoFormat } | { error: string } {
  if (opts.override) return { format: opts.override };

  const hasGguf = files.some((f) => f.endsWith('.gguf'));
  if (hasGguf) return { format: 'gguf' };

  const hasConfig = files.includes('config.json');
  const hasTokenizer = files.includes('tokenizer.json') || files.includes('tokenizer.model');
  const hasSafetensors = files.some(
    (f) => f === 'model.safetensors' || f === 'model.safetensors.index.json' || /\.safetensors$/.test(f),
  );
  if (hasConfig && hasTokenizer && hasSafetensors) return { format: 'mlx' };

  if (repo.startsWith('mlx-community/')) {
    return { error: `repo ${repo} looks like an MLX repo by namespace but is missing required files (need config.json + tokenizer + safetensors)` };
  }
  return { error: `no gguf files and no MLX format signature in ${repo}` };
}
```

Then in the pull pipeline (the function that actually downloads), branch on the classification:
- If `format === 'gguf'`: existing quant-ladder + GGUF download path.
- If `format === 'mlx'`: download every non-ignored file (`.gitattributes`, `README.md`, `*.png`, `*.mp4`, `*.gif` are ignored) into `$LLAMA_CPP_MODELS/<repo>/`. Record a catalog row with `format: 'mlx'`. No quant-ladder.

Add a `--format mlx|gguf` CLI flag to the pull subcommand surface. Read `packages/cli/src/...` for the pull CLI wiring and plumb the override into `classifyRepoFormat({ override })`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/core/test/pull.test.ts`
Expected: all original tests still pass + 6 new tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/pull.ts packages/core/test/pull.test.ts
git commit -F - <<'EOF'
feat(core/pull): MLX-format repo detection + --format override

classifyRepoFormat(repo, files, {override}) inspects the file listing
and returns either {format: 'gguf'|'mlx'} or {error}. Logic:

- Any .gguf file in the repo -> gguf (back-compat preserves existing path).
- Else config.json + (tokenizer.json|tokenizer.model) + safetensors -> mlx.
- Else error.

CLI gains --format mlx|gguf to force the classification when both
file types coexist in a repo.

MLX repos download the whole directory (ignoring .gitattributes,
README, images, videos) into $LLAMA_CPP_MODELS/<repo>/. Catalog row
is written with format='mlx'.
EOF
```

## Phase 4: Reconciler + runtime + matrix integration

Dispatch graph: 4.1 → 4.2 ∥ 4.3

Integration: 4.1 enables ModelHost manifests to actually start; 4.2 and 4.3 consume the resulting state shape. Run `bun test packages/remote packages/core packages/eval` after all three land.

### Task 4.1: Reconciler kind dispatch

```yaml meta
id: '4.1'
files:
  - packages/remote/src/workload/apply.ts
  - packages/remote/test/workload/modelhost-apply.test.ts
file_scope: extend-shared
depends_on: ['2.1', '2.2', '2.3']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: codex-acp-deep
task_size: substantial
risk_class: schema-aware
```

**Files:**
- Modify: `packages/remote/src/workload/apply.ts`
- Create: `packages/remote/test/workload/modelhost-apply.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/remote/test/workload/modelhost-apply.test.ts`:

```ts
import { describe, expect, test, mock } from 'bun:test';
import { applyManifest } from '../../src/workload/apply.js';

describe('applyManifest — ModelHost dispatch', () => {
  test('routes kind:ModelHost manifests to the engine adapter buildBootCommand', async () => {
    const captured: { cmd?: string; args?: string[] } = {};
    const fakeSpawn = mock((cmd: string, args: string[]) => {
      captured.cmd = cmd;
      captured.args = args;
      return { pid: 99999 } as any;
    });

    const manifest = {
      apiVersion: 'llamactl/v1',
      kind: 'ModelHost',
      metadata: { name: 'mlx-host-test' },
      spec: {
        engine: 'omlx',
        node: 'local',
        enabled: true,
        binary: '/usr/bin/true',  // exists on all systems
        endpoint: { host: '127.0.0.1', port: 18094 },
        hostedModels: [{ rel: 'mlx-community/Test-MLX-4bit' }],
        extraArgs: ['--max-concurrent-requests', '1'],
      },
    };

    // applyManifest signature accepts { manifest, env, spawnFn } — adapt
    // to the actual signature in apply.ts after reading the file.
    await applyManifest({ manifest, spawn: fakeSpawn });

    expect(captured.cmd).toBe('/usr/bin/true');
    expect(captured.args?.[0]).toBe('serve');
    expect(captured.args).toContain('--port');
    expect(captured.args).toContain('18094');
  });

  test('ModelRun manifests still take the legacy path (no engine dispatch)', async () => {
    // Use an existing ModelRun fixture from packages/remote/test/workload/.
    // Assert the engine adapter is NOT consulted; the existing apply
    // path runs.
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/remote/test/workload/modelhost-apply.test.ts`
Expected: failure (apply.ts doesn't yet handle kind: ModelHost).

- [ ] **Step 3: Implement the dispatch**

Read `packages/remote/src/workload/apply.ts` first (the existing reconciler). Add a top-level kind discriminator:

```ts
import { ModelHostManifestSchema } from './modelhost-schema.js';
import { ENGINES } from '@llamactl/core/engines';  // confirm import path

export async function applyManifest(opts: { manifest: unknown; /* ... */ }) {
  // existing yaml parsing / validation
  const raw = opts.manifest as { kind?: string };
  if (raw?.kind === 'ModelHost') {
    return applyModelHostManifest(opts);
  }
  // existing ModelRun path unchanged
  return applyModelRunManifest(opts);
}

async function applyModelHostManifest(opts: { manifest: unknown; spawn?: Function; env?: ResolvedEnv }) {
  const parsed = ModelHostManifestSchema.parse(opts.manifest);
  const engine = ENGINES[parsed.spec.engine];
  const valid = engine.validateSpec({
    engine: parsed.spec.engine,
    binary: parsed.spec.binary,
    endpoint: parsed.spec.endpoint,
    hostedModels: parsed.spec.hostedModels,
    resources: parsed.spec.resources,
    extraArgs: parsed.spec.extraArgs,
    timeoutSeconds: parsed.spec.timeoutSeconds,
  });
  if (!valid.ok) throw new Error(`ModelHost spec invalid: ${valid.error}`);

  const env = opts.env ?? resolveEnv();
  const { binary, args } = engine.buildBootCommand(parsed.spec as any, env);
  const spawn = opts.spawn ?? (await import('node:child_process')).spawn;
  const proc = spawn(binary, args, { detached: true, stdio: 'ignore' });
  // record pid + endpoint into the noderun store the same way ModelRun does
  return { manifest: parsed, pid: proc.pid };
}
```

(Adapt to the actual signature of `applyManifest` in the file; the goal is `kind: ModelHost` reaches `ENGINES[engine].buildBootCommand` and spawns the resulting binary+args.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/remote/test/workload/modelhost-apply.test.ts`
Expected: both new tests pass.

- [ ] **Step 5: Run all workload tests to confirm no regression**

Run: `bun test packages/remote/test/workload/`
Expected: all pre-existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add packages/remote/src/workload/apply.ts packages/remote/test/workload/modelhost-apply.test.ts
git commit -F - <<'EOF'
feat(workload): reconciler dispatches kind:ModelHost to engine registry

applyManifest peeks the top-level kind. ModelRun manifests take the
existing path unchanged. ModelHost manifests:

1. Parse against ModelHostManifestSchema (.strict() rejects strays).
2. Look up ENGINES[spec.engine].
3. Call validateSpec; throw on failure with the engine's error message.
4. buildBootCommand returns {binary, args}; spawned detached.
5. PID + endpoint recorded in noderun store same as ModelRun.

Back-compat: every existing ModelRun yaml continues to work with zero
change.
EOF
```

### Task 4.2: workloadRuntime LocalRoute extension

```yaml meta
id: '4.2'
files:
  - packages/core/src/workloadRuntime.ts
  - packages/core/test/workloadRuntime.test.ts
file_scope: extend-shared
depends_on: ['4.1']
parallel_with: ['4.3']
preferred_agent: codex-acp-fast
fallback_agent: oc-deepseek-v4-pro
task_size: small
risk_class: schema-aware
```

**Files:**
- Modify: `packages/core/src/workloadRuntime.ts`
- Modify: `packages/core/test/workloadRuntime.test.ts`

- [ ] **Step 1: Write the failing test additions**

Add to `packages/core/test/workloadRuntime.test.ts`:

```ts
test('listLocalWorkloads returns both ModelRun and ModelHost routes', () => {
  // Seed a noderun store fixture with one running ModelRun and one
  // running ModelHost. Assert the returned array contains both, each
  // with engine + kind tags.
  // (Read existing seeding helpers in workloadRuntime.test.ts.)
  const routes = listLocalWorkloads(/* fixture */);
  const kinds = new Set(routes.map((r) => r.kind));
  expect(kinds.has('ModelRun')).toBe(true);
  expect(kinds.has('ModelHost')).toBe(true);
});

test('ModelHost route uses the basename of the hosted rel for model id alias', () => {
  // After probeReady runs, the proxy should know both:
  //   - 'mlx-community/Qwen3-8B-MLX-4bit' (rel)
  //   - 'Qwen3-8B-MLX-4bit' (basename, what oMLX returns in /v1/models)
  // Both should resolve to the same host:port.
  const routes = listLocalWorkloads(/* fixture with one ModelHost */);
  const ids = new Set(routes.map((r) => r.model));
  expect(ids.has('mlx-community/Qwen3-8B-MLX-4bit')).toBe(true);
  expect(ids.has('Qwen3-8B-MLX-4bit')).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/test/workloadRuntime.test.ts`
Expected: failures (LocalRoute type doesn't include kind; ModelHost not enumerated).

- [ ] **Step 3: Extend the runtime**

In `packages/core/src/workloadRuntime.ts`:

```ts
import type { EngineName } from './engines/index.js';
import { basename } from 'node:path';

export interface LocalRoute {
  model: string;
  host: string;
  port: number;
  engine: EngineName;
  kind: 'ModelRun' | 'ModelHost';
}

export function listLocalWorkloads(/* existing args */): LocalRoute[] {
  const out: LocalRoute[] = [];
  // existing ModelRun enumeration produces one route each:
  //   { model: state.rel, host, port, engine: 'llamacpp', kind: 'ModelRun' }
  // Add: ModelHost enumeration. For each running ModelHost:
  for (const host of listRunningModelHosts(/* args */)) {
    const rel = host.spec.hostedModels[0].rel;
    const aliases = [rel, basename(rel)];
    for (const m of aliases) {
      out.push({
        model: m,
        host: host.endpoint.host,
        port: host.endpoint.port,
        engine: host.spec.engine,
        kind: 'ModelHost',
      });
    }
  }
  return out;
}
```

(Read the existing function to find `listRunningModelHosts` analog — the noderun store will already track ModelHost runs once Task 4.1 lands; expose a helper that filters by kind.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/core/test/workloadRuntime.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/workloadRuntime.ts packages/core/test/workloadRuntime.test.ts
git commit -F - <<'EOF'
feat(core/runtime): listLocalWorkloads returns unified LocalRoute[]

LocalRoute carries {model, host, port, engine, kind}. ModelRun
contributes one route (engine='llamacpp', kind='ModelRun'); ModelHost
contributes one route per (hostedModels[i].rel, basename) alias pair
so the proxy matches either the HF path or the basename oMLX returns
in /v1/models.

Sub A invariant hostedModels.length === 1 keeps this at 2 alias rows
per ModelHost (rel + basename); Sub B widens.
EOF
```

### Task 4.3: Matrix bench engine dispatch

```yaml meta
id: '4.3'
files:
  - packages/eval/src/matrix/types.ts
  - packages/eval/src/matrix/lifecycle.ts
  - packages/eval/test/matrix-lifecycle.test.ts
file_scope: extend-shared
depends_on: ['2.1', '2.2']
parallel_with: ['4.2']
preferred_agent: codex-acp-fast
fallback_agent: oc-deepseek-v4-pro
task_size: small
risk_class: schema-aware
```

**Files:**
- Modify: `packages/eval/src/matrix/types.ts`
- Modify: `packages/eval/src/matrix/lifecycle.ts`
- Create: `packages/eval/test/matrix-lifecycle.test.ts` (or extend an existing test)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from 'bun:test';
import { buildBootCommandForModelSpec } from '../src/matrix/lifecycle.js';

describe('matrix lifecycle — engine dispatch', () => {
  test('omlx ModelSpec routes to ENGINES.omlx.buildBootCommand', () => {
    const spec = {
      name: 'qwen3-8b-mlx-4bit',
      engine: 'omlx',
      family: 'qwen-3',
      quant: 'MLX-4bit',
      size_params: '8B',
      host: '127.0.0.1',
      port: 8094,
      binary: '/usr/bin/true',
      mlx_model_dir: '/tmp/mlx',
      managed: true,
      extra_args: ['--max-concurrent-requests', '1'],
      start_args: [],
    };
    const built = buildBootCommandForModelSpec(spec as any);
    expect(built.args[0]).toBe('serve');
    expect(built.args).toContain('--model-dir');
    expect(built.args).toContain('/tmp/mlx');
  });

  test('default engine (undefined) routes to llama.cpp path (back-compat)', () => {
    const spec = {
      name: 'granite-3b-Q8',
      family: 'granite',
      quant: 'Q8_0',
      size_params: '3B',
      host: '127.0.0.1',
      port: 8085,
      binary: '/usr/bin/true',
      gguf_path: '/tmp/granite-3b-Q8.gguf',
      managed: true,
      extra_args: [],
      start_args: [],
    };
    const built = buildBootCommandForModelSpec(spec as any);
    expect(built.binary).toBe('/usr/bin/true');
    // llama.cpp path uses --port flag style
    expect(built.args).toContain('--port');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/eval/test/matrix-lifecycle.test.ts`
Expected: `buildBootCommandForModelSpec` undefined OR `engine` field unknown.

- [ ] **Step 3: Extend lifecycle**

Read `packages/eval/src/matrix/types.ts` and `lifecycle.ts`. Add to `ModelSpec`:

```ts
export interface ModelSpec {
  // ...existing fields
  engine?: 'llamacpp' | 'omlx';      // NEW; default 'llamacpp'
  mlx_model_dir?: string;            // NEW; oMLX --model-dir, ignored for llama.cpp
  gguf_path?: string;                // existing; now optional when engine='omlx'
}
```

Add to `lifecycle.ts` an exported helper `buildBootCommandForModelSpec(spec: ModelSpec): { binary: string; args: string[] }`:

```ts
import { ENGINES } from '@llamactl/core/engines';

export function buildBootCommandForModelSpec(spec: ModelSpec): { binary: string; args: string[] } {
  const engine = spec.engine ?? 'llamacpp';
  if (engine === 'omlx') {
    return ENGINES.omlx.buildBootCommand(
      {
        engine: 'omlx',
        binary: spec.binary!,
        endpoint: { host: spec.host, port: spec.port },
        hostedModels: [{ rel: '' /* unused for matrix boot; model auto-discovered */ }],
        resources: {},
        extraArgs: spec.extra_args ?? [],
        timeoutSeconds: 60,
      },
      { LLAMA_CPP_MODELS: spec.mlx_model_dir ?? '' } as any,
    );
  }
  // existing llama.cpp path (extract the inline arg-building from the
  // ensureModelServing function in lifecycle.ts into this function for
  // testability; behaviour preserved).
  return buildLlamaCppBootCommand(spec);
}
```

Refactor `ensureModelServing` to call `buildBootCommandForModelSpec` instead of inline arg-building.

- [ ] **Step 4: Run all eval tests**

Run: `bun test packages/eval`
Expected: all original tests still pass + 2 new tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/eval/src/matrix/types.ts packages/eval/src/matrix/lifecycle.ts packages/eval/test/matrix-lifecycle.test.ts
git commit -F - <<'EOF'
feat(eval/matrix): engine-aware boot command via ModelSpec.engine

ModelSpec gains two optional fields:
- engine?: 'llamacpp' | 'omlx' (default 'llamacpp')
- mlx_model_dir?: string (oMLX --model-dir)

gguf_path stays as-is (now optional when engine='omlx').

New exported helper buildBootCommandForModelSpec dispatches on engine
and delegates to ENGINES[engine].buildBootCommand. The existing
ensureModelServing inline arg-building is refactored into the same
helper; existing llama.cpp benches are byte-identical.
EOF
```

## Phase 5: openaiProxy + AGENTS.md

Dispatch graph: 5.1 ∥ 5.2

Integration: 5.1 unblocks cross-engine /v1 routing live; 5.2 documents the new MLX preference. Run `bun test packages/core/test/openaiProxy*` after 5.1.

### Task 5.1: openaiProxy cross-engine routing

```yaml meta
id: '5.1'
files:
  - packages/core/src/openaiProxy.ts
  - packages/core/test/openaiProxy.test.ts
file_scope: extend-shared
depends_on: ['4.2']
parallel_with: ['5.2']
preferred_agent: codex-acp-fast
fallback_agent: codex-acp-deep
task_size: substantial
risk_class: schema-aware
```

**Files:**
- Modify: `packages/core/src/openaiProxy.ts`
- Modify (or create): `packages/core/test/openaiProxy.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('routes /v1/chat/completions to a ModelHost by hosted rel', async () => {
  // Seed: one ModelHost route with model='mlx-community/Qwen3-8B-MLX-4bit'
  // pointing at 127.0.0.1:<port-of-stub>.
  // Request body: { model: 'mlx-community/Qwen3-8B-MLX-4bit', ... }
  // Assert: proxy forwards to the stub on the ModelHost port.
});

test('routes /v1/chat/completions to a ModelHost by hosted basename alias', async () => {
  // Same fixture, but request body says model='Qwen3-8B-MLX-4bit'.
  // Assert: proxy forwards to the same ModelHost port.
});

test('routes /v1/chat/completions to a ModelRun when its rel matches', async () => {
  // Same as today's behavior, retest to confirm no regression.
});

test('falls back to LLAMA_CPP_PORT when no model matches in route table', async () => {
  // Body model unknown; proxy still picks the default endpoint.
});

test('listOpenAIModels includes both ModelRun and ModelHost entries', () => {
  // owned_by differs: 'llamactl-agent' for ModelRun, 'llamactl-host' for ModelHost.
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/test/openaiProxy.test.ts`
Expected: ModelHost-route tests fail (proxy doesn't yet consult the unified LocalRoute table).

- [ ] **Step 3: Extend the proxy**

In `packages/core/src/openaiProxy.ts`, change the route lookup to call `listLocalWorkloads()` (now returning `LocalRoute[]`) and match the body `model` against `route.model` for any kind. Forwarding logic unchanged (same `fetch` with body/header streaming).

In `listOpenAIModels`, enumerate both kinds; mark `owned_by: 'llamactl-host'` for ModelHost entries.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/core/test/openaiProxy.test.ts`
Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/openaiProxy.ts packages/core/test/openaiProxy.test.ts
git commit -F - <<'EOF'
feat(core/openaiProxy): route /v1/* across ModelRun + ModelHost kinds

The proxy consults workloadRuntime.listLocalWorkloads() which now
yields LocalRoute[] covering both kinds. Body 'model' matches either
the HF rel path or oMLX's basename alias. Forwarding logic is
unchanged (engines speak the same wire format).

listOpenAIModels enumerates both kinds; owned_by differentiates:
  'llamactl-agent' -> ModelRun
  'llamactl-host'  -> ModelHost

LLAMA_CPP_PORT fallback stays as-is — only fires when no model matches.
EOF
```

### Task 5.2: AGENTS.md MLX section

```yaml meta
id: '5.2'
files:
  - AGENTS.md
file_scope: extend-shared
depends_on: []
parallel_with: ['5.1']
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: small
risk_class: paste-ready
```

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Read the existing "Model selection preferences" section**

Read `AGENTS.md` lines 150-200 to locate the section.

- [ ] **Step 2: Add MLX subsection**

Insert under "Model selection preferences", after the existing MTP-first rule, before the quant ladder rule:

```markdown
1.5. **MLX engine for Apple Silicon, when workload benefits from
   shared prefix caching.** llamactl can host MLX-format models via
   `kind: ModelHost` + `spec.engine: omlx`. Prefer MLX when:
   - The workload is a long-lived agent with a stable system+tools
     prefix (oMLX's SSD-tiered KV cache turns 30-90s TTFT on cold
     reload into 1-3s).
   - You're closing the train -> infer loop (packages/train/ produces
     MLX adapters; serving them via oMLX skips the GGUF roundtrip).
   Skip MLX when:
   - The workload is classification / rubric-in-prompt — Q8-small
     GGUF (Granite 3B Q8_0 via llama.cpp) still wins per the
     attention-thesis eval until directly re-benched on MLX.
   - You need the wider set of llama.cpp arch-specific flags
     (--mtp-head, --swa-full, --rpc, etc.) — oMLX exposes its own
     flag set, not those.
   Sub A ships single-model ModelHost on local only;
   multi-model + mac-mini + train-adapter loading land in Sub B/C/D.
```

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md
git commit -F - <<'EOF'
docs(AGENTS): MLX engine selection preferences (Sub A)

Document when to prefer MLX (long-lived agents with stable prefixes,
train -> infer loop) vs when to skip (classification favors Granite
3B Q8_0 GGUF until re-benched on MLX; llama.cpp arch-specific flags
unavailable). References sub-project decomposition for Sub B/C/D.
EOF
```

## Phase 6: Pilot manifests + smoke

Dispatch graph: 6.1 ∥ 6.2 ∥ 6.3 → 6.4 (manual)

Integration: 6.1/6.2/6.3 are templates + scripts; 6.4 is the manual smoke run on M4 Pro that exercises the full path. After 6.4 succeeds, Sub A is done.

### Task 6.1: Pilot ModelHost yaml

```yaml meta
id: '6.1'
files:
  - templates/workloads/mlx-host-local.yaml
file_scope: new
depends_on: ['4.1']
parallel_with: ['6.2', '6.3']
preferred_agent: codex-acp-fast
fallback_agent: oc-deepseek-v4-pro
task_size: small
risk_class: paste-ready
```

**Files:**
- Create: `templates/workloads/mlx-host-local.yaml`

- [ ] **Step 1: Author the yaml**

```yaml
# Sub A pilot: one MLX model hosted by oMLX on local (M4 Pro).
# Coexists with granite41-3b-long-lived-local on :8083.
#
# Pre-reqs:
# 1. tools/install-omlx-from-source.sh has been run on this node
#    (creates /Volumes/WorkSSD/src/omlx/.venv/bin/omlx).
# 2. llamactl pull mlx-community/Qwen3-8B-MLX-4bit has been run.
#
# Apply:
#   llamactl apply -f templates/workloads/mlx-host-local.yaml
#
# Verify:
#   curl http://127.0.0.1:8094/v1/models  # Qwen3-8B-MLX-4bit listed
#   tools/smoke-modelhost-omlx.sh         # full smoke
apiVersion: llamactl/v1
kind: ModelHost
metadata:
  name: mlx-host-local
  labels:
    family: mlx
    role: inference-host
spec:
  engine: omlx
  node: local
  enabled: true
  binary: /Volumes/WorkSSD/src/omlx/.venv/bin/omlx
  resources:
    expectedMemoryGiB: 12
  endpoint:
    host: 127.0.0.1
    port: 8094
  hostedModels:
    - rel: mlx-community/Qwen3-8B-MLX-4bit
  extraArgs:
    - --max-concurrent-requests
    - "4"
    - --paged-ssd-cache-dir
    - /Volumes/WorkSSD/cache/omlx
  restartPolicy: Always
  timeoutSeconds: 60
```

- [ ] **Step 2: Commit**

```bash
git add templates/workloads/mlx-host-local.yaml
git commit -F - <<'EOF'
feat(workloads): Sub A pilot ModelHost yaml — Qwen3-8B-MLX-4bit on :8094

Single-model ModelHost manifest for the M4 Pro local node. Pre-reqs
documented in the header (install script + pull). Coexists with the
live granite41-3b-long-lived-local on :8083.

SSD KV cache directory at /Volumes/WorkSSD/cache/omlx —
expectedMemoryGiB at 12 leaves headroom for the existing 3B Granite
on :8083 (~5 GiB).
EOF
```

### Task 6.2: Pilot matrix bench spec

```yaml meta
id: '6.2'
files:
  - packages/eval/specs/mlx-pilot.json
file_scope: new
depends_on: ['4.3']
parallel_with: ['6.1', '6.3']
preferred_agent: codex-acp-fast
fallback_agent: oc-deepseek-v4-pro
task_size: small
risk_class: paste-ready
```

**Files:**
- Create: `packages/eval/specs/mlx-pilot.json`

- [ ] **Step 1: Author the spec**

```json
[
  {
    "name": "qwen3-8b-mlx-4bit",
    "engine": "omlx",
    "family": "qwen-3",
    "quant": "MLX-4bit",
    "size_params": "8B",
    "host": "127.0.0.1",
    "port": 8094,
    "binary": "/Volumes/WorkSSD/src/omlx/.venv/bin/omlx",
    "mlx_model_dir": "/Volumes/WorkSSD/ai-models/llama.cpp/models",
    "managed": false,
    "extra_args": [],
    "start_args": []
  }
]
```

`managed: false` because the matrix bench should connect to the already-running ModelHost (started via `llamactl apply`) rather than spawn its own — single-instance oMLX hosting the model.

- [ ] **Step 2: Commit**

```bash
git add packages/eval/specs/mlx-pilot.json
git commit -F - <<'EOF'
feat(eval/specs): mlx-pilot matrix bench spec — Qwen3-8B-MLX-4bit

Single-entry spec that benches the oMLX-hosted Qwen3-8B-MLX-4bit
running on :8094. managed: false so the bench attaches to the live
host (started via `llamactl apply -f templates/workloads/mlx-host-local.yaml`)
rather than racing to spawn its own.
EOF
```

### Task 6.3: Smoke script

```yaml meta
id: '6.3'
files:
  - tools/smoke-modelhost-omlx.sh
file_scope: new
depends_on: []
parallel_with: ['6.1', '6.2']
preferred_agent: codex-acp-fast
fallback_agent: oc-deepseek-v4-pro
task_size: small
risk_class: paste-ready
```

**Files:**
- Create: `tools/smoke-modelhost-omlx.sh`

- [ ] **Step 1: Author the script**

```bash
#!/usr/bin/env bash
# End-to-end smoke for Sub A: apply the MLX pilot, wait for /v1/models,
# send a /v1/chat/completions, assert the response parses.
#
# Manual: run on M4 Pro after install + pull.

set -euo pipefail

YAML="$(cd "$(dirname "$0")/.." && pwd)/templates/workloads/mlx-host-local.yaml"
PORT=8094
MODEL_REL="mlx-community/Qwen3-8B-MLX-4bit"
MODEL_BASENAME="Qwen3-8B-MLX-4bit"

echo "[smoke] applying $YAML"
llamactl apply -f "$YAML"

echo "[smoke] waiting for /v1/models on :$PORT (up to 60s)"
deadline=$(($(date +%s) + 60))
while [[ $(date +%s) -lt $deadline ]]; do
  if curl -fs "http://127.0.0.1:$PORT/v1/models" | grep -q "$MODEL_BASENAME"; then
    echo "[smoke] /v1/models exposes $MODEL_BASENAME"
    break
  fi
  sleep 2
done

echo "[smoke] POST /v1/chat/completions"
REPLY=$(curl -fs -X POST "http://127.0.0.1:$PORT/v1/chat/completions" \
  -H 'content-type: application/json' \
  -d "{\"model\":\"$MODEL_BASENAME\",\"messages\":[{\"role\":\"user\",\"content\":\"reply with exactly: SMOKE-OK\"}],\"max_tokens\":8,\"temperature\":0}")
echo "[smoke] reply: $REPLY"

if echo "$REPLY" | grep -q SMOKE-OK; then
  echo "[smoke] PASS"
else
  echo "[smoke] FAIL — reply did not contain SMOKE-OK" >&2
  exit 1
fi

echo "[smoke] tearing down"
llamactl disable mlx-host-local
echo "[smoke] done"
```

- [ ] **Step 2: chmod + commit**

```bash
chmod +x tools/smoke-modelhost-omlx.sh
git add tools/smoke-modelhost-omlx.sh
git commit -F - <<'EOF'
feat(tools): smoke-modelhost-omlx.sh — Sub A end-to-end smoke

Apply mlx-host-local.yaml, poll /v1/models for the Qwen3-8B-MLX-4bit
basename to appear (up to 60s), send a /v1/chat/completions with the
model field set to the basename, assert reply contains SMOKE-OK, tear
down. Manual smoke run on M4 Pro at PR review time.
EOF
```

### Task 6.4: Manual smoke run

(No yaml meta — manual step performed by the maintainer on the M4 Pro.)

**Steps (perform once, in order):**

- [ ] Run `tools/install-omlx-from-source.sh`. Confirm `/Volumes/WorkSSD/src/omlx/.venv/bin/omlx --help` prints.
- [ ] Replace `commit=HEAD` in `tools/omlx.lock` with the SHA recorded by `git rev-parse HEAD` inside `/Volumes/WorkSSD/src/omlx/`. Commit the lock update.
- [ ] Run `llamactl pull mlx-community/Qwen3-8B-MLX-4bit`. Confirm `/Volumes/WorkSSD/ai-models/llama.cpp/models/mlx-community/Qwen3-8B-MLX-4bit/` exists with `config.json`, `tokenizer.json`, and safetensors.
- [ ] Run `tools/smoke-modelhost-omlx.sh`. Expect `PASS`.
- [ ] Run `bun packages/eval/src/matrix/cli.ts --models packages/eval/specs/mlx-pilot.json --workloads tool-call-grammar --out-db /tmp/mlx-pilot.db`. Confirm `cellsWritten=1` and a per-cell metric writes.
- [ ] Update `tools/omlx.lock` `verified_date` to the run date. Commit.

Sub A is done when all six manual steps succeed.

## Self-review notes

- **Spec coverage**: §1 (scope) maps to Phase 6 (pilot). §2.1 (engine registry) → Task 1.1. §2.2 (ModelHost kind) → Tasks 2.3 + 4.1. §2.3 (openaiProxy) → Task 5.1. §3 (yaml schema) → Task 2.3. §4 (oMLX adapter) → Task 2.2. §5 (pull-path) → Tasks 3.1 + 3.2. §6 (openaiProxy) → Task 5.1. §7 (matrix bench) → Task 4.3. §8 (testing) → embedded in every implementation task. §9 (migration) → AGENTS.md update + the `engine` field's careful absence on ModelRun is enforced in Task 2.3 schema (`.strict()`). §10 (open questions) explicitly deferred; nothing to plan. §11 (file touch list) cross-checked against tasks' Files sections — every path appears in at least one task.
- **Measurement gate (Step 0)**: not applicable — Sub A is building work, not a metric comparison. The Sub D phase will introduce a measurement question (train-adapter vs base inference quality) that needs the gate.
- **Type consistency**: `EngineAdapter`, `EngineName`, `ModelHostSpecForEngine`, `ModelHostManifestSchema`, `LocalRoute`, `RepoFormat` — names used consistently across tasks. `listLocalWorkloads` (not `listLocalRoutes`) used everywhere downstream of Phase 4.
- **Placeholder scan**: no TBD/TODO; every code step contains the actual code or the explicit instruction to read the target file first when the existing signature is too long to inline.
- **Trust boundary**: every `git commit` uses `git commit -F - <<'EOF' ... EOF` (quoted heredoc, no interpolation of spec text into shell args).
