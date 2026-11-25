import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { doc, enclosingBody, flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

// Part of #521: eval perf --launch measured-load slice. Source pins run
// before doc pins so a source mutant surfaces its own needle; the launch
// module and doc subsection do not exist at base, so both fail by assertion.
describe("#521 eval perf launch load", () => {
  const evalPerfSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/eval-perf.ts"));
  const launchSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/eval-perf-launch.ts"));
  const src = `${evalPerfSrc}\n${launchSrc}`;
  const sec = flat(sectionBody(/^### Measured load with --launch/) ?? "");

  const stringPins = [
    {
      name: "engine refusal",
      source:
        "--launch starts llama-server through the eval matrix lifecycle and supports only --engine llamacpp (got ${engine})",
      doc: "--launch starts llama-server through the eval matrix lifecycle and supports only --engine llamacpp (got <engine>)",
    },
    {
      name: "loopback refusal",
      source:
        "--launch needs a loopback --url (got ${hostname}); the engine is started on this machine",
      doc: "--launch needs a loopback --url (got <host>); the engine is started on this machine",
    },
    {
      name: "IPv6 refusal",
      source:
        "--launch does not support an IPv6 --url (got ${hostname}); use 127.0.0.1 or localhost",
      doc: "--launch does not support an IPv6 --url (got <host>); use 127.0.0.1 or localhost",
    },
    {
      name: "explicit-port refusal",
      source: "--launch needs an explicit port in --url",
      doc: "--launch needs an explicit port in --url",
    },
    {
      name: "binary-and-gguf refusal",
      source: "--launch needs --binary <path> and --gguf <path>",
      doc: "--launch needs --binary <path> and --gguf <path>",
    },
    {
      name: "missing-binary refusal",
      source: "--launch needs an existing --binary (not found: ${binary})",
      doc: "--launch needs an existing --binary (not found: <path>)",
    },
    {
      name: "missing-gguf refusal",
      source: "--launch needs an existing --gguf (not found: ${gguf})",
      doc: "--launch needs an existing --gguf (not found: <path>)",
    },
    {
      name: "pid refusal",
      source:
        "--pid cannot be combined with --launch; the launched engine's PID is not known before the suite starts",
      doc: "--pid cannot be combined with --launch; the launched engine's PID is not known before the suite starts",
    },
    {
      name: "launch-value refusal",
      source: "--launch takes no value",
      doc: "--launch takes no value",
    },
    {
      name: "preflight occupied",
      source:
        "--launch needs a free port, but something is already answering at ${url} (GET /health returned HTTP ${status})",
      doc: "--launch needs a free port, but something is already answering at <url> (GET /health returned HTTP <status>)",
    },
    {
      name: "not-owned run refusal",
      source:
        "--launch did not start the engine at ${url}; run ${runId} measured an engine it did not launch",
      doc: "--launch did not start the engine at <url>; run <run-id> measured an engine it did not launch",
    },
    {
      name: "not-owned load reason",
      source:
        "an engine was already serving at ${host}:${String(port)} before --launch started one; cold/warm load is measured only for an engine eval perf starts",
      doc: "an engine was already serving at <host>:<port> before --launch started one; cold/warm load is measured only for an engine eval perf starts",
    },
    {
      name: "launch failure",
      source: "--launch failed to start the engine at ${url}: ${message}",
      doc: "--launch failed to start the engine at <url>: <message>",
    },
    {
      name: "slots reason",
      source:
        "--launch starts the engine inside the perf suite, so GET /props is not probed before the run; pass --slots <n> to measure c2/c4",
      doc: "--launch starts the engine inside the perf suite, so GET /props is not probed before the run; pass --slots <n> to measure c2/c4",
    },
  ] as const;

  // Kills: rewording any user-facing launch string in the implementation.
  test("source pins every launch string the doc quotes", () => {
    for (const pin of stringPins) {
      expect(src, pin.name).toContain(pin.source);
    }
  });

  // Kills: bypassing the eval matrix lifecycle by spawning llama-server
  // directly, or dropping ownership-aware teardown.
  test("source pins the matrix lifecycle dependency seam", () => {
    expect(launchSrc).toContain("defaultLaunchDeps");
    expect(launchSrc).toContain(
      'import { ensureModelServing, teardownIfOwned } from "@llamactl/eval";',
    );
    const deps = enclosingBody(launchSrc, "export const defaultLaunchDeps");
    expect(deps, "defaultLaunchDeps body").not.toBe("");
    expect(deps).toContain("ensure: ensureModelServing");
    expect(deps).toContain("teardown: teardownIfOwned");
    expect(launchSrc).not.toContain("spawnServer");
  });

  // Kills: timing the cold boot's teardown into load_warm_ms, either by the
  // launch warm hook tearing down itself or by the runner starting the warm
  // clock before beforeWarm runs.
  test("source pins teardown outside the timed warm window", () => {
    const hooks = enclosingBody(launchSrc, "export function createLaunchLoadHooks(");
    expect(hooks).toContain("const beforeWarm = teardown;");
    expect(hooks).toContain("hooks: { cold, beforeWarm, warm },");
    const warm = enclosingBody(hooks, "const warm = async (): Promise<void> =>");
    expect(warm, "warm hook body").not.toBe("");
    expect(warm).not.toContain("teardown");
    const runnerSrc = readOrEmpty(join(REPO, "packages/eval/src/perf/runner.ts"));
    const hook = enclosingBody(runnerSrc, "async function runLoadHook(");
    const prepareIdx = hook.indexOf("if (prepare !== undefined) await prepare();");
    const t0Idx = hook.indexOf("const t0 = run.clock.now();");
    expect(prepareIdx).toBeGreaterThanOrEqual(0);
    expect(t0Idx).toBeGreaterThan(prepareIdx);
  });

  // Kills: dropping the exclusive-group gate, or keying it only on --model
  // without resolving a gguf path inside LLAMA_CPP_MODELS back to its rel.
  test("source pins the residency gate and models-dir group derivation", () => {
    expect(src).toContain("exclusiveGroupLaunchRefusal(");
    const needles = ["LLAMA_CPP_MODELS", "catalog.findByRel", "residencyGroup"] as const;
    for (const needle of needles) {
      expect(src.indexOf(needle), needle).toBeGreaterThanOrEqual(0);
    }
    const positions = needles.map((needle) => src.indexOf(needle));
    expect(Math.max(...positions) - Math.min(...positions)).toBeLessThan(1200);
  });

  // Kills: deleting or misplacing the subsection.
  test("doc subsection sits directly between load/prefill and host reader failures", () => {
    expect(sec.length).toBeGreaterThan(0);
    const lines = doc.split("\n");
    const loadIdx = lines.indexOf("### Load and prefill metrics for an arm");
    const measuredIdx = lines.indexOf("### Measured load with --launch");
    const hostIdx = lines.indexOf("### Host reader failures for an arm");
    expect(loadIdx).toBeGreaterThanOrEqual(0);
    expect(measuredIdx).toBeGreaterThan(loadIdx);
    expect(hostIdx).toBeGreaterThan(measuredIdx);
    expect(lines.slice(loadIdx + 1, measuredIdx).some((line) => /^#{1,6} /.test(line))).toBe(false);
    expect(lines.slice(measuredIdx + 1, hostIdx).some((line) => /^#{1,6} /.test(line))).toBe(false);
  });

  // Kills: the doc drifting byte-for-byte from any implementation string.
  test("doc quotes the launch strings byte-for-byte in placeholder form", () => {
    for (const pin of stringPins) {
      expect(sec, pin.name).toContain(`\`${pin.doc}\``);
    }
  });

  // Kills: the doc claiming the wrong lifecycle order or omitting the
  // finally-teardown and ownership semantics.
  test("doc pins the measured-load lifecycle semantics", () => {
    for (const needle of [
      "the cold hook calls `ensureModelServing`",
      "the untimed `beforeWarm` hook calls `teardownIfOwned`, the warm hook calls `ensureModelServing` again",
      "the runner calls `beforeWarm` before it starts the warm clock, so `load_warm_ms` excludes tearing the cold boot down",
      "a final `teardownIfOwned` runs in `finally` even when the suite throws",
      "`load_cold_ms` and `load_warm_ms` are measured only for an engine eval perf starts",
      "a boot that is not `owned` means another engine won the port race",
    ]) {
      expect(sec, needle).toContain(needle);
    }
  });
});
