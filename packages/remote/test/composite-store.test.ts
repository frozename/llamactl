import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compositePath,
  defaultCompositesDir,
  deleteComposite,
  listComposites,
  listCompositeNames,
  loadComposite,
  parseComposite,
  saveComposite,
} from '../src/composite/store.js';
import { CompositeSchema, type Composite } from '../src/composite/schema.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'llamactl-composite-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function sample(name: string): Composite {
  // Parse through the schema so `.default()` fields are populated in
  // the TS-typed output — test fixtures stay readable.
  return CompositeSchema.parse({
    apiVersion: 'llamactl/v1',
    kind: 'Composite',
    metadata: { name },
    spec: {
      services: [{ kind: 'chroma', name: 'kb', node: 'local' }],
      ragNodes: [
        {
          name: 'kb-node',
          node: 'local',
          binding: {
            provider: 'chroma',
            endpoint: 'http://localhost:8000',
          },
          backingService: 'kb',
        },
      ],
      dependencies: [
        {
          from: { kind: 'rag', name: 'kb-node' },
          to: { kind: 'service', name: 'kb' },
        },
      ],
    },
  });
}

describe('composite store — defaults', () => {
  test('defaultCompositesDir respects LLAMACTL_COMPOSITES_DIR override', () => {
    const env = { LLAMACTL_COMPOSITES_DIR: '/tmp/fake-composites' };
    expect(defaultCompositesDir(env as NodeJS.ProcessEnv)).toBe(
      '/tmp/fake-composites',
    );
  });

  test('defaultCompositesDir falls back to DEV_STORAGE', () => {
    const env = { DEV_STORAGE: '/tmp/dev-store' };
    expect(defaultCompositesDir(env as NodeJS.ProcessEnv)).toBe(
      '/tmp/dev-store/composites',
    );
  });

  test('compositePath joins dir + name', () => {
    expect(compositePath('foo', tmp)).toBe(join(tmp, 'foo.yaml'));
  });
});

describe('composite store — parse + save + load roundtrip', () => {
  test('parseComposite parses valid YAML', () => {
    const yaml = `
apiVersion: llamactl/v1
kind: Composite
metadata:
  name: test-a
spec:
  services:
    - kind: chroma
      name: kb
      node: local
`;
    const m = parseComposite(yaml);
    expect(m.metadata.name).toBe('test-a');
    expect(m.spec.services[0]?.name).toBe('kb');
  });

  test('parseComposite rejects a ModelRun-kinded file', () => {
    const yaml = `
apiVersion: llamactl/v1
kind: ModelRun
metadata:
  name: wrong-kind
spec:
  node: local
  target:
    kind: rel
    value: m.gguf
`;
    expect(() => parseComposite(yaml)).toThrow();
  });

  test('parseComposite rejects invalid YAML', () => {
    expect(() => parseComposite('not : : valid yaml :')).toThrow();
  });

  test('saveComposite writes to <dir>/<name>.yaml', () => {
    const m = sample('round-trip-a');
    const path = saveComposite(m, tmp);
    expect(path).toBe(join(tmp, 'round-trip-a.yaml'));
    expect(existsSync(path)).toBe(true);
    const body = readFileSync(path, 'utf8');
    expect(body).toContain('apiVersion: llamactl/v1');
    expect(body).toContain('kind: Composite');
    expect(body).toContain('name: round-trip-a');
  });

  test('save then load returns structurally equal manifest', () => {
    const m = sample('round-trip-b');
    saveComposite(m, tmp);
    const loaded = loadComposite('round-trip-b', tmp);
    expect(loaded).not.toBeNull();
    expect(loaded!.metadata.name).toBe(m.metadata.name);
    expect(loaded!.spec.services[0]?.name).toBe('kb');
    expect(loaded!.spec.ragNodes[0]?.backingService).toBe('kb');
    expect(loaded!.spec.dependencies[0]?.from.name).toBe('kb-node');
    expect(loaded!.spec.onFailure).toBe('rollback');
  });

  test('loadComposite returns null for missing name', () => {
    expect(loadComposite('does-not-exist', tmp)).toBeNull();
  });

  test('saveComposite refuses to persist an invalid manifest', () => {
    const bad = {
      ...sample('bad'),
      apiVersion: 'wrong/v1',
    } as unknown as Composite;
    expect(() => saveComposite(bad, tmp)).toThrow();
  });
});

describe('composite store — list + delete', () => {
  test('listComposites returns empty when dir missing', () => {
    expect(listComposites(join(tmp, 'missing-subdir'))).toEqual([]);
  });

  test('listCompositeNames returns sorted file basenames', () => {
    saveComposite(sample('bravo'), tmp);
    saveComposite(sample('alpha'), tmp);
    saveComposite(sample('charlie'), tmp);
    expect(listCompositeNames(tmp)).toEqual(['alpha', 'bravo', 'charlie']);
  });

  test('listComposites returns only kind=Composite manifests', () => {
    saveComposite(sample('one'), tmp);
    saveComposite(sample('two'), tmp);
    // Drop an unrelated YAML in the same directory — listComposites
    // must skip it silently.
    writeFileSync(
      join(tmp, 'workload.yaml'),
      `apiVersion: llamactl/v1
kind: ModelRun
metadata:
  name: not-a-composite
spec:
  node: local
  target: { kind: rel, value: m.gguf }
`,
      'utf8',
    );
    // And a random malformed file.
    writeFileSync(join(tmp, 'junk.yaml'), 'not valid yaml :: :', 'utf8');

    const all = listComposites(tmp);
    expect(all.map((c) => c.metadata.name).sort()).toEqual(['one', 'two']);
  });

  test('deleteComposite removes the file', () => {
    saveComposite(sample('to-delete'), tmp);
    expect(existsSync(join(tmp, 'to-delete.yaml'))).toBe(true);
    expect(deleteComposite('to-delete', tmp)).toBe(true);
    expect(existsSync(join(tmp, 'to-delete.yaml'))).toBe(false);
  });

  test('deleteComposite returns false when file is absent', () => {
    expect(deleteComposite('ghost', tmp)).toBe(false);
  });
});
