import type { NodeClient } from "@llamactl/remote";

import { createRemoteNodeClient } from "@llamactl/remote";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  __resetWorkloadTestSeams,
  __setWorkloadTestSeams,
  runApply,
} from "../src/commands/workload.js";
import { EMPTY_GLOBALS, setGlobals } from "../src/dispatcher.js";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

/**
 * #221: `apply` on a NodeRun must bound every node .query — infraList
 * and the nodeFacts lookup inside the artifact resolver — by the node
 * query deadline, while .mutate stays unbounded so a slow install or
 * activate can still converge. A node that never answers fails the
 * apply instead of hanging the CLI. The seams inject the client and a
 * 20 ms deadline. The fakes expose each procedure as a function carrying
 * query/mutate, the shape @trpc/client's createTRPCClient returns, and one
 * test drives a real tRPC client against a loopback server that never
 * answers. Nothing here touches a remote host, a real kubeconfig, or
 * ~/.llamactl.
 */

let tmp = "";
const originalEnv = { ...process.env };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-apply-noderun-dl-"));
  process.env["DEV_STORAGE"] = join(tmp, "dev");
  process.env["LLAMACTL_CONFIG"] = join(tmp, "no-such-kubeconfig.yaml");
  process.env["LLAMACTL_WORKLOADS_DIR"] = join(tmp, "workloads");
  process.env["LLAMACTL_INFRA_PACKAGES_DIR"] = join(tmp, "packages");
  process.env["LOCAL_AI_RUNTIME_DIR"] = join(tmp, "runtime");
  mkdirSync(process.env["LLAMACTL_WORKLOADS_DIR"], { recursive: true });
  mkdirSync(process.env["LLAMACTL_INFRA_PACKAGES_DIR"], { recursive: true });
  mkdirSync(process.env["LOCAL_AI_RUNTIME_DIR"], { recursive: true });
  setGlobals(EMPTY_GLOBALS);
});

afterEach(() => {
  __resetWorkloadTestSeams();
  setGlobals(EMPTY_GLOBALS);
  process.env = { ...originalEnv };
  rmSync(tmp, { recursive: true, force: true });
});

function withCapturedIo<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const stdoutOrig = process.stdout.write.bind(process.stdout);
  const stderrOrig = process.stderr.write.bind(process.stderr);

  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };

  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    stderr += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };
  return fn()
    .then((result) => ({ result, stdout, stderr }))
    .finally(() => {
      process.stdout.write = stdoutOrig;

      process.stderr.write = stderrOrig;
    });
}

interface InfraListRow {
  pkg: string;
  versions: string[];
  active: string | null;
}

interface NodeRpcHandlers {
  infraListQuery: () => Promise<InfraListRow[]>;
  nodeFactsQuery: () => Promise<unknown>;
  infraInstallMutate: () => Promise<unknown>;
  infraActivateMutate: () => Promise<unknown>;
  infraUninstallMutate: () => Promise<unknown>;
}

/**
 * A procedure shaped like @trpc/client's: a function (typeof "function")
 * with query/mutate on it, not a plain object, so a wrapper that only
 * handles object-typed procedures leaves these calls unbounded.
 */
function procedure(calls: { query?: () => Promise<unknown>; mutate?: () => Promise<unknown> }): {
  (): void;
  query?: () => Promise<unknown>;
  mutate?: () => Promise<unknown>;
} {
  return Object.assign((): void => undefined, calls);
}

function makeNodeClient(handlers: NodeRpcHandlers): NodeClient {
  const client = {
    infraList: procedure({ query: handlers.infraListQuery }),
    nodeFacts: procedure({ query: handlers.nodeFactsQuery }),
    infraInstall: procedure({ mutate: handlers.infraInstallMutate }),
    infraActivate: procedure({ mutate: handlers.infraActivateMutate }),
    infraUninstall: procedure({ mutate: handlers.infraUninstallMutate }),
  };
  expect(typeof client.infraList).toBe("function");
  return client as unknown as NodeClient;
}

function writeNodeRunManifest(infra: { pkg: string; version: string }[]): string {
  const manifestPath = join(tmp, "gpu1-infra.yaml");
  const infraLines =
    infra.length === 0
      ? ["  infra: []"]
      : [
          "  infra:",
          ...infra.flatMap((item) => [`    - pkg: ${item.pkg}`, `      version: ${item.version}`]),
        ];
  writeFileSync(
    manifestPath,
    [
      "apiVersion: llamactl/v1",
      "kind: NodeRun",
      "metadata:",
      "  name: gpu1-infra",
      "spec:",
      "  node: gpu1",
      ...infraLines,
      "",
    ].join("\n"),
    "utf8",
  );
  return manifestPath;
}

/** A local llama-cpp@b1 package spec with an artifact for every platform. */
function writeLlamaCppPackageSpec(): void {
  const sha256 = "a".repeat(64);
  const platformSpecs = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"]
    .map(
      (platform) =>
        `      ${platform}:\n        url: https://example.invalid/llama-cpp-b1.tgz\n        sha256: ${sha256}`,
    )
    .join("\n");
  writeFileSync(
    join(process.env["LLAMACTL_INFRA_PACKAGES_DIR"]!, "llama-cpp.yaml"),
    `name: llama-cpp\nversions:\n  b1:\n    platforms:\n${platformSpecs}\n`,
    "utf8",
  );
}

/** A mutate handler that answers well after the 20 ms query deadline. */
function slowMutate<T>(value: T, onCall: () => void): () => Promise<T> {
  return () => {
    onCall();
    return new Promise<T>((resolve) => {
      setTimeout(() => {
        resolve(value);
      }, 100);
    });
  };
}

async function runGuarded(args: string[]): Promise<number | string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      runApply(args).catch(
        (err: unknown): string => `threw: ${err instanceof Error ? err.message : String(err)}`,
      ),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => {
          resolve("stalled");
        }, 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("a node whose infraList never answers fails apply at the node query deadline (#221)", async () => {
  const requested: string[] = [];
  __setWorkloadTestSeams({
    nodeQueryTimeoutMs: 20,
    getNodeClientByName: (name) => {
      requested.push(name);
      return makeNodeClient({
        infraListQuery: () => new Promise<InfraListRow[]>(() => undefined),
        nodeFactsQuery: () => Promise.reject(new Error("nodeFacts must not be queried")),
        infraInstallMutate: () => Promise.reject(new Error("infraInstall must not be called")),
        infraActivateMutate: () => Promise.reject(new Error("infraActivate must not be called")),
        infraUninstallMutate: () => Promise.reject(new Error("infraUninstall must not be called")),
      });
    },
  });
  const manifestPath = writeNodeRunManifest([]);

  const { result, stderr } = await withCapturedIo(() => runGuarded(["-f", manifestPath]));

  expect(result).toBe(1);
  expect(stderr).toContain("apply: node 'gpu1' did not answer within 20 ms");
  expect(requested).toEqual(["gpu1"]);
  expect(existsSync(join(process.env["LLAMACTL_WORKLOADS_DIR"]!, "gpu1-infra.yaml"))).toBe(false);
});

test("the artifact resolver's nodeFacts query is bounded too, and install is never attempted (#221)", async () => {
  writeLlamaCppPackageSpec();

  const requested: string[] = [];
  let installCalls = 0;
  __setWorkloadTestSeams({
    nodeQueryTimeoutMs: 20,
    getNodeClientByName: (name) => {
      requested.push(name);
      return makeNodeClient({
        infraListQuery: () => Promise.resolve([]),
        nodeFactsQuery: () => new Promise<never>(() => undefined),
        infraInstallMutate: () => {
          installCalls += 1;
          return Promise.resolve({ ok: true });
        },
        infraActivateMutate: () => Promise.resolve({ ok: true }),
        infraUninstallMutate: () => Promise.resolve({ ok: true, mode: "package", removed: true }),
      });
    },
  });
  const manifestPath = writeNodeRunManifest([{ pkg: "llama-cpp", version: "b1" }]);

  const { result, stdout } = await withCapturedIo(() => runGuarded(["-f", manifestPath]));

  expect(result).toBe(1);
  expect(stdout).toContain("failed noderun/gpu1-infra on node gpu1");
  expect(stdout).toContain(
    "install llama-cpp@b1 (missing)  ERROR: node 'gpu1' did not answer within 20 ms",
  );
  expect(installCalls).toBe(0);
});

test("mutations stay unbounded: a slow infraActivate outlives the query deadline and still converges (#221)", async () => {
  const requested: string[] = [];
  let activateCalls = 0;
  __setWorkloadTestSeams({
    nodeQueryTimeoutMs: 20,
    getNodeClientByName: (name) => {
      requested.push(name);
      return makeNodeClient({
        infraListQuery: () =>
          Promise.resolve([{ pkg: "llama-cpp", versions: ["b1"], active: null }]),
        nodeFactsQuery: () => Promise.reject(new Error("nodeFacts must not be queried")),
        infraInstallMutate: () => Promise.reject(new Error("infraInstall must not be called")),
        infraActivateMutate: () => {
          activateCalls += 1;
          return new Promise((resolve) => {
            setTimeout(() => {
              resolve({ ok: true });
            }, 100);
          });
        },
        infraUninstallMutate: () => Promise.reject(new Error("infraUninstall must not be called")),
      });
    },
  });
  const manifestPath = writeNodeRunManifest([{ pkg: "llama-cpp", version: "b1" }]);

  const { result, stdout } = await withCapturedIo(() => runGuarded(["-f", manifestPath]));

  expect(result).toBe(0);
  expect(stdout).toContain("converged noderun/gpu1-infra on node gpu1");
  expect(stdout).toContain("activate llama-cpp@b1");
  expect(stdout).not.toContain("did not answer");
  expect(activateCalls).toBe(1);
});

test("mutations stay unbounded: a slow infraInstall outlives the query deadline and still converges (#221)", async () => {
  writeLlamaCppPackageSpec();
  let installCalls = 0;
  __setWorkloadTestSeams({
    nodeQueryTimeoutMs: 20,
    getNodeClientByName: () =>
      makeNodeClient({
        infraListQuery: () => Promise.resolve([]),
        nodeFactsQuery: () => Promise.resolve({ os: "linux", arch: "x64" }),
        infraInstallMutate: slowMutate({ ok: true }, () => {
          installCalls += 1;
        }),
        infraActivateMutate: () => Promise.reject(new Error("infraActivate must not be called")),
        infraUninstallMutate: () => Promise.reject(new Error("infraUninstall must not be called")),
      }),
  });
  const manifestPath = writeNodeRunManifest([{ pkg: "llama-cpp", version: "b1" }]);

  const { result, stdout } = await withCapturedIo(() => runGuarded(["-f", manifestPath]));

  expect(result).toBe(0);
  expect(stdout).toContain("converged noderun/gpu1-infra on node gpu1");
  expect(stdout).toContain("install llama-cpp@b1 (missing)");
  expect(stdout).not.toContain("did not answer");
  expect(installCalls).toBe(1);
});

test("mutations stay unbounded: a slow infraUninstall outlives the query deadline and still converges (#221)", async () => {
  let uninstallCalls = 0;
  __setWorkloadTestSeams({
    nodeQueryTimeoutMs: 20,
    getNodeClientByName: () =>
      makeNodeClient({
        infraListQuery: () => Promise.resolve([{ pkg: "old-pkg", versions: ["v1"], active: "v1" }]),
        nodeFactsQuery: () => Promise.reject(new Error("nodeFacts must not be queried")),
        infraInstallMutate: () => Promise.reject(new Error("infraInstall must not be called")),
        infraActivateMutate: () => Promise.reject(new Error("infraActivate must not be called")),
        infraUninstallMutate: slowMutate({ ok: true, mode: "package", removed: true }, () => {
          uninstallCalls += 1;
        }),
      }),
  });
  const manifestPath = writeNodeRunManifest([]);

  const { result, stdout } = await withCapturedIo(() => runGuarded(["-f", manifestPath]));

  expect(result).toBe(0);
  expect(stdout).toContain("converged noderun/gpu1-infra on node gpu1");
  expect(stdout).toContain("uninstall old-pkg (unwanted)");
  expect(stdout).not.toContain("did not answer");
  expect(uninstallCalls).toBe(1);
});

test("a real tRPC client whose node never answers fails apply within the deadline (#221)", async () => {
  const paths: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req): Promise<Response> {
      paths.push(new URL(req.url).pathname);
      return new Promise<Response>(() => undefined);
    },
  });
  try {
    const client = createRemoteNodeClient({
      url: `http://127.0.0.1:${String(server.port)}`,
      token: "fixture-bearer",
    });
    // createTRPCClient hands out each procedure as a function proxy.
    expect(typeof client.infraList).toBe("function");
    __setWorkloadTestSeams({
      nodeQueryTimeoutMs: 50,
      getNodeClientByName: () => client,
    });
    const manifestPath = writeNodeRunManifest([]);

    const started = performance.now();
    const { result, stderr } = await withCapturedIo(() => runGuarded(["-f", manifestPath]));
    const elapsedMs = performance.now() - started;

    expect(result).toBe(1);
    expect(stderr).toContain("apply: node 'gpu1' did not answer within 50 ms");
    expect(elapsedMs).toBeLessThan(1500);
    expect(paths.some((path) => path.startsWith("/trpc/infraList"))).toBe(true);
  } finally {
    await server.stop(true);
  }
});
