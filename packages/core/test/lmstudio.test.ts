import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyImport, planImport, scanLMStudio } from '../src/lmstudio.js';
import { envForTemp, makeTempRuntime } from './helpers.js';

function makeLMTree(root: string): void {
  // Pick repo + file names that aren't already in the BUILTIN catalog
  // so the import plan surfaces them as fresh rels rather than skips.
  const acme = join(root, 'acme', 'ExampleLM-GGUF');
  mkdirSync(acme, { recursive: true });
  writeFileSync(join(acme, 'ExampleLM-UD-Q4_K_M.gguf'), 'demo');
  const widgets = join(root, 'widgets', 'TinyModel-GGUF', 'q8');
  mkdirSync(widgets, { recursive: true });
  writeFileSync(join(widgets, 'TinyModel-Q8_0.gguf'), 'demo');
}

describe('lmstudio.scanLMStudio', () => {
  let temp: ReturnType<typeof makeTempRuntime>;

  beforeEach(() => {
    temp = makeTempRuntime();
  });
  afterEach(() => temp.cleanup());

  test('returns null root when nothing matches', () => {
    const scan = scanLMStudio({ root: join(temp.devStorage, 'missing') });
    expect(scan.models).toHaveLength(0);
  });

  test('finds gguf files and derives repo + rel', () => {
    const root = join(temp.devStorage, 'lmstudio', 'models');
    makeLMTree(root);
    const scan = scanLMStudio({ root });
    expect(scan.root).toBe(root);
    expect(scan.models).toHaveLength(2);
    const acmeEntry = scan.models.find((m) => m.publisher === 'acme');
    expect(acmeEntry?.repo).toBe('acme/ExampleLM-GGUF');
    expect(acmeEntry?.rel).toBe('ExampleLM-GGUF/ExampleLM-UD-Q4_K_M.gguf');
    expect(acmeEntry?.sizeBytes).toBeGreaterThan(0);
  });
});

describe('lmstudio.planImport', () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    temp = makeTempRuntime();
    originalEnv = { ...process.env };
    for (const [k, v] of Object.entries(envForTemp(temp))) {
      if (v !== undefined) process.env[k] = v;
    }
  });
  afterEach(() => {
    process.env = originalEnv;
    temp.cleanup();
  });

  test('builds link-and-add items for fresh rels', () => {
    const root = join(temp.devStorage, 'lmstudio', 'models');
    makeLMTree(root);
    const plan = planImport({ root });
    expect(plan.root).toBe(root);
    expect(plan.items.every((i) => i.action === 'link-and-add')).toBe(true);
  });

  test('respects --no-link by returning `add` action', () => {
    const root = join(temp.devStorage, 'lmstudio', 'models');
    makeLMTree(root);
    const plan = planImport({ root, link: false });
    expect(plan.items.every((i) => i.action === 'add')).toBe(true);
  });
});

describe('lmstudio.applyImport', () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    temp = makeTempRuntime();
    originalEnv = { ...process.env };
    for (const [k, v] of Object.entries(envForTemp(temp))) {
      if (v !== undefined) process.env[k] = v;
    }
    mkdirSync(temp.runtimeDir, { recursive: true });
  });
  afterEach(() => {
    process.env = originalEnv;
    temp.cleanup();
  });

  test('symlinks each new gguf into $LLAMA_CPP_MODELS and adds a catalog row', async () => {
    const root = join(temp.devStorage, 'lmstudio', 'models');
    makeLMTree(root);
    const result = await applyImport({ root, apply: true });
    expect(result.errors).toEqual([]);
    expect(result.applied.length).toBe(2);

    const linkPath = join(temp.modelsDir, 'ExampleLM-GGUF', 'ExampleLM-UD-Q4_K_M.gguf');
    expect(existsSync(linkPath)).toBe(true);
    // Should be a symlink, not a copy.
    expect(statSync(linkPath).isFile()).toBe(true);

    const catalogFile = join(temp.runtimeDir, 'curated-models.tsv');
    expect(existsSync(catalogFile)).toBe(true);
  });

  test('skips models that already exist in the catalog', async () => {
    const root = join(temp.devStorage, 'lmstudio', 'models');
    makeLMTree(root);
    await applyImport({ root, apply: true });
    const second = await applyImport({ root, apply: true });
    expect(second.applied).toHaveLength(0);
    expect(second.skipped.every((s) => s.action === 'skip-already-catalogued')).toBe(true);
  });
});
