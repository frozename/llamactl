import type { NodeClient } from "@llamactl/remote";

import { noderunSchema } from "@llamactl/remote";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ALLOWED_PLATFORMS,
  type InfraPlatformKind,
  makeSpecArtifactResolver,
  nodeRunBudgetLookup,
  platformFromNodeFacts,
} from "../src/commands/noderun-helpers.js";
import { mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

/**
 * Pins noderun-helpers: os/arch to platform mapping, the spec-backed
 * artifact resolver (lazy, cached nodeFacts platform lookup and its error
 * messages) and the per-call NodeRun budget lookup. Every case injects a
 * fake NodeClient, a private packages dir and an explicit NodeRun list, so
 * nothing reads ~/.llamactl or the network.
 */

interface FakeFacts {
  os?: string;
  arch?: string;
}

interface QueryCounter {
  count: number;
}

const SHA_DIGIT: Record<InfraPlatformKind, string> = {
  "darwin-arm64": "a",
  "darwin-x64": "b",
  "linux-x64": "c",
  "linux-arm64": "d",
};

let packagesDir = "";

beforeEach(() => {
  packagesDir = mkdtempSync(join(tmpdir(), "noderun-helpers-"));
});

afterEach(() => {
  rmSync(packagesDir, { recursive: true, force: true });
});

function artifactUrl(pkg: string, version: string, platform: InfraPlatformKind): string {
  return `https://example.test/${pkg}-${version}-${platform}.tar.gz`;
}

// 64 hex chars, as InfraArtifactSchema requires; one digit per platform.
function artifactSha(platform: InfraPlatformKind): string {
  return SHA_DIGIT[platform].repeat(64);
}

// Writes <packagesDir>/<pkg>.yaml with one artifact per listed platform.
function writeSpec(pkg: string, versions: Record<string, InfraPlatformKind[]>): void {
  const lines: string[] = [`name: ${pkg}`, "versions:"];
  for (const [version, platforms] of Object.entries(versions)) {
    lines.push(`  ${version}:`, "    platforms:");
    for (const platform of platforms) {
      lines.push(
        `      ${platform}:`,
        `        url: ${artifactUrl(pkg, version, platform)}`,
        `        sha256: ${artifactSha(platform)}`,
      );
    }
  }
  writeFileSync(join(packagesDir, `${pkg}.yaml`), `${lines.join("\n")}\n`);
}

function fakeClient(facts: FakeFacts, calls: QueryCounter): NodeClient {
  return {
    nodeFacts: {
      query: (): Promise<FakeFacts> => {
        calls.count += 1;
        return Promise.resolve(facts);
      },
    },
  } as unknown as NodeClient;
}

// Awaits a lookup that must reject and returns the rejection message.
async function rejectionMessage(lookup: Promise<unknown>): Promise<string> {
  try {
    await lookup;
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected the artifact lookup to reject");
}

function makeNodeRun(name: string, memoryGiB?: number): noderunSchema.NodeRun {
  const spec = memoryGiB === undefined ? { node: name } : { node: name, budget: { memoryGiB } };
  return noderunSchema.NodeRunSchema.parse({
    apiVersion: "llamactl/v1",
    kind: "NodeRun",
    metadata: { name },
    spec,
  });
}

describe("platformFromNodeFacts", () => {
  test("maps the four supported os/arch pairs and returns null for anything else", () => {
    const rows: { facts: FakeFacts; expected: InfraPlatformKind | null }[] = [
      { facts: { os: "darwin", arch: "arm64" }, expected: "darwin-arm64" },
      { facts: { os: "darwin", arch: "x64" }, expected: "darwin-x64" },
      { facts: { os: "linux", arch: "x64" }, expected: "linux-x64" },
      { facts: { os: "linux", arch: "arm64" }, expected: "linux-arm64" },
      { facts: { os: "win32", arch: "x64" }, expected: null },
      { facts: { os: "linux", arch: "ia32" }, expected: null },
      { facts: {}, expected: null },
      { facts: { os: "darwin" }, expected: null },
    ];
    expect(rows.map((row) => platformFromNodeFacts(row.facts))).toEqual(
      rows.map((row) => row.expected),
    );
  });

  test("ALLOWED_PLATFORMS lists exactly the four platform kinds in order", () => {
    expect(ALLOWED_PLATFORMS).toEqual(["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"]);
  });
});

describe("makeSpecArtifactResolver", () => {
  test("a platform override skips nodeFacts and returns that platform's artifact", async () => {
    writeSpec("llama-cpp", { b4500: ["darwin-arm64", "darwin-x64", "linux-x64"] });
    const calls: QueryCounter = { count: 0 };
    const resolve = makeSpecArtifactResolver({
      client: fakeClient({ os: "linux", arch: "x64" }, calls),
      packagesDir,
      platform: "darwin-x64",
    });
    const artifact = await resolve({ pkg: "llama-cpp", version: "b4500" });
    expect(artifact).toEqual({
      tarballUrl: artifactUrl("llama-cpp", "b4500", "darwin-x64"),
      sha256: artifactSha("darwin-x64"),
    });
    expect(calls.count).toBe(0);
  });

  test("queries nodeFacts lazily, once, and reuses the platform across packages", async () => {
    writeSpec("llama-cpp", { b4500: ["darwin-arm64", "linux-arm64"] });
    writeSpec("embersynth", { v2: ["darwin-arm64", "linux-arm64"] });
    const calls: QueryCounter = { count: 0 };
    const resolve = makeSpecArtifactResolver({
      client: fakeClient({ os: "linux", arch: "arm64" }, calls),
      packagesDir,
    });
    expect(calls.count).toBe(0);
    const first = await resolve({ pkg: "llama-cpp", version: "b4500" });
    const second = await resolve({ pkg: "embersynth", version: "v2" });
    expect(first).toEqual({
      tarballUrl: artifactUrl("llama-cpp", "b4500", "linux-arm64"),
      sha256: artifactSha("linux-arm64"),
    });
    expect(second).toEqual({
      tarballUrl: artifactUrl("embersynth", "v2", "linux-arm64"),
      sha256: artifactSha("linux-arm64"),
    });
    expect(calls.count).toBe(1);
  });

  test("concurrent lookups share one nodeFacts query", async () => {
    writeSpec("llama-cpp", { b4500: ["darwin-arm64"] });
    writeSpec("embersynth", { v2: ["darwin-arm64"] });
    const calls: QueryCounter = { count: 0 };
    const resolve = makeSpecArtifactResolver({
      client: fakeClient({ os: "darwin", arch: "arm64" }, calls),
      packagesDir,
    });
    const [first, second] = await Promise.all([
      resolve({ pkg: "llama-cpp", version: "b4500" }),
      resolve({ pkg: "embersynth", version: "v2" }),
    ]);
    expect(first.tarballUrl).toBe(artifactUrl("llama-cpp", "b4500", "darwin-arm64"));
    expect(second.tarballUrl).toBe(artifactUrl("embersynth", "v2", "darwin-arm64"));
    expect(calls.count).toBe(1);
  });

  test("rejects when node facts map to no platform, and keeps that result cached", async () => {
    writeSpec("llama-cpp", { b4500: ["linux-x64"] });
    const calls: QueryCounter = { count: 0 };
    const resolve = makeSpecArtifactResolver({
      client: fakeClient({ os: "win32", arch: "x64" }, calls),
      packagesDir,
    });
    const message = "could not derive target platform from node facts (os=win32, arch=x64).";
    expect(await rejectionMessage(resolve({ pkg: "llama-cpp", version: "b4500" }))).toBe(message);
    expect(await rejectionMessage(resolve({ pkg: "llama-cpp", version: "b4500" }))).toBe(message);
    expect(calls.count).toBe(1);
  });

  test("an unknown version rejects with the sorted list of known versions", async () => {
    writeSpec("llama-cpp", { b4600: ["linux-x64"], b4500: ["linux-x64"] });
    const calls: QueryCounter = { count: 0 };
    const resolve = makeSpecArtifactResolver({
      client: fakeClient({ os: "linux", arch: "x64" }, calls),
      packagesDir,
    });
    expect(await rejectionMessage(resolve({ pkg: "llama-cpp", version: "b9999" }))).toBe(
      "llama-cpp: unknown version b9999 (available: b4500, b4600)",
    );
  });

  test("a version without an artifact for the platform rejects with the sorted platforms", async () => {
    writeSpec("llama-cpp", { b4500: ["linux-x64", "darwin-arm64"] });
    const calls: QueryCounter = { count: 0 };
    const resolve = makeSpecArtifactResolver({
      client: fakeClient({ os: "linux", arch: "arm64" }, calls),
      packagesDir,
    });
    expect(await rejectionMessage(resolve({ pkg: "llama-cpp", version: "b4500" }))).toBe(
      "llama-cpp@b4500: no artifact for linux-arm64 (available: darwin-arm64, linux-x64)",
    );
  });

  test("a missing spec file rejects before nodeFacts is queried", async () => {
    const calls: QueryCounter = { count: 0 };
    const resolve = makeSpecArtifactResolver({
      client: fakeClient({ os: "linux", arch: "x64" }, calls),
      packagesDir,
    });
    expect(await rejectionMessage(resolve({ pkg: "missing-pkg", version: "b1" }))).toContain(
      `infra package spec not found at ${join(packagesDir, "missing-pkg.yaml")}`,
    );
    expect(calls.count).toBe(0);
  });
});

describe("nodeRunBudgetLookup", () => {
  test("returns spec.budget.memoryGiB of the NodeRun with that metadata.name", () => {
    const nodeRuns = [makeNodeRun("mac-mini", 12), makeNodeRun("studio", 96)];
    const lookup = nodeRunBudgetLookup(() => nodeRuns);
    expect(lookup("studio")).toBe(96);
    expect(lookup("mac-mini")).toBe(12);
  });

  test("returns undefined for an unknown name or a NodeRun without spec.budget", () => {
    const nodeRuns = [makeNodeRun("mac-mini"), makeNodeRun("studio", 96)];
    const lookup = nodeRunBudgetLookup(() => nodeRuns);
    expect(lookup("mac-mini")).toBeUndefined();
    expect(lookup("gpu-box")).toBeUndefined();
  });

  test("re-reads the NodeRun list on every call, not when the lookup is built", () => {
    let current: noderunSchema.NodeRun[] = [];
    let reads = 0;
    const lookup = nodeRunBudgetLookup((): noderunSchema.NodeRun[] => {
      reads += 1;
      return current;
    });
    expect(reads).toBe(0);
    expect(lookup("studio")).toBeUndefined();
    current = [makeNodeRun("studio", 64)];
    expect(lookup("studio")).toBe(64);
    expect(reads).toBe(2);
  });

  test("the first NodeRun wins when names repeat", () => {
    const nodeRuns = [makeNodeRun("studio", 32), makeNodeRun("studio", 96)];
    const lookup = nodeRunBudgetLookup(() => nodeRuns);
    expect(lookup("studio")).toBe(32);
  });
});
