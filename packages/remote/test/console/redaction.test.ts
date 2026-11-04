/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- RED contract tests for #410 P2b: the console surface is an inert 501 stub, so every test reaches it through the untyped `api()` shim and fails on its expects rather than on an import error or a TypeError. */
// Issue frozename/llamactl#410 (plan P2b, §0.11) — server-side response
// projections. Unit tests drive each allowlist entry's `project`
// through the guarded accessor and pin both the masking rules (env
// secrets, URL userinfo, argv flags, Bearer tokens, key-name backstop)
// and the pass-through of non-secret fields. HTTP tests push
// sentinel-laden fixtures through the spy backend and the real default
// backend and require "sentinel" to appear nowhere on the wire (R9).

import { afterEach, describe, expect, test } from "bun:test";

import * as remote from "../../src/index.js";
import {
  agentCliNodeFixture,
  apiHeaders,
  cleanupConsoleTest,
  consoleTestFixture,
  makeSpyBackend,
  ragNodeFixture,
  readSseFor,
  SENTINELS,
  setEnv,
  spyFixtures,
  startConsole,
  trpcUrl,
} from "./helpers.js";

function api(): any {
  expect(typeof remote.startConsoleServer).toBe("function");
  expect(typeof remote.buildConsoleRouter).toBe("function");
  expect(typeof remote.redactDeep).toBe("function");
  expect(remote.CONSOLE_ALLOWLIST).toBeDefined();
  return remote as any;
}

/** Per-procedure projections are reached only through this accessor so a
 *  missing allowlist entry fails on the expect, never on a TypeError. */
function project(name: string): any {
  const entry = (remote as any).CONSOLE_ALLOWLIST?.[name];
  expect(typeof entry?.project).toBe("function");
  return entry.project;
}

const QUERIES = [
  "env",
  "nodeList",
  "nodeTest",
  "nodeFacts",
  "workloadsDir",
  "workloadList",
  "workloadDescribe",
  "serverStatus",
];

function inputFor(name: string): { input?: unknown } {
  switch (name) {
    case "nodeTest":
    case "workloadDescribe":
      return { input: { name: "x" } };
    case "serverStatus":
      return { input: { workload: "w1" } };
    default:
      return {};
  }
}

afterEach(async () => {
  await cleanupConsoleTest();
});

describe("allowlist projections (unit)", () => {
  test("env: secrets masked, keys kept, non-secret values pass through", () => {
    api();
    const out = project("env")({
      DEV_STORAGE: "/tmp/dev",
      EMPTY_TOKEN: "",
      HF_TOKEN: "sentinel-hf",
      LLAMA_CPP_PORT: "8080",
      LM_API_TOKEN: "sentinel-lm",
      LOCAL_AI_PROVIDER: "lmstudio",
      MY_PASSWORD: "sentinel-pw",
      OPENAI_API_KEY: "sentinel-x",
    }) as Record<string, string>;
    expect(out["LM_API_TOKEN"]).toBe("[redacted]");
    expect(out["OPENAI_API_KEY"]).toBe("[redacted]");
    expect(out["HF_TOKEN"]).toBe("[redacted]");
    expect(out["MY_PASSWORD"]).toBe("[redacted]");
    expect(out["EMPTY_TOKEN"]).toBe("");
    expect(out["LOCAL_AI_PROVIDER"]).toBe("lmstudio");
    expect(out["DEV_STORAGE"]).toBe("/tmp/dev");
    expect(out["LLAMA_CPP_PORT"]).toBe("8080");
  });

  for (const name of ["nodeList", "nodeTest"]) {
    test(`${name}: URL userinfo stripped, cli env + secret keys masked, cert material kept`, () => {
      api();
      const input = {
        cluster: "home",
        context: "default",
        defaultNode: "agent1",
        nodes: [
          {
            cloud: {
              baseUrl: `https://u:${SENTINELS.cloud}@api.test:9/v1`,
              provider: "openai-compatible",
            },
            effectiveKind: "gateway",
            kind: "gateway",
            name: "gw",
          },
          ragNodeFixture(),
          agentCliNodeFixture(),
        ],
      };
      const out = project(name)(structuredClone(input));
      expect(out.nodes[0].cloud.baseUrl).toBe("https://api.test:9/v1");
      expect(out.nodes[0].name).toBe("gw");
      expect(out.nodes[1].rag.endpoint).toBe("postgres://db.local:5432/rag");
      expect(out.nodes[1].rag.auth.tokenEnv).toBe("[redacted]");
      const agent = out.nodes[2];
      expect(agent.endpoint).toBe("https://127.0.0.1:9");
      expect(agent.advertisedEndpoint).toBe("http://adv.local:4");
      expect(agent.cli[0].env.ANTHROPIC_API_KEY).toBe("[redacted]");
      expect(agent.cli[0].env.CLAUDE_MODEL).toBe("[redacted]");
      expect(agent.certificate).toBe("PEM-DATA");
      expect(agent.certificateFingerprint).toBe("sha256:abc123");
      expect(agent.name).toBe("agent1");
      expect(out.defaultNode).toBe("agent1");
      expect(out.context).toBe("default");
    });
  }

  test("nodeFacts: nested token masked, url userinfo stripped, facts kept", () => {
    api();
    const out = project("nodeFacts")({
      gpu: { name: "M4" },
      hostname: "h1",
      probe: { apiToken: SENTINELS.facts, url: `http://u:${SENTINELS.fu}@h:1/` },
    });
    expect(out.probe.apiToken).toBe("[redacted]");
    expect(out.probe.url).toBe("http://h:1/");
    expect(out.hostname).toBe("h1");
    expect(out.gpu.name).toBe("M4");
  });

  test("workloadsDir: a shape with no secrets passes through deep-equal", () => {
    api();
    expect(project("workloadsDir")({ path: "/tmp/wl" })).toEqual({ path: "/tmp/wl" });
  });

  for (const name of ["workloadList", "workloadDescribe", "serverStatus"]) {
    test(`${name}: argv secrets masked in --flag value and --flag=value forms`, () => {
      api();
      const out = project(name)({
        env: { LLM_TOKEN: "sentinel-env" },
        extraArgs: [
          "--api-key",
          "sentinel-arg",
          "--hf-token=sentinel-hf",
          "-hft",
          "sentinel-short",
          "--port",
          "8080",
          "--ctx-size",
          "32768",
        ],
        node: "local",
        rel: "m.gguf",
      });
      expect(out.extraArgs).toEqual([
        "--api-key",
        "[redacted]",
        "--hf-token=[redacted]",
        "-hft",
        "[redacted]",
        "--port",
        "8080",
        "--ctx-size",
        "32768",
      ]);
      expect(out.env.LLM_TOKEN).toBe("[redacted]");
      expect(out.node).toBe("local");
      expect(out.rel).toBe("m.gguf");
    });
  }

  test("serverLogs: argv, url-userinfo and Bearer rules apply inside a line", () => {
    api();
    const out = project("serverLogs")({
      line: `--api-key ${SENTINELS.log} --hf-token=${SENTINELS.hf} Authorization: Bearer ${SENTINELS.bearer} dsn=postgres://u:${SENTINELS.dsn}@db:1/x`,
      type: "line",
    });
    expect(out.line).toContain("--api-key [redacted]");
    expect(out.line).toContain("--hf-token=[redacted]");
    expect(out.line).toContain("Bearer [redacted]");
    expect(out.line).toContain("postgres://db:1/x");
    expect(out.line).not.toContain("sentinel");
    expect(out.type).toBe("line");
  });

  test("redactDeep backstop: secrets masked in an unnamed nested field", () => {
    const r = api();
    const out = r.redactDeep({
      auth: `Bearer ${SENTINELS.bearer}`,
      outer: {
        list: [{ apiToken: "sentinel-x", note: "ok" }],
        url: "postgres://u:sentinel-y@h/db",
      },
      plain: "visible",
    });
    expect(out.outer.list[0].apiToken).toBe("[redacted]");
    expect(out.outer.list[0].note).toBe("ok");
    expect(out.outer.url).toBe("postgres://h/db");
    expect(out.auth).toBe("Bearer [redacted]");
    expect(out.plain).toBe("visible");
  });
});

describe("redaction over HTTP (spy backend)", () => {
  for (const name of QUERIES) {
    test(`GET ${name} → 200 projected, no sentinel on the wire`, async () => {
      const r = api();
      const spy = makeSpyBackend(spyFixtures());
      const h = await startConsole(r, {
        distPath: consoleTestFixture().distPath,
        backend: spy.router,
      });
      const res = await fetch(trpcUrl(h, name, inputFor(name)), {
        headers: apiHeaders(h),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain("sentinel");
      expect(spy.calls.map((c) => c.path)).toEqual([name]);
    });
  }

  test("all 8 queries in one batch → no sentinel in the batch body", async () => {
    const r = api();
    const spy = makeSpyBackend(spyFixtures());
    const h = await startConsole(r, {
      distPath: consoleTestFixture().distPath,
      backend: spy.router,
    });
    const input: Record<string, unknown> = {};
    for (const [i, name] of QUERIES.entries()) {
      const named = inputFor(name);
      if (named.input !== undefined) input[String(i)] = named.input;
    }
    const res = await fetch(trpcUrl(h, QUERIES.join(","), { batch: true, input }), {
      headers: apiHeaders(h),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("sentinel");
    const rows = JSON.parse(text) as { result: { data: any } }[];
    expect(rows).toHaveLength(8);
    const env = rows[0]?.result.data;
    expect(env?.LM_API_TOKEN).toBe("[redacted]");
    expect(env?.OPENAI_API_KEY).toBe("[redacted]");
    expect(env?.LOCAL_AI_API_KEY).toBe("[redacted]");
    const workloadsDir = rows[4]?.result.data;
    expect(workloadsDir?.path).toBe("/tmp/wl");
  });

  test("serverLogs SSE frames carry the spy item with no sentinel", async () => {
    const r = api();
    const spy = makeSpyBackend(spyFixtures());
    const h = await startConsole(r, {
      distPath: consoleTestFixture().distPath,
      backend: spy.router,
    });
    const controller = new AbortController();
    const res = await fetch(trpcUrl(h, "serverLogs", { input: { workload: "w1", follow: true } }), {
      headers: apiHeaders(h, { accept: "text/event-stream" }),
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    // The yielded item is projected, so the sentinel never reaches the
    // wire; "logmark-41c0" survives projection and marks the frame.
    const { found, transcript } = await readSseFor(res, "logmark-41c0", 3000);
    controller.abort();
    expect(found).toBe(true);
    expect(transcript).not.toContain("sentinel");
    expect(spy.calls.map((c) => c.path)).toEqual(["serverLogs"]);
  });
});

describe("redaction over HTTP (default backend)", () => {
  test("env and nodeList leak no kubeconfig token, api key or url userinfo", async () => {
    const r = api();
    const { distPath } = consoleTestFixture({
      defaultNode: "local",
      nodes: [ragNodeFixture(), agentCliNodeFixture()],
      users: [{ name: "me", token: SENTINELS.kube }],
    });
    setEnv("LOCAL_AI_PROVIDER", "lmstudio");
    setEnv("LM_API_TOKEN", SENTINELS.lm);
    // Pin the profile so resolveEnv skips the sysctl hardware probe.
    setEnv("LLAMA_CPP_MACHINE_PROFILE", "macbook-pro-48g");
    const h = await startConsole(r, { distPath });
    for (const name of ["env", "nodeList"]) {
      const res = await fetch(trpcUrl(h, name), { headers: apiHeaders(h) });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain("sentinel");
    }
  });
});
