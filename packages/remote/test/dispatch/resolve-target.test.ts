/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/require-await -- RED contract tests for #410 P2a: the dispatch surface is not exported yet, so every test reaches it through the untyped `api()` shim and fails on its expects rather than on an import error or a TypeError. */
// Issue frozename/llamactl#410 (plan P2a) — pin the dispatch-resolution
// contract before the Electron dispatcher is extracted into
// @llamactl/remote: `resolveDispatchTarget` takes an explicit
// `onUnresolvable` mode instead of always failing open to {kind:"local"},
// CONTROL_PLANE_ONLY paths stay local in both modes, and
// `buildDispatchRouter` wires the same resolution into the real router.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";

import * as remote from "../../src/index.js";
import { mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";

/**
 * The P2a surface under test does not exist on the module yet; reaching it
 * through the namespace keeps module evaluation safe and turns every RED
 * failure into a failed expect here, never an import error or a TypeError.
 */
function api(): any {
  expect(typeof remote.resolveDispatchTarget).toBe("function");
  expect(typeof remote.buildDispatchRouter).toBe("function");
  expect(typeof remote.__resetDispatchClientCacheForTests).toBe("function");
  expect(typeof remote.DispatchResolutionError).toBe("function");
  return remote as any;
}

interface FixtureUser {
  name: string;
  token?: string;
  tokenRef?: string;
}

interface KubeconfigFixture {
  /** Raw file contents; when set the rest of the fixture is ignored. */
  raw?: string;
  currentContext?: string;
  contextUser?: string;
  defaultNode?: string;
  users?: FixtureUser[];
  /** Env vars to delete before resolving (tokenRef failure probes). */
  unsetEnv?: string[];
}

function baseConfig(fx: KubeconfigFixture): Record<string, unknown> {
  return {
    apiVersion: "llamactl/v1",
    kind: "Config",
    currentContext: fx.currentContext ?? "default",
    contexts: [
      {
        name: "default",
        cluster: "home",
        user: fx.contextUser ?? "me",
        defaultNode: fx.defaultNode ?? "agent1",
      },
    ],
    clusters: [
      {
        name: "home",
        nodes: [
          { name: "local", endpoint: "inproc://local" },
          {
            name: "agent1",
            endpoint: "https://127.0.0.1:9",
            kind: "agent",
            certificateFingerprint: "sha256:abc",
            tlsServerName: "localhost",
          },
          {
            name: "gw",
            endpoint: "https://127.0.0.1:10",
            kind: "gateway",
            cloud: { provider: "openai-compatible", baseUrl: "http://127.0.0.1:11/v1" },
          },
        ],
      },
    ],
    users: fx.users ?? [{ name: "me", token: "tok-123456789" }],
  };
}

const tmpDirs: string[] = [];
let previousConfig: string | undefined;

beforeEach(() => {
  previousConfig = process.env["LLAMACTL_CONFIG"];
});

afterEach(() => {
  if (previousConfig === undefined) Reflect.deleteProperty(process.env, "LLAMACTL_CONFIG");
  else process.env["LLAMACTL_CONFIG"] = previousConfig;
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeKubeconfig(fx: KubeconfigFixture = {}): void {
  for (const name of fx.unsetEnv ?? []) Reflect.deleteProperty(process.env, name);
  const dir = mkdtempSync(join(tmpdir(), "llamactl-dispatch-test-"));
  tmpDirs.push(dir);
  const path = join(dir, "config");
  writeFileSync(path, fx.raw ?? stringify(baseConfig(fx)));
  process.env["LLAMACTL_CONFIG"] = path;
}

const AGENT1_REMOTE_TARGET = {
  kind: "remote",
  node: {
    name: "agent1",
    endpoint: "https://127.0.0.1:9",
    certificate: null,
    certificateFingerprint: "sha256:abc",
    tlsServerName: "localhost",
  },
  token: "tok-123456789",
};

function expectResolutionError(r: any, nodeName: string | null, code: string): void {
  let caught: unknown;
  try {
    r.resolveDispatchTarget("env", nodeName, { onUnresolvable: "error" });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(r.DispatchResolutionError);
  expect((caught as { code?: unknown }).code).toBe(code);
}

describe("resolveDispatchTarget — 'local' mode", () => {
  const fallbacks: { name: string; nodeName: string | null; fixture: KubeconfigFixture }[] = [
    {
      name: "unreadable kubeconfig",
      nodeName: "agent1",
      fixture: { raw: "apiVersion: nope\n" },
    },
    {
      name: "currentContext has no matching context",
      nodeName: "agent1",
      fixture: { currentContext: "ghost-ctx" },
    },
    { name: "node is not in the cluster", nodeName: "ghost", fixture: {} },
    { name: "node resolves to the local endpoint", nodeName: "local", fixture: {} },
    {
      name: "context user is missing",
      nodeName: "agent1",
      fixture: { contextUser: "ghost-user" },
    },
    {
      name: "user token cannot be resolved",
      nodeName: "agent1",
      fixture: {
        users: [{ name: "me", tokenRef: "env:LLAMACTL_DISPATCH_TEST_UNSET_TOKEN" }],
        unsetEnv: ["LLAMACTL_DISPATCH_TEST_UNSET_TOKEN"],
      },
    },
  ];

  for (const c of fallbacks) {
    test(`fails open to local — ${c.name}`, () => {
      const r = api();
      writeKubeconfig(c.fixture);
      expect(r.resolveDispatchTarget("env", c.nodeName, { onUnresolvable: "local" })).toEqual({
        kind: "local",
      });
    });
  }

  test("null node falls back to the context's defaultNode", () => {
    const r = api();
    writeKubeconfig({ defaultNode: "agent1" });
    expect(r.resolveDispatchTarget("env", null, { onUnresolvable: "local" })).toEqual(
      AGENT1_REMOTE_TARGET,
    );
  });

  test("explicit node wins over the context's defaultNode", () => {
    const r = api();
    writeKubeconfig({ defaultNode: "local" });
    expect(r.resolveDispatchTarget("env", "agent1", { onUnresolvable: "local" })).toEqual(
      AGENT1_REMOTE_TARGET,
    );
  });

  test("gateway node still routes remote (today's fail-open behaviour)", () => {
    const r = api();
    writeKubeconfig({});
    expect(r.resolveDispatchTarget("env", "gw", { onUnresolvable: "local" })).toEqual({
      kind: "remote",
      node: {
        name: "gw",
        endpoint: "https://127.0.0.1:10",
        certificate: null,
        certificateFingerprint: null,
      },
      token: "tok-123456789",
    });
  });
});

describe("resolveDispatchTarget — 'error' mode", () => {
  const errors: {
    name: string;
    nodeName: string | null;
    fixture: KubeconfigFixture;
    code: string;
  }[] = [
    {
      name: "unreadable kubeconfig",
      nodeName: "agent1",
      fixture: { raw: "apiVersion: nope\n" },
      code: "kubeconfig_unreadable",
    },
    {
      name: "currentContext has no matching context",
      nodeName: "agent1",
      fixture: { currentContext: "ghost-ctx" },
      code: "no_current_context",
    },
    {
      name: "node is not in the cluster",
      nodeName: "ghost",
      fixture: {},
      code: "unknown_node",
    },
    {
      name: "context user is missing",
      nodeName: "agent1",
      fixture: { contextUser: "ghost-user" },
      code: "user_missing",
    },
    {
      name: "user token cannot be resolved",
      nodeName: "agent1",
      fixture: {
        users: [{ name: "me", tokenRef: "env:LLAMACTL_DISPATCH_TEST_UNSET_TOKEN" }],
        unsetEnv: ["LLAMACTL_DISPATCH_TEST_UNSET_TOKEN"],
      },
      code: "node_credentials_unavailable",
    },
    {
      name: "gateway node is not dispatchable",
      nodeName: "gw",
      fixture: {},
      code: "node_not_dispatchable",
    },
  ];

  for (const c of errors) {
    test(`throws DispatchResolutionError(${c.code}) — ${c.name}`, () => {
      const r = api();
      writeKubeconfig(c.fixture);
      expectResolutionError(r, c.nodeName, c.code);
    });
  }

  test("local endpoint node still resolves local", () => {
    const r = api();
    writeKubeconfig({});
    expect(r.resolveDispatchTarget("env", "local", { onUnresolvable: "error" })).toEqual({
      kind: "local",
    });
  });

  test("reachable agent node still resolves remote", () => {
    const r = api();
    writeKubeconfig({});
    expect(r.resolveDispatchTarget("env", "agent1", { onUnresolvable: "error" })).toEqual(
      AGENT1_REMOTE_TARGET,
    );
  });
});

describe("CONTROL_PLANE_ONLY", () => {
  test("contains control-plane procedures and no node-routed ones", () => {
    const r = api();
    for (const path of ["nodeList", "workloadList", "uiSetActiveNode", "costSnapshot"]) {
      expect(r.CONTROL_PLANE_ONLY.has(path)).toBe(true);
    }
    for (const path of ["env", "serverStatus"]) {
      expect(r.CONTROL_PLANE_ONLY.has(path)).toBe(false);
    }
  });

  test("control-plane path resolves local even with an unreadable kubeconfig in error mode", () => {
    const r = api();
    writeKubeconfig({ raw: "apiVersion: nope\n" });
    expect(r.resolveDispatchTarget("workloadList", "ghost", { onUnresolvable: "error" })).toEqual({
      kind: "local",
    });
  });
});

describe("buildDispatchRouter — 'error' mode", () => {
  test("unresolvable node refuses before the local caller or fetch, local node still runs", async () => {
    const r = api();
    writeKubeconfig({});
    const localCalls: string[] = [];
    const fetchCalls: unknown[] = [];
    const localCallerFactory = (): object =>
      new Proxy(
        {},
        {
          get: (_target, property) => {
            localCalls.push(String(property));
            return async () => "local";
          },
        },
      );
    const fetchFactory = (node: unknown): ((input: unknown) => Promise<Response>) => {
      fetchCalls.push(node);
      return (input: unknown): Promise<Response> => {
        fetchCalls.push(input);
        return Promise.resolve(new Response("{}"));
      };
    };

    const ghostCaller = r
      .buildDispatchRouter({
        fetchFactory,
        nodeFromCtx: (): string => "ghost",
        onUnresolvable: "error",
        localCallerFactory,
      })
      .createCaller({ node: null });
    let caught: unknown;
    try {
      await ghostCaller.env();
    } catch (err) {
      caught = err;
    }
    const cause = (caught as { cause?: unknown } | null)?.cause;
    expect(cause).toBeInstanceOf(r.DispatchResolutionError);
    expect((cause as { code?: unknown }).code).toBe("unknown_node");
    expect(localCalls).toEqual([]);
    expect(fetchCalls).toEqual([]);

    const localCaller = r
      .buildDispatchRouter({
        fetchFactory,
        nodeFromCtx: (): string => "local",
        onUnresolvable: "error",
        localCallerFactory,
      })
      .createCaller({ node: null });
    expect(await localCaller.env()).toBe("local");
    expect(localCalls).toEqual(["env"]);
  });
});
