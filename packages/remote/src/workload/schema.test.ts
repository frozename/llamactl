import { expect, test } from "bun:test";

import { ModelHostManifestSchema } from "./modelhost-schema.js";
import { NodeRunSchema } from "./noderun-schema.js";
import { ModelRunSchema } from "./schema.js";

test("ModelRun parses spec.enabled defaulting to true", () => {
  const m = ModelRunSchema.parse({
    apiVersion: "llamactl/v1",
    kind: "ModelRun",
    metadata: { name: "a" },
    spec: { node: "local", target: { kind: "rel", value: "m.gguf" } },
  });
  expect(m.spec.enabled).toBe(true);
});

test("ModelRun accepts spec.enabled=false", () => {
  const m = ModelRunSchema.parse({
    apiVersion: "llamactl/v1",
    kind: "ModelRun",
    metadata: { name: "a" },
    spec: {
      node: "local",
      target: { kind: "rel", value: "m.gguf" },
      enabled: false,
    },
  });
  expect(m.spec.enabled).toBe(false);
});

test("ModelRun parses spec.resources.expectedMemoryGiB", () => {
  const m = ModelRunSchema.parse({
    apiVersion: "llamactl/v1",
    kind: "ModelRun",
    metadata: { name: "a" },
    spec: {
      node: "local",
      target: { kind: "rel", value: "m.gguf" },
      resources: { expectedMemoryGiB: 8.5 },
    },
  });
  expect(m.spec.resources?.expectedMemoryGiB).toBe(8.5);
});

test("ModelRun parses metadata.annotations defaulting to {}", () => {
  const m = ModelRunSchema.parse({
    apiVersion: "llamactl/v1",
    kind: "ModelRun",
    metadata: { name: "a", annotations: { "llamactl.io/evict": "old" } },
    spec: { node: "local", target: { kind: "rel", value: "m.gguf" } },
  });
  expect(m.metadata.annotations).toEqual({ "llamactl.io/evict": "old" });
});

test("ModelRun accepts spec.useProxy omitted (default false behavior)", () => {
  const m = ModelRunSchema.parse({
    apiVersion: "llamactl/v1",
    kind: "ModelRun",
    metadata: { name: "a" },
    spec: { node: "local", target: { kind: "rel", value: "m.gguf" } },
  });
  expect(m.spec.useProxy).toBeUndefined();
});

test("ModelRun accepts spec.useProxy=true", () => {
  const m = ModelRunSchema.parse({
    apiVersion: "llamactl/v1",
    kind: "ModelRun",
    metadata: { name: "a" },
    spec: {
      node: "local",
      target: { kind: "rel", value: "m.gguf" },
      useProxy: true,
    },
  });
  expect(m.spec.useProxy).toBe(true);
});

test("NodeRun parses spec.budget.memoryGiB", () => {
  const n = NodeRunSchema.parse({
    apiVersion: "llamactl/v1",
    kind: "NodeRun",
    metadata: { name: "a" },
    spec: {
      node: "local",
      budget: { memoryGiB: 16 },
    },
  });
  expect(n.spec.budget?.memoryGiB).toBe(16);
});

test("ModelHost accepts spec.useProxy omitted", () => {
  const m = ModelHostManifestSchema.parse({
    apiVersion: "llamactl/v1",
    kind: "ModelHost",
    metadata: { name: "a" },
    spec: {
      engine: "omlx",
      node: "local",
      binary: "/usr/local/bin/omlx",
      endpoint: { host: "127.0.0.1", port: 8123 },
      hostedModels: [{ rel: "m.gguf" }],
    },
  });
  expect(m.spec.useProxy).toBeUndefined();
});

test("ModelHost accepts spec.useProxy=true", () => {
  const m = ModelHostManifestSchema.parse({
    apiVersion: "llamactl/v1",
    kind: "ModelHost",
    metadata: { name: "a" },
    spec: {
      engine: "omlx",
      node: "local",
      binary: "/usr/local/bin/omlx",
      endpoint: { host: "127.0.0.1", port: 8123 },
      hostedModels: [{ rel: "m.gguf" }],
      useProxy: true,
    },
  });
  expect(m.spec.useProxy).toBe(true);
});

test("ModelHost accepts spec.useProxy=false", () => {
  const m = ModelHostManifestSchema.parse({
    apiVersion: "llamactl/v1",
    kind: "ModelHost",
    metadata: { name: "a" },
    spec: {
      engine: "omlx",
      node: "local",
      binary: "/usr/local/bin/omlx",
      endpoint: { host: "127.0.0.1", port: 8123 },
      hostedModels: [{ rel: "m.gguf" }],
      useProxy: false,
    },
  });
  expect(m.spec.useProxy).toBe(false);
});

test("ModelRun accepts spec.readiness with the ModelHost probe shape", () => {
  // Kills: readiness missing from ModelRunSpecSchema — zod strips the key
  // at base, so spec.readiness parses back undefined.
  const m = ModelRunSchema.parse({
    apiVersion: "llamactl/v1",
    kind: "ModelRun",
    metadata: { name: "a" },
    spec: {
      node: "local",
      target: { kind: "rel", value: "m.gguf" },
      readiness: { path: "/ready", expectJson: { status: "ready" } },
    },
  });
  expect((m.spec as { readiness?: unknown }).readiness).toEqual({
    path: "/ready",
    expectStatus: 200,
    expectJson: { status: "ready" },
  });
  const plain = ModelRunSchema.parse({
    apiVersion: "llamactl/v1",
    kind: "ModelRun",
    metadata: { name: "a" },
    spec: { node: "local", target: { kind: "rel", value: "m.gguf" } },
  });
  expect("readiness" in plain.spec).toBe(false);
});

test("ModelRun rejects malformed spec.readiness", () => {
  // Kills: readiness typed loosely (z.any, z.unknown, a passthrough or
  // non-strict object) instead of reusing the strict
  // ModelHostReadinessSchema — every case parses successfully at base.
  const malformed: Record<string, unknown>[] = [
    { path: "ready" },
    { path: "/ready", bogus: true },
    { path: "/ready", expectStatus: "200" },
    { path: "/ready", expectJson: { status: { nested: true } } },
  ];
  for (const readiness of malformed) {
    const parsed = ModelRunSchema.safeParse({
      apiVersion: "llamactl/v1",
      kind: "ModelRun",
      metadata: { name: "a" },
      spec: {
        node: "local",
        target: { kind: "rel", value: "m.gguf" },
        readiness,
      },
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) continue;
    const underReadiness = parsed.error.issues.some(
      (issue) => issue.path[0] === "spec" && issue.path[1] === "readiness",
    );
    expect(underReadiness).toBe(true);
  }
});
