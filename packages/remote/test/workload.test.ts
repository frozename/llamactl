import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyOne } from "../src/workload/apply.js";
import { type ModelRun, ModelRunSchema } from "../src/workload/schema.js";
import {
  defaultWorkloadsDir,
  deleteWorkload,
  interpolateEnvRefs,
  listWorkloadNames,
  listWorkloads,
  loadWorkload,
  loadWorkloadByName,
  loadWorkloadByNameAny,
  parseManifestYaml,
  parseWorkload,
  saveWorkload,
  workloadPath,
} from "../src/workload/store.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llamactl-workloads-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const sampleYaml = `
apiVersion: llamactl/v1
kind: ModelRun
metadata:
  name: gemma-qa
  labels:
    env: dev
spec:
  node: gpu1
  target:
    kind: rel
    value: gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf
  extraArgs:
    - --ctx-size
    - "32768"
  restartPolicy: Always
  endpoint:
    host: 0.0.0.0
    port: 8080
`;

const minimalYaml = `
apiVersion: llamactl/v1
kind: ModelRun
metadata:
  name: minimal
spec:
  node: local
  target:
    value: foo/bar.gguf
`;

const multiNodeYaml = `
apiVersion: llamactl/v1
kind: ModelRun
metadata:
  name: llama-70b-split
spec:
  node: coordinator
  target:
    kind: rel
    value: llama-70b.gguf
  workers:
    - node: gpu-worker-1
      rpcHost: 10.0.0.21
      rpcPort: 50052
    - node: gpu-worker-2
      rpcHost: 10.0.0.22
      rpcPort: 50052
  timeoutSeconds: 60
`;

describe("ModelRun schema", () => {
  test("parses a fully-specified manifest", () => {
    const m = parseWorkload(sampleYaml);
    expect(m.metadata.name).toBe("gemma-qa");
    expect(m.spec.node).toBe("gpu1");
    expect(m.spec.target.kind).toBe("rel");
    expect(m.spec.extraArgs).toEqual(["--ctx-size", "32768"]);
    expect(m.spec.restartPolicy).toBe("Always");
  });

  test("applies defaults to a minimal manifest", () => {
    const m = parseWorkload(minimalYaml);
    expect(m.spec.target.kind).toBe("rel");
    expect(m.spec.extraArgs).toEqual([]);
    expect(m.spec.restartPolicy).toBe("Always");
    expect(m.metadata.labels).toEqual({});
    expect(m.spec.timeoutSeconds).toBe(60);
  });

  test("defaults node to auto when omitted", () => {
    const withAuto = `
apiVersion: llamactl/v1
kind: ModelRun
metadata:
  name: auto-node
spec:
  target:
    kind: rel
    value: foo/bar.gguf
`;
    const m = parseWorkload(withAuto);
    expect(m.spec.node).toBe("auto");
    expect(m.spec.placement).toBeUndefined();
  });

  test("rejects a bad name", () => {
    const bad = sampleYaml.replace("name: gemma-qa", "name: Gemma-QA");
    expect(() => parseWorkload(bad)).toThrow(/lowercase alphanumeric/);
  });

  test("rejects wrong apiVersion", () => {
    const bad = sampleYaml.replace("apiVersion: llamactl/v1", "apiVersion: wrong");
    expect(() => parseWorkload(bad)).toThrow();
  });

  test("rejects wrong kind", () => {
    const bad = sampleYaml.replace("kind: ModelRun", "kind: Pod");
    expect(() => parseWorkload(bad)).toThrow();
  });

  test("round-trips through save + load", () => {
    const m = parseWorkload(sampleYaml);
    const path = saveWorkload(m, dir);
    const reloaded = loadWorkload(path);
    expect(reloaded).toEqual(m);
  });

  test("loadWorkloadByNameAny returns ModelRun for ModelRun yaml", () => {
    const m = parseWorkload(sampleYaml);
    saveWorkload(m, dir);
    const loaded = loadWorkloadByNameAny("gemma-qa", dir);
    expect(loaded.kind).toBe("ModelRun");
    expect(loaded.metadata.name).toBe("gemma-qa");
  });

  test("loadWorkloadByNameAny returns ModelHost for ModelHost yaml", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "llamactl-workloads-any-"));
    try {
      writeFileSync(
        join(dir2, "host.yaml"),
        `
apiVersion: llamactl/v1
kind: ModelHost
metadata:
  name: host
spec:
  engine: omlx
  node: local
  enabled: true
  binary: /tmp/omlx
  endpoint:
    host: 127.0.0.1
    port: 8080
  hostedModels:
    - rel: demo.gguf
  extraArgs: []
`,
      );
      const loaded = loadWorkloadByNameAny("host", dir2);
      expect(loaded.kind).toBe("ModelHost");
      expect(loaded.metadata.name).toBe("host");
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  test("parses a multi-node manifest with workers", () => {
    const m = parseWorkload(multiNodeYaml);
    expect(m.spec.node).toBe("coordinator");
    expect(m.spec.workers).toHaveLength(2);
    expect(m.spec.workers[0]).toEqual({
      node: "gpu-worker-1",
      rpcHost: "10.0.0.21",
      rpcPort: 50052,
      extraArgs: [],
      timeoutSeconds: 30,
    });
    expect(m.spec.workers[1]?.rpcHost).toBe("10.0.0.22");
  });

  test("rejects a worker with port out of range", () => {
    const bad = multiNodeYaml.replace("rpcPort: 50052", "rpcPort: 99999");
    expect(() => parseWorkload(bad)).toThrow();
  });

  test("defaults workers to [] when absent", () => {
    const m = parseWorkload(minimalYaml);
    expect(m.spec.workers).toEqual([]);
  });

  test("defaults spec.gateway to false", () => {
    const m = parseWorkload(minimalYaml);
    expect(m.spec.gateway).toBe(false);
  });

  test("parses a gateway workload manifest", () => {
    const gw = `
apiVersion: llamactl/v1
kind: ModelRun
metadata:
  name: register-gpt4o
spec:
  node: sirius-primary
  gateway: true
  target:
    kind: rel
    value: openai/gpt-4o
`;
    const m = parseWorkload(gw);
    expect(m.spec.gateway).toBe(true);
    expect(m.spec.node).toBe("sirius-primary");
    expect(m.spec.target.value).toBe("openai/gpt-4o");
  });
});

describe("applyOne gateway branch", () => {
  test("gateway workload returns Pending without calling the client", async () => {
    const manifest: ModelRun = {
      apiVersion: "llamactl/v1",
      kind: "ModelRun",
      metadata: { name: "register-gpt4o", labels: {}, annotations: {} },
      spec: {
        node: "sirius-primary",
        enabled: true,
        gateway: true,
        target: { kind: "rel", value: "openai/gpt-4o" },
        extraArgs: [],
        workers: [],
        restartPolicy: "Always",
        allowExternalBind: false,
        timeoutSeconds: 60,
      },
    };
    let clientCalls = 0;
    const events: { type: string; message: string }[] = [];
    const result = await applyOne(
      manifest,
      () => {
        clientCalls++;
        throw new Error("applyOne should not call getClient for gateway workloads");
      },
      (e) => events.push(e),
    );
    expect(clientCalls).toBe(0);
    expect(result.action).toBe("pending");
    expect(result.statusSection.phase).toBe("Pending");
    expect(result.statusSection.conditions[0]?.reason).toBe("GatewayRegistrationPending");
    expect(events[0]?.type).toBe("gateway-pending");
  });
});

describe("workload store", () => {
  test("defaultWorkloadsDir respects DEV_STORAGE", () => {
    expect(defaultWorkloadsDir({ DEV_STORAGE: "/foo" })).toBe("/foo/workloads");
  });

  test("defaultWorkloadsDir respects LLAMACTL_WORKLOADS_DIR", () => {
    expect(defaultWorkloadsDir({ LLAMACTL_WORKLOADS_DIR: "/explicit" })).toBe("/explicit");
  });

  test("save + load by name", () => {
    const m = parseWorkload(sampleYaml);
    saveWorkload(m, dir);
    const loaded = loadWorkloadByName("gemma-qa", dir);
    expect(loaded).toEqual(m);
  });

  test("listWorkloadNames empty dir returns []", () => {
    expect(listWorkloadNames(dir)).toEqual([]);
  });

  test("listWorkloadNames returns sorted names", () => {
    const m1 = parseWorkload(sampleYaml);
    saveWorkload(m1, dir);
    const m2 = parseWorkload(minimalYaml);
    saveWorkload(m2, dir);
    const extra = parseWorkload(sampleYaml.replace("name: gemma-qa", "name: alpha"));
    saveWorkload(extra, dir);
    expect(listWorkloadNames(dir)).toEqual(["alpha", "gemma-qa", "minimal"]);
  });

  test("listWorkloads returns parsed manifests", () => {
    saveWorkload(parseWorkload(sampleYaml), dir);
    const loaded = listWorkloads(dir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.metadata.name).toBe("gemma-qa");
  });

  test("listWorkloads warns on duplicate metadata.name manifests", () => {
    const duplicateAPath = join(dir, "dup-a.yaml");
    const duplicateBPath = join(dir, "dup-b.yaml");
    writeFileSync(duplicateAPath, sampleYaml.replace("name: gemma-qa", "name: duplicate"), "utf8");
    writeFileSync(duplicateBPath, minimalYaml.replace("name: minimal", "name: duplicate"), "utf8");
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const loaded = listWorkloads(dir);
      expect(loaded.map((m) => m.metadata.name)).toEqual(["duplicate", "duplicate"]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const warned = String(warnSpy.mock.calls[0]?.[0] ?? "");
      expect(warned).toContain("listWorkloads: duplicate metadata.name 'duplicate' in manifests:");
      expect(warned).toContain(duplicateAPath);
      expect(warned).toContain(duplicateBPath);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("listWorkloadNames ignores non-YAML files", () => {
    writeFileSync(join(dir, "readme.txt"), "hi", "utf8");
    saveWorkload(parseWorkload(sampleYaml), dir);
    expect(listWorkloadNames(dir)).toEqual(["gemma-qa"]);
  });

  test("deleteWorkload removes the file and returns true", () => {
    saveWorkload(parseWorkload(sampleYaml), dir);
    expect(deleteWorkload("gemma-qa", dir)).toBe(true);
    expect(listWorkloadNames(dir)).toEqual([]);
  });

  test("deleteWorkload returns false when absent", () => {
    expect(deleteWorkload("missing", dir)).toBe(false);
  });

  test("loadWorkload throws on missing path", () => {
    expect(() => loadWorkload(join(dir, "nope.yaml"))).toThrow(/not found/);
  });

  test("workloadPath composes the filename from the metadata name", () => {
    expect(workloadPath("foo", dir)).toBe(join(dir, "foo.yaml"));
  });

  test("saveWorkload rewrites an existing manifest in place", () => {
    const a = parseWorkload(sampleYaml);
    saveWorkload(a, dir);
    const b: ModelRun = {
      ...a,
      spec: { ...a.spec, extraArgs: ["--new"] },
    };
    saveWorkload(b, dir);
    const raw = readFileSync(workloadPath("gemma-qa", dir), "utf8");
    expect(raw).toContain("--new");
    expect(raw).not.toContain("--ctx-size");
  });

  test("ModelRunSchema round-trips via the exported schema object", () => {
    const m = parseWorkload(minimalYaml);
    const parsed = ModelRunSchema.parse(m);
    expect(parsed).toEqual(m);
  });
});

describe("interpolateEnvRefs", () => {
  test("substitutes ${env:VAR} against the supplied env", () => {
    const out = interpolateEnvRefs("binary: ${env:LLAMA_SERVER_BIN}", {
      LLAMA_SERVER_BIN: "/opt/llama/llama-server",
    });
    expect(out).toBe("binary: /opt/llama/llama-server");
  });

  test("throws when a referenced variable is not set", () => {
    expect(() => interpolateEnvRefs("binary: ${env:NOT_SET_VAR}", {})).toThrow(/env:NOT_SET_VAR/);
  });

  test("leaves text without env refs untouched", () => {
    const raw = "binary: /usr/local/bin/llama-server\nport: 8080\n";
    expect(interpolateEnvRefs(raw, {})).toBe(raw);
  });

  test("parseWorkload interpolates env refs before YAML parse", () => {
    const tmpl = sampleYaml.replace("spec:", "spec:\n  binary: ${env:LLAMA_SERVER_BIN}");
    const prior = process.env.LLAMA_SERVER_BIN;
    process.env.LLAMA_SERVER_BIN = "/opt/llama/llama-server";
    try {
      const m = parseWorkload(tmpl);
      expect(m.spec.binary).toBe("/opt/llama/llama-server");
    } finally {
      if (prior === undefined) delete process.env.LLAMA_SERVER_BIN;
      else process.env.LLAMA_SERVER_BIN = prior;
    }
  });
});

describe("parseManifestYaml", () => {
  test("interpolates env refs in nested ModelRun and ModelHost fields", () => {
    const prior = {
      MODEL_REL: process.env.MODEL_REL,
      MODELS_DIR: process.env.MODELS_DIR,
      HOST_BINARY: process.env.HOST_BINARY,
      HOST_REL: process.env.HOST_REL,
    };
    process.env.MODEL_REL = "/models/run.gguf";
    process.env.MODELS_DIR = "/srv/models";
    process.env.HOST_BINARY = "/usr/bin/llamactl-host";
    process.env.HOST_REL = "/models/host.gguf";
    try {
      const parsedRun = parseManifestYaml(`
apiVersion: llamactl/v1
kind: ModelRun
metadata:
  name: env-run
spec:
  node: local
  target:
    value: \${env:MODEL_REL}
  extraArgs:
    - --models-dir
    - \${env:MODELS_DIR}
`);
      expect(parsedRun).toMatchObject({
        spec: {
          target: { value: "/models/run.gguf" },
          extraArgs: ["--models-dir", "/srv/models"],
        },
      });

      const parsedHost = parseManifestYaml(`
apiVersion: llamactl/v1
kind: ModelHost
metadata:
  name: env-host
spec:
  engine: omlx
  node: local
  binary: \${env:HOST_BINARY}
  endpoint:
    host: 127.0.0.1
    port: 19090
  hostedModels:
    - rel: \${env:HOST_REL}
`);
      expect(parsedHost).toMatchObject({
        spec: {
          binary: "/usr/bin/llamactl-host",
          hostedModels: [{ rel: "/models/host.gguf" }],
        },
      });
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
