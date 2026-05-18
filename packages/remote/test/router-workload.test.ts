import { describe, expect, test } from 'bun:test';
import { router } from '../src/router.js';

describe('router workload validation', () => {
  test('accepts ModelRun manifests', async () => {
    const caller = router.createCaller({});
    const result = await caller.workloadValidate({
      yaml: `
apiVersion: llamactl/v1
kind: ModelRun
metadata:
  name: validate-run
spec:
  node: local
  target:
    value: foo/bar.gguf
`,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.kind).toBe('ModelRun');
    expect(result.manifest.metadata.name).toBe('validate-run');
  });

  test('accepts ModelHost manifests', async () => {
    const caller = router.createCaller({});
    const result = await caller.workloadValidate({
      yaml: `
apiVersion: llamactl/v1
kind: ModelHost
metadata:
  name: validate-host
spec:
  engine: omlx
  node: local
  binary: /usr/bin/true
  endpoint:
    host: 127.0.0.1
    port: 19091
  hostedModels:
    - rel: foo/bar.gguf
`,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.kind).toBe('ModelHost');
    expect(result.manifest.metadata.name).toBe('validate-host');
  });

  test('rejects unknown workload kinds with a clear error', async () => {
    const caller = router.createCaller({});
    const result = await caller.workloadValidate({
      yaml: `
apiVersion: llamactl/v1
kind: NotARealKind
metadata:
  name: broken
spec:
  node: local
`,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/unsupported workload kind/i);
  });
});
