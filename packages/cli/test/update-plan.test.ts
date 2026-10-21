import { describe, expect, test } from "bun:test";

import type { ExecResult } from "../src/commands/update/deps.js";

import { parseUpdateFlags, type UpdateFlags } from "../src/commands/update/flags.js";
import { depsChanged, fetchArgs, parseGithubRepo } from "../src/commands/update/git.js";
import { applyRefusals, runUpdate } from "../src/commands/update/index.js";
import {
  ciState,
  classifyIdle,
  parseCiState,
  resolveAgentEndpoint,
} from "../src/commands/update/probes.js";
import { fakeDeps, makeWorld, sha } from "./update-fakes.js";

function flags(args: string[]): UpdateFlags {
  const parsed = parseUpdateFlags(args);
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed;
}

describe("parseUpdateFlags", () => {
  test("defaults to a check of origin/main", () => {
    expect(flags([])).toMatchObject({
      mode: "check",
      ref: "origin/main",
      allowRedCi: false,
      waitIdleSec: 600,
      json: false,
    });
  });

  test("apply with a ref and options, in both value spellings", () => {
    expect(
      flags(["--apply", "--ref", "origin/release", "--allow-red-ci", "--wait-idle=30", "--json"]),
    ).toMatchObject({
      mode: "apply",
      ref: "origin/release",
      allowRedCi: true,
      waitIdleSec: 30,
      json: true,
    });
    expect(
      flags(["--apply", "--controller-unit=c.service", "--agent-unit", "a.service"]),
    ).toMatchObject({
      controllerUnit: "c.service",
      agentUnit: "a.service",
    });
  });

  test("--rollback takes an optional target", () => {
    expect(flags(["--rollback"])).toMatchObject({ mode: "rollback", rollbackRef: null });
    expect(flags(["--rollback", "feat/x@abc1234"])).toMatchObject({
      mode: "rollback",
      rollbackRef: "feat/x@abc1234",
    });
    expect(flags(["--rollback=abc1234"])).toMatchObject({ rollbackRef: "abc1234" });
    expect(flags(["--rollback", "--json"])).toMatchObject({ rollbackRef: null, json: true });
  });

  test("rejects bad input", () => {
    expect(parseUpdateFlags(["--bogus"])).toEqual({ error: "unknown flag --bogus" });
    expect(parseUpdateFlags(["--wait-idle", "soon"])).toEqual({
      error: "invalid --wait-idle: soon",
    });
    expect(parseUpdateFlags(["--ref"])).toEqual({ error: "--ref needs a value" });
    expect(JSON.stringify(parseUpdateFlags(["--service-manager", "runit"]))).toContain(
      "systemd or launchd",
    );
    expect(parseUpdateFlags(["-h"])).toEqual({ error: "help" });
  });
});

describe("plan helpers", () => {
  test("depsChanged: the lockfile or any workspace package.json", () => {
    expect(depsChanged(["bun.lock"])).toBe(true);
    expect(depsChanged(["package.json"])).toBe(true);
    expect(depsChanged(["README.md", "packages/remote/package.json"])).toBe(true);
    expect(
      depsChanged(["packages/cli/src/bin.ts", "docs/package.json", "packages/a/b/package.json"]),
    ).toBe(false);
    expect(depsChanged([])).toBe(false);
  });

  test("fetchArgs always names an explicit refspec", () => {
    expect(fetchArgs("origin/main")).toEqual([
      "fetch",
      "--quiet",
      "origin",
      "+refs/heads/main:refs/remotes/origin/main",
    ]);
    expect(fetchArgs("origin/release/1")).toEqual([
      "fetch",
      "--quiet",
      "origin",
      "+refs/heads/release/1:refs/remotes/origin/release/1",
    ]);
    expect(fetchArgs("abc1234")).toEqual([
      "fetch",
      "--quiet",
      "origin",
      "+refs/heads/main:refs/remotes/origin/main",
    ]);
  });

  test("parseGithubRepo handles https and ssh remotes", () => {
    expect(parseGithubRepo("https://github.com/frozename/llamactl.git")).toBe("frozename/llamactl");
    expect(parseGithubRepo("git@github.com:frozename/llamactl.git\n")).toBe("frozename/llamactl");
    expect(parseGithubRepo("https://github.com/frozename/llamactl")).toBe("frozename/llamactl");
    expect(parseGithubRepo("https://gitlab.com/x/y.git")).toBeNull();
  });
});

describe("CI state", () => {
  test("parseCiState maps gh run list output", () => {
    expect(parseCiState("[]")).toBe("none");
    expect(parseCiState('[{"status":"in_progress","conclusion":""}]')).toBe("pending");
    expect(parseCiState('[{"status":"completed","conclusion":"success"}]')).toBe("success");
    expect(parseCiState('[{"status":"completed","conclusion":"failure"}]')).toBe("failure");
    expect(parseCiState("not json")).toBe("unknown");
  });

  test("ciState is unknown without gh, without a GitHub remote, or when gh fails", async () => {
    const calls: string[][] = [];
    const exec = (argv: readonly string[]): Promise<ExecResult> => {
      calls.push([...argv]);
      return Promise.resolve({ code: 1, stdout: "", stderr: "auth" });
    };
    expect(await ciState(exec, () => null, "o/r", sha(1))).toBe("unknown");
    expect(await ciState(exec, () => "/usr/bin/gh", null, sha(1))).toBe("unknown");
    expect(calls).toEqual([]);
    expect(await ciState(exec, () => "/usr/bin/gh", "o/r", sha(1))).toBe("unknown");
    expect(calls[0]).toEqual([
      "gh",
      "run",
      "list",
      "--repo",
      "o/r",
      "--commit",
      sha(1),
      "--workflow",
      "check",
      "--limit",
      "1",
      "--json",
      "status,conclusion",
    ]);
  });
});

describe("probes", () => {
  test("classifyIdle prefers Strata's live state, then llama-server slots, then gauges", () => {
    const r = (status: number, body: string): { status: number; body: string } => ({
      status,
      body,
    });
    const idleSlots = r(200, '[{"is_processing":false},{"is_processing":false}]');
    expect(classifyIdle(null, idleSlots)).toBe("idle");
    expect(classifyIdle(null, r(200, '[{"is_processing":true}]'))).toBe("busy");
    expect(classifyIdle(r(200, '{"live":{"state":"idle","queued":0}}'), r(501, ""))).toBe("idle");
    expect(classifyIdle(r(200, '{"live":{"state":"decoding","queued":0}}'), null)).toBe("busy");
    // Strata's /slots ignores queued requests: live.queued wins over idle-looking slots.
    expect(classifyIdle(r(200, '{"live":{"state":"idle","queued":2}}'), idleSlots)).toBe("busy");
    // ... and an empty /slots (engine down) says nothing.
    expect(classifyIdle(null, r(200, "[]"))).toBe("unknown");
    const gauges = "llamacpp:requests_processing 0\nllamacpp:requests_deferred 0\n";
    expect(classifyIdle(r(200, gauges), null)).toBe("idle");
    expect(classifyIdle(r(200, "llamacpp:requests_processing 1\n"), null)).toBe("busy");
    expect(classifyIdle(r(200, "# nothing useful"), null)).toBe("unknown");
    expect(classifyIdle(null, null)).toBe("unknown");
  });

  test("resolveAgentEndpoint: unit flags over agent.yaml, wildcard binds probed on loopback", () => {
    const files = new Map([["/a/agent.yaml", "bindHost: 0.0.0.0\nport: 9443\n"]]);
    const readFile = (p: string): string | null => files.get(p) ?? null;
    expect(
      resolveAgentEndpoint({
        override: null,
        argv: ["bun", "x", "agent", "serve", "--dir=/a"],
        env: {},
        readFile,
      }).url,
    ).toBe("https://127.0.0.1:9443");
    expect(
      resolveAgentEndpoint({
        override: null,
        argv: ["agent", "serve", "--dir=/a", "--port=9555", "--bind=::1"],
        env: {},
        readFile,
      }).url,
    ).toBe("https://[::1]:9555");
    expect(
      resolveAgentEndpoint({
        override: null,
        argv: [],
        env: { LLAMACTL_AGENT_DIR: "/missing" },
        readFile,
      }).url,
    ).toBe("https://127.0.0.1:7843");
    expect(
      resolveAgentEndpoint({ override: "https://10.0.0.2:7843/", argv: [], env: {}, readFile }).url,
    ).toBe("https://10.0.0.2:7843");
  });
});

describe("applyRefusals", () => {
  const base = {
    insideUnit: null,
    serviceProblems: [],
    dirty: [],
    repo: "/r",
    fastForward: true,
    divergedMain: null,
    ref: "origin/main",
    ci: "success",
    allowRedCi: false,
    health: [],
  };

  test("a clean, green fast-forward with healthy services goes ahead", () => {
    expect(applyRefusals(base)).toEqual([]);
  });

  test("each gate refuses on its own", () => {
    expect(applyRefusals({ ...base, dirty: [" M packages/cli/src/bin.ts"] })[0]).toContain(
      "tracked local changes",
    );
    expect(applyRefusals({ ...base, fastForward: false })[0]).toContain("not a fast-forward");
    expect(applyRefusals({ ...base, divergedMain: sha(9) })[0]).toContain(
      "local branch main (9999999) has commits origin/main does not contain",
    );
    expect(applyRefusals({ ...base, ci: "failure" })[0]).toContain("target CI is 'failure'");
    expect(applyRefusals({ ...base, ci: "unknown" })[0]).toContain("--allow-red-ci");
    expect(applyRefusals({ ...base, ci: "failure", allowRedCi: true })).toEqual([]);
    expect(applyRefusals({ ...base, health: ["seat is not ready"] })[0]).toContain(
      "fix that first: seat is not ready",
    );
    expect(applyRefusals({ ...base, insideUnit: "llamactl-agent.service" })[0]).toContain(
      "running inside llamactl-agent.service",
    );
    expect(applyRefusals({ ...base, serviceProblems: ["x.service is not loaded"] })).toEqual([
      "x.service is not loaded",
    ]);
  });

  test("reports every reason at once", () => {
    expect(
      applyRefusals({ ...base, dirty: ["M a"], fastForward: false, ci: "pending" }),
    ).toHaveLength(3);
  });
});

describe("llamactl update --check", () => {
  test("reports the plan as JSON and changes nothing", async () => {
    const w = makeWorld();
    const { deps, out } = fakeDeps(w);
    const code = await runUpdate(["--check", "--json"], deps);
    expect(code).toBe(0);
    const report = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(report).toMatchObject({
      mode: "check",
      result: "check",
      repo: "/srv/llamactl",
      current: { branch: "feat/strata-engine", sha: sha(1) },
      target: {
        ref: "origin/main",
        sha: sha(4),
        newCommits: 3,
        depsChanged: true,
        fastForward: true,
        ci: "success",
      },
      serviceManager: "systemd",
      agent: { url: "https://127.0.0.1:17843", healthy: true },
      hosts: [
        {
          name: "seat",
          kind: "ModelHost",
          pid: 2039339,
          reconciled: true,
          ready: true,
          idle: "idle",
        },
      ],
      historyFile: "/srv/state/update-history.log",
      refusals: [],
    });
    expect(w.events).toEqual([]);
    expect(w.calls.some((c) => c[0] === "git" && c.includes("switch"))).toBe(false);
    expect(w.files.has("/srv/state/update-history.log")).toBe(false);
  });

  test("lists what --apply would refuse", async () => {
    const w = makeWorld({ dirty: [" M packages/cli/src/bin.ts"], ciJson: "[]" });
    const { deps, out } = fakeDeps(w);
    expect(await runUpdate([], deps)).toBe(0);
    const text = out.log.join("\n");
    expect(text).toContain("target origin/main = 4444444 (3 new commit(s))");
    expect(text).toContain("dependency changes: bun install will run");
    expect(text).toContain("CI check on target: none");
    expect(text).toContain("--apply would refuse: tracked local changes");
    expect(text).toContain("--apply would refuse: target CI is 'none'");
    expect(w.events).toEqual([]);
  });

  test("warns when manifests exist but no managed host was found", async () => {
    const w = makeWorld({ hosts: [] });
    const { deps, out } = fakeDeps(w);
    expect(await runUpdate(["--json"], deps)).toBe(0);
    const report = JSON.parse(out.stdout) as { warnings: string[] };
    expect(report.warnings.join("\n")).toContain(
      "1 workload manifest(s) in /srv/state/workloads but no running managed model host was found",
    );
  });

  test("an up-to-date checkout on main says so", async () => {
    const w = makeWorld({ head: sha(4), branch: "main", branches: new Map([["main", sha(4)]]) });
    const { deps, out } = fakeDeps(w);
    expect(await runUpdate(["--json"], deps)).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ result: "up-to-date" });
  });

  test("an unresolvable target is an error", async () => {
    const w = makeWorld();
    const { deps, out } = fakeDeps(w);
    expect(await runUpdate(["--ref", "origin/nope"], deps)).toBe(1);
    expect(out.stderr).toContain("cannot resolve target origin/nope");
  });

  test("usage errors exit 2, --help exits 0", async () => {
    const w = makeWorld();
    const { deps, out } = fakeDeps(w);
    expect(await runUpdate(["--nope"], deps)).toBe(2);
    expect(out.stderr).toContain("unknown flag --nope");
    expect(await runUpdate(["--help"], deps)).toBe(0);
    expect(out.stdout).toContain("Usage: llamactl update");
    expect(w.calls).toEqual([]);
  });
});
