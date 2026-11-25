import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { existsSync } from "../../../src/safe-fs.js";
import { doc, enclosingBody, flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

// Part of #522: load and prefill metrics slice
// Source pins run before doc pins so a source mutant surfaces its own
// needle; the doc subsection does not exist at base, so the doc
// assertions fail.
describe("#522 load and prefill metrics (#781)", () => {
  const runnerSrc = readOrEmpty(join(REPO, "packages/eval/src/perf/runner.ts"));
  const suitesSrc = readOrEmpty(join(REPO, "packages/eval/src/perf/suites.ts"));
  const clientSrc = readOrEmpty(join(REPO, "packages/eval/src/perf/client.ts"));
  const evalPerfSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/eval-perf.ts"));
  const benchScheduleSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/bench-schedule.ts"));
  const serveSrc = readOrEmpty(join(REPO, "packages/remote/src/server/serve.ts"));
  const openaiSrc = readOrEmpty(join(REPO, "packages/core/src/openaiProxy.ts"));

  const buildOptsBody = enclosingBody(evalPerfSrc, "function buildOpts(");
  const benchBody = enclosingBody(benchScheduleSrc, "export function createPerfBenchSuiteRunner(");
  const loadHookBody = enclosingBody(runnerSrc, "async function runLoadHook(");
  const prefillBody = enclosingBody(runnerSrc, "async function runPrefillSize(");

  const sec = flat(sectionBody(/^### Load and prefill metrics for an arm/) ?? "");

  // Kills: deleting or misplacing the subsection.
  test("subsection sits in the eval record after comparing perf runs", () => {
    expect(sec.length).toBeGreaterThan(0);
    const lines = doc.split("\n");
    const loadIdx = lines.indexOf("### Load and prefill metrics for an arm");
    const cmpIdx = lines.indexOf("### Comparing perf runs for an arm");
    expect(loadIdx).toBeGreaterThan(cmpIdx);
    expect(lines.slice(cmpIdx + 1, loadIdx).some((line) => line.startsWith("## "))).toBe(false);
  });

  // Kills: a scheduled suite injecting load hooks, eval perf injecting them
  // without --launch, or the doc claiming an unmanaged load is measured.
  test("a scheduled suite never injects load hooks; eval perf only with --launch", () => {
    expect(runnerSrc).toContain("export interface PerfSuiteLoadHooks");
    expect(runnerSrc).toContain("The runner performs no readiness");
    const loadAssignments = buildOptsBody.match(/\bload:/g) ?? [];
    expect(loadAssignments).toHaveLength(1);
    expect(buildOptsBody).toContain("load: input.launchHooks");
    expect(benchBody).not.toMatch(/\bload:/);
    for (const needle of [
      "are measured only when the caller injects load hooks",
      "(`PerfSuiteLoadHooks` and `runLoadHook`, `packages/eval/src/perf/runner.ts`)",
      "it performs no readiness probe of its own",
      "A scheduled suite never injects load hooks, and `llamactl eval perf` injects them only with `--launch`",
      "so from a scheduled suite, and from `eval perf` without `--launch`, the two load metrics are always recorded `unavailable`",
    ]) {
      expect(sec, needle).toContain(needle);
    }
  });

  // Kills: changing either reason text, dropping the loadReason forwarding,
  // or swapping the two reasons.
  test("per-caller load reasons", () => {
    expect(buildOptsBody).toContain(
      "eval perf runs against an engine already serving '${input.model}' at ${input.url}; it does not launch or reload the engine, so cold/warm model-load time is not measured",
    );
    expect(benchBody).toContain(
      "model load for ${req.rel} happens on node '${req.node}'; scheduled suites reach an already-serving engine through the agent gateway and do not load or reload it, so cold/warm load time is not measured",
    );
    expect(benchBody).toContain("loadReason,");
    for (const needle of [
      "`eval perf runs against an engine already serving '<model>' at <url>; it does not launch or reload the engine, so cold/warm model-load time is not measured`",
      "(`buildOpts`, `packages/cli/src/commands/eval-perf.ts`)",
      "`model load for <rel> happens on node '<node>'; scheduled suites reach an already-serving engine through the agent gateway and do not load or reload it, so cold/warm load time is not measured`",
      "(`createPerfBenchSuiteRunner`, `packages/cli/src/commands/bench-schedule.ts`)",
    ]) {
      expect(sec, needle).toContain(needle);
    }
  });

  // Kills: changing the fallback text, changing the step-failure format,
  // removing the non-finite guard, or deleting its `>= 0` half.
  test("load fallback, hook failure and invalid elapsed time", () => {
    expect(loadHookBody).toContain(
      'run.opts.loadReason ?? "no load hooks injected (engine not managed by the suite)"',
    );
    expect(loadHookBody).toContain("Number.isFinite(elapsed) && elapsed >= 0");
    expect(loadHookBody).toContain('unavailableMetric("non-finite load time")');
    expect(loadHookBody).toContain("await hook();");
    expect(enclosingBody(runnerSrc, "function createPerfSuiteRun(")).toContain(
      "`${name} failed: ${message}`",
    );
    for (const needle of [
      "`no load hooks injected (engine not managed by the suite)`",
      "records `<metric> failed: <message>`",
      "a non-finite or negative elapsed time records `non-finite load time`",
      "the perf diff reports both load metrics `unavailable` for runs from these commands, never `regressed`",
    ]) {
      expect(sec, needle).toContain(needle);
    }
  });

  // Kills: reordering or dropping a ctx source, or changing the
  // unknown-ctx reason.
  test("context resolution order", () => {
    const resolveBody = enclosingBody(runnerSrc, "async function resolveModelCtx(");
    const resolveOrder = [
      "run.opts.ctx ?? null",
      "run.opts.provenance.ctx",
      "ctxFromModelsPayload(await run.client.listModels())",
    ];
    let cursor = -1;
    for (const needle of resolveOrder) {
      const at = resolveBody.indexOf(needle);
      expect(at, needle).toBeGreaterThan(cursor);
      cursor = at;
    }
    const payloadBody = enclosingBody(runnerSrc, "function ctxFromModelsPayload(");
    const payloadOrder = [
      'entry["context_length"]',
      'entry["max_model_len"]',
      'meta?.["n_ctx"]',
      'meta?.["n_ctx_train"]',
    ];
    cursor = -1;
    for (const needle of payloadOrder) {
      const at = payloadBody.indexOf(needle);
      expect(at, needle).toBeGreaterThan(cursor);
      cursor = at;
    }
    const suiteBody = enclosingBody(runnerSrc, "export async function runPerfSuite(");
    const loadAt = suiteBody.indexOf("await runLoadPhase(");
    const ctxAt = suiteBody.indexOf("await resolveModelCtx(");
    const prefillAt = suiteBody.indexOf("await runPrefillPhase(");
    expect(loadAt).toBeLessThan(ctxAt);
    expect(ctxAt).toBeLessThan(prefillAt);
    for (const needle of [
      "Prefill runs after the load phase",
      "the suite's `ctx` option (`--ctx` on `eval perf`), then the provenance `ctx`, then the first `/v1/models` entry's `context_length`, `max_model_len`, `meta.n_ctx` or `meta.n_ctx_train`",
      "(`resolveModelCtx`, `packages/eval/src/perf/runner.ts`)",
      "`model context unknown`",
    ]) {
      expect(sec, needle).toContain(needle);
    }
  });

  // Kills: changing any prefill reason or the 8-token tolerance, moving
  // the token-exact build after the context guard, or moving the
  // unknown-context check after the build.
  test("prefill refusals", () => {
    for (const needle of [
      '"model context unknown"',
      '"could not build a token-exact prompt"',
      "prefill ${String(tokens)} tokens exceeds model context ${String(ctx)}",
      "engine counted ${String(stream.promptTokens)} prompt tokens for target ${String(tokens)}",
      "> 8",
      "tokens + run.decodeTokens > ctx",
    ]) {
      expect(prefillBody, needle).toContain(needle);
    }
    expect(prefillBody.indexOf('"model context unknown"')).toBeLessThan(
      prefillBody.indexOf("await buildTokenExactPrompt("),
    );
    expect(prefillBody.indexOf("await buildTokenExactPrompt(")).toBeLessThan(
      prefillBody.indexOf("tokens + run.decodeTokens > ctx"),
    );
    expect(runnerSrc).toContain('tokens: 4096, metricName: "prefill_4k_tps"');
    expect(runnerSrc).toContain('tokens: 65536, metricName: "prefill_64k_tps"');
    expect(suitesSrc).toContain('"perf-quick": { decodeTokens: 16');
    expect(suitesSrc).toContain('"perf-full": { decodeTokens: 64');
    for (const needle of [
      "before the context guard",
      "`could not build a token-exact prompt`",
      "(16 for `perf-quick`, 64 for `perf-full`; `PERF_SUITES`, `packages/eval/src/perf/suites.ts`)",
      "`prefill <n> tokens exceeds model context <ctx>`",
      "more than 8 off the target records `engine counted <n> prompt tokens for target <target>`",
      "(`runPrefillSize`, `packages/eval/src/perf/runner.ts`)",
    ]) {
      expect(sec, needle).toContain(needle);
    }
  });

  // Kills: changing the tokenize default path or error text; a caller
  // overriding tokenizePath; a scheduled suite starting to set a ctx or
  // dropping its prefill reason; the gateway's /v1/models entries gaining
  // a context field; the gateway routing non-/v1 paths; or the doc
  // blaming /tokenize instead of the unknown context.
  test("tokenize endpoint and scheduled-suite prefill", () => {
    expect(clientSrc).toContain('tokenizePath: options.tokenizePath ?? "/tokenize"');
    expect(clientSrc).toContain("tokenize HTTP ${String(resp.status)} at ${ctx.tokenizePath}");
    expect(buildOptsBody).not.toContain("tokenizePath");
    expect(benchBody).not.toContain("tokenizePath");
    expect(enclosingBody(evalPerfSrc, "export async function runEvalPerf(")).not.toContain(
      "tokenizePath",
    );
    expect(benchBody).toContain("ctx: null,");
    const start = benchBody.indexOf("ev.runPerfSuite)(db, {");
    expect(start).toBeGreaterThanOrEqual(0);
    const loadReasonAt = benchBody.indexOf("loadReason,", start);
    expect(loadReasonAt).toBeGreaterThan(start);
    expect(benchBody.slice(start, loadReasonAt)).not.toMatch(/\bctx\b/);
    expect(suitesSrc).not.toMatch(/\bctx\b/);
    const modelsBody = enclosingBody(openaiSrc, "function buildListOpenAIModels(");
    expect(modelsBody).toContain('capabilities: ["chat"]');
    expect(modelsBody).not.toMatch(/context_length|max_model_len|n_ctx|\bmeta\b/);
    expect(enclosingBody(openaiSrc, "export async function listServingOpenAIModels(")).not.toMatch(
      /context_length|max_model_len|n_ctx|\bmeta\b/,
    );
    expect(serveSrc).toContain('url.pathname.startsWith("/v1/") || url.pathname === "/v1"');
    for (const needle of [
      "(the `tokenizePath` default in `createHttpPerfEngineClient`, `packages/eval/src/perf/client.ts`)",
      "records `<metric> failed: tokenize HTTP <status> at /tokenize`",
      "A scheduled suite never measures prefill",
      "the gateway's `/v1/models` entries carry no `context_length`, `max_model_len` or `meta` (`buildListOpenAIModels`, `packages/core/src/openaiProxy.ts`)",
      "`runPrefillSize` records that reason for every prefill size before any context check and without calling `/tokenize`",
      "The gateway routes only `/v1/*` paths, and `/tokenize` is not one of them",
      "run `llamactl eval perf` against the engine's own URL",
    ]) {
      expect(sec, needle).toContain(needle);
    }
    // The perf runner records the reason; the gateway records nothing (#521).
    expect(sec, "gateway credited as the recorder").not.toContain("gateway records");
  });

  // Kills: adding `|| url.pathname === "/tokenize"` to the gateway's /v1
  // guard in serve.ts (P9), or a separate /tokenize route in
  // handleOpenAIRoute (P13). Either makes the doc's "/tokenize is not
  // routed by the agent gateway" claim false.
  test("agent gateway routes no /tokenize path", () => {
    expect(serveSrc).toContain('url.pathname.startsWith("/v1/") || url.pathname === "/v1"');
    expect(serveSrc).not.toMatch(/["'`]\/tokenize/);
    expect(serveSrc).not.toContain("tokenize");
    const routeBody = enclosingBody(serveSrc, "async function handleOpenAIRoute(");
    expect(routeBody.length).toBeGreaterThan(0);
    expect(routeBody).not.toContain("tokenize");
  });

  // Kills: a moved or renamed file, or a line-number citation.
  test("citations exist, never file:line", () => {
    const cited = [...sec.matchAll(/`(packages\/[^`]+\.ts)`/g)].flatMap((m) =>
      m[1] === undefined ? [] : [m[1]],
    );
    expect(cited.length).toBeGreaterThan(0);
    for (const p of cited) {
      expect(existsSync(join(REPO, p)), p).toBe(true);
    }
    for (const p of [
      "packages/eval/src/perf/runner.ts",
      "packages/eval/src/perf/suites.ts",
      "packages/eval/src/perf/client.ts",
      "packages/cli/src/commands/eval-perf.ts",
      "packages/cli/src/commands/bench-schedule.ts",
      "packages/core/src/openaiProxy.ts",
    ]) {
      expect(cited, p).toContain(p);
    }
    expect(/\.ts:\d/.test(sec)).toBe(false);
  });
});
