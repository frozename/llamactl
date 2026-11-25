import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  doc,
  enclosingBody,
  expectPins,
  flat,
  readOrEmpty,
  REPO,
  sectionBody,
  sectionRe,
} from "./helpers.js";

// Part of #522

const serverSrc = readOrEmpty(join(REPO, "packages/core/src/server.ts"));
const probeSrc = readOrEmpty(join(REPO, "packages/core/src/probe.ts"));
const keepAliveSrc = readOrEmpty(join(REPO, "packages/core/src/keepAlive.ts"));
const cliServerSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/server.ts"));
const routerSrc = readOrEmpty(join(REPO, "packages/remote/src/router.ts"));
const mhSrc = readOrEmpty(join(REPO, "packages/remote/src/server/modelhost.ts"));

const INTRO =
  "A start that finds a healthy engine already running an unchanged spec adopts it instead of stopping and respawning it (#806 phase 2). An adopted start stops nothing and spawns nothing, and its result carries `adopted: true`; a fresh or drifted start leaves `adopted` absent.";
const MODELRUN_ADOPT =
  "For a ModelRun, core `startServer` (`packages/core/src/server.ts`) calls `adoptTrackedServer` before the stop-before-start above. It adopts the tracked engine only when the start did not pass `restart: true`, an installed residency lease registry (if any) reports the workload's phase as `open`, the state sidecar exists and its recorded `specHash` equals the hash of the requested launch, the tracked pid verifies `alive` against its pid file through the `verifyPidFile` pid-identity check (the recorded binary and rel on argv), `/health` answers with an ok status within 3 seconds (`ADOPT_PROBE_TIMEOUT_MS`), and the pid is still alive. The adopt leaves the pid and sidecar files untouched. When any condition fails, the start falls through to the fenced stop-before-start. The hash (`computeServerSpecHash`) covers the rel, the model path, `skipTuned`, the tuned profile, the injected alias, the extra args, the host, the port and the binary; the readiness probe, env and `apiKeyRef` are outside it.";
const PORT_CONFLICT_ADOPT =
  "When a ModelRun start finds something else already answering on its endpoint, `handlePortConflict` adopts that listener through `tryAdoptExistingServer` only if it advertises the rel, its basename or a declared `--alias`. It records the convergence `specHash` only when the listener's command line matches the launch argv a fresh start would spawn, so a foreign engine is recorded without a hash and the next same-spec start replaces it. This port-conflict adopt reports a plain success without `adopted: true`.";
const CLI_RESTART =
  "`llamactl server start <target> --restart` sends `restart: true` on the agent's `serverStart` procedure (`packages/remote/src/router.ts`) and forces a fresh launch. Without it, the human output of an adopted start appends ` (adopted)` to the `llama-server up pid=<pid> endpoint=<endpoint>` line, after ` tuned=<profile>` when a tuned profile is recorded.";
const KEEP_ALIVE =
  "The keep-alive worker (`packages/core/src/keepAlive.ts`) passes `restart: forceRestart` to core `startServer`. `forceRestart` is an in-memory flag of the worker loop: it is set after the health poll gets no 200 from `/health` within 2 seconds (or finds the pid file gone) and the worker is not stopping, and it is cleared only after the next successful start, so a server whose `/health` recovers before the restart is replaced rather than adopted, and a failed start or a refused pre-start gate keeps it armed. The worker writes the current value to its state file (`llama-keep-alive.state`) as `force_restart`; nothing sends it to the engine.";
const MODELDHOST_SIDECAR =
  "For a ModelHost, `startModelHost` (`packages/remote/src/server/modelhost.ts`) considers an adopt in `reapOrAdoptPriorHost` only after the recorded pid verifies `alive` against `modelhost.pid` (`verifyPidFile`, corroborated by the engine's binary names); an `unknown` verdict defers the start with `pid identity unknown; deferring restart`. `adoptUnchangedHost` then adopts the host only when no restart was requested (`StartModelHostOptions.restart`, or `restart` on the agent's `modelHostStart` input), an installed residency lease registry (if any) reports the phase as `open`, the recorded `specHash` equals `computeModelHostSpecHash` of the applied spec, the engine's readiness probe passes within 3 seconds, an advertised model id matches the first hosted model's rel or basename once declared `--alias` values in `spec.extraArgs` are folded onto that rel, and the recorded pid is still alive. The adopt runs ahead of the stop-before-start fence, leaves `modelhost.state` byte-for-byte untouched unless refreshing its out-of-hash `readiness` and `binaryNames` fields changes the record, and never rewrites `modelhost.pid`. When any condition fails, the prior host is torn down under that fence.";
const STARTING_RECORD =
  "When `modelhost.state` is missing, or its pid is gone and no live listener holds the endpoint, `startModelHost` checks `modelhost.starting`, the record an agent that died before readiness leaves behind. An `unknown` verdict against that record defers with `pid identity unknown; deferring restart`; for an `alive` one, `adoptOrDeferStartingHost` applies the same restart, residency-phase and spec-hash gates. If the readiness probe passes and the engine advertises the first hosted model's rel, its basename or a declared `--alias`, the record is promoted to a full `modelhost.state` and the start returns `adopted: true`. If the probe passes but the engine serves another model, the engine is torn down. If the probe does not pass, the start is deferred with `engine pid <pid> from the starting record is still loading; deferring restart` only while the record's `startedAt` is younger than the readiness budget (the start's `timeoutSeconds`, else the manifest's `spec.timeoutSeconds`); an older record is torn down, as is one that fails a gate.";

const body = sectionBody(sectionRe("adopting an unchanged engine"));
const s = flat(body ?? "");

describe("#522 adopting an unchanged engine", () => {
  test("subsection is placed inside the lease section before Status", () => {
    expect(body).toBeDefined();
    // Kills: the subsection moved out of the lease section, or put inside
    // Status.
    const lines = doc.split("\n");
    const adoptIdx = lines.findIndex((line) => line === "### Adopting an unchanged engine");
    const refusalsIdx = lines.findIndex((line) => line === "### Stop-before-start refusals");
    const statusIdx = lines.findIndex((line) => line === "## Status, plan and apply-profile");
    expect(adoptIdx).toBeGreaterThan(refusalsIdx);
    expect(adoptIdx).toBeLessThan(statusIdx);
  });

  test("intro paragraph pins the adopted flag on both start paths", () => {
    expect(body).toBeDefined();
    // Kills: tryAdoptLiveHost reporting `adopted: true`, or the doc claiming
    // it.
    expect(serverSrc).toContain("adopted?: boolean;");
    expect(mhSrc).toContain("adopted?: boolean;");
    expect(enclosingBody(mhSrc, "async function tryAdoptLiveHost(")).not.toContain("adopted: true");
    expectPins(s, "adopt intro", [INTRO]);
  });

  test("ModelRun adopt paragraph pins the adoptTrackedServer gates", () => {
    expect(body).toBeDefined();
    // Kills: dropping any adopt gate, a 3 s timeout change, adding a field to
    // the hash, or adopting after the stop.
    const adopt = enclosingBody(serverSrc, "async function adoptTrackedServer(");
    expectPins(adopt, "adoptTrackedServer", [
      "if (opts.restart === true) return null;",
      'registry.snapshot(key.name).phase !== "open"',
      "if (sidecar.specHash === undefined || sidecar.specHash !== currentHash) return null;",
      "const verdict = verifyPidFile(",
      'if (verdict !== "alive") return null;',
      "timeoutMs: ADOPT_PROBE_TIMEOUT_MS,",
      "if (!health.reachable) return null;",
      "if (!isProcessAlive(sidecar.pid)) return null;",
    ]);
    expect(adopt).not.toContain("findListenerPid");
    expect(serverSrc).toContain("const ADOPT_PROBE_TIMEOUT_MS = 3000;");
    expect(probeSrc).toContain("return { reachable: res.ok };");
    const hash = enclosingBody(serverSrc, "function computeServerSpecHash(");
    expectPins(hash, "computeServerSpecHash", [
      "rel: spec.rel,",
      "modelPath: spec.modelPath,",
      "skipTuned: spec.skipTuned,",
      "tunedProfile: spec.tunedProfile,",
      "alias: spec.alias,",
      "extraArgs: [...spec.extraArgs],",
      "host: spec.host,",
      "port: spec.port,",
      "binary: spec.binary,",
    ]);
    expect(hash).not.toContain("readiness");
    expect(hash).not.toContain("env");
    expect(hash).not.toContain("apiKeyRef");
    const order = enclosingBody(serverSrc, "async function stopOrAdoptBeforeStart(");
    expect(order.indexOf("adoptTrackedServer(")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("adoptTrackedServer(")).toBeLessThan(order.indexOf("stopBeforeStart("));
    expect(s).not.toContain("`findListenerPid` verdict");
    expectPins(s, "ModelRun adopt", [MODELRUN_ADOPT]);
  });

  test("port-conflict adopt paragraph pins tryAdoptExistingServer", () => {
    expect(body).toBeDefined();
    // Kills: stamping the hash unconditionally, or reporting adopted on this
    // path.
    const conflict = enclosingBody(serverSrc, "async function handlePortConflict(");
    expectPins(conflict, "handlePortConflict", [
      "tryAdoptExistingServer({",
      "expectedLaunchArgs,",
      "return startServerSuccess(resolved, launchEndpoint, null, false, adoptedPid, opts.onEvent);",
    ]);
    expect(conflict).not.toContain("adopted: true");
    const adopt = enclosingBody(serverSrc, "export async function tryAdoptExistingServer(");
    expectPins(adopt, "tryAdoptExistingServer", [
      "const adoptedSpecHash = args.specHash !== undefined && argvMatches ? args.specHash : undefined;",
      "...aliasesFromArgs(args.extraArgs),",
    ]);
    expectPins(s, "port-conflict adopt", [PORT_CONFLICT_ADOPT]);
  });

  test("CLI paragraph pins restart forwarding and the adopted suffix order", () => {
    expect(body).toBeDefined();
    // Kills: the flag not forwarded, or the suffix dropped or reordered.
    expectPins(cliServerSrc, "cli server start", [
      "start <target> [--name <workload>] [--timeout=<s>] [--no-tuned] [--restart] [--json] [-- extra-args]",
      "if (parsed.restart) input.restart = parsed.restart;",
      "getNodeClient().serverStart.subscribe(input, handlers)",
    ]);
    expect(
      cliServerSrc.indexOf('${result.tunedProfile ? ` tuned=${result.tunedProfile}` : ""}'),
    ).toBeLessThan(cliServerSrc.indexOf('${result.adopted ? " (adopted)" : ""}'));
    expect(routerSrc).toContain(
      "...(input.restart !== undefined ? { restart: input.restart } : {}),",
    );
    expectPins(s, "CLI adopt", [CLI_RESTART]);
  });

  test("keep-alive paragraph pins the forceRestart lifecycle", () => {
    expect(body).toBeDefined();
    // Kills: disarming before the start result is checked, sending the flag
    // elsewhere, or the doc repeating the rejected claim.
    expectPins(keepAliveSrc, "keepAlive", [
      "let forceRestart = false;",
      "force_restart: forceRestart,",
      "restart: forceRestart,",
      "forceRestart = true;",
      'return join(resolved.LOCAL_AI_RUNTIME_DIR, "llama-keep-alive.state");',
    ]);
    expect(keepAliveSrc.lastIndexOf("forceRestart = false;")).toBeGreaterThan(
      keepAliveSrc.indexOf("if (!startRes.ok) {"),
    );
    const poll = enclosingBody(keepAliveSrc, "async function pollHealthUntilDown(");
    expectPins(poll, "pollHealthUntilDown", [
      "ok = res.status === 200;",
      "AbortSignal.timeout(2000)",
    ]);
    expect(keepAliveSrc).not.toContain("modelHostStart");
    expect(s).not.toContain("survive across restarts");
    expect(s).not.toContain("to `modelHostStart` and `force_restart`");
    expectPins(s, "keep-alive adopt", [KEEP_ALIVE]);
  });

  test("ModelHost sidecar paragraph pins adoptUnchangedHost behind identity", () => {
    expect(body).toBeDefined();
    // Kills: adopting before identity verification, dropping the alias fold,
    // an unconditional sidecar rewrite, or the adopt moved behind the fence.
    const adopt = enclosingBody(mhSrc, "async function adoptUnchangedHost(");
    expectPins(adopt, "adoptUnchangedHost", [
      '.phase !== "open"',
      "if (opts.restart === true) return null;",
      "if (priorState.specHash === undefined || priorState.specHash !== currentHash) return null;",
      "ADOPT_PROBE_TIMEOUT_MS",
      "if (!readiness.ready) return null;",
      "foldDeclaredAliases(manifest.spec.extraArgs, readiness, firstHostedModel.rel);",
      "const aliases = new Set([firstHostedModel.rel, basename(firstHostedModel.rel)]);",
      "if (!isProcessAlive(priorState.pid)) return null;",
      "if (JSON.stringify(refreshed) !== JSON.stringify(priorState)) {",
      "writeFileSync(modelhostStateFile(resolved, opts.key)",
    ]);
    expect(adopt).not.toContain("modelhostPidFile");
    const reap = enclosingBody(mhSrc, "async function reapOrAdoptPriorHost(");
    expectPins(reap, "reapOrAdoptPriorHost", [
      "const recordPath = modelhostPidFile(resolved, opts.key);",
      'error: "pid identity unknown; deferring restart"',
    ]);
    const aliveIdx = reap.indexOf('priorVerdict === "alive"');
    const adoptIdx = reap.indexOf("adoptUnchangedHost(");
    const fenceIdx = reap.indexOf("fencePriorHostTeardown(");
    expect(aliveIdx).toBeGreaterThanOrEqual(0);
    expect(adoptIdx).toBeGreaterThan(aliveIdx);
    expect(fenceIdx).toBeGreaterThan(adoptIdx);
    expect(mhSrc).toContain("const ADOPT_PROBE_TIMEOUT_MS = 3000;");
    const inputStart = routerSrc.indexOf("const modelHostStartInput = z.object({");
    const inputEnd = routerSrc.indexOf("});", inputStart);
    expect(inputStart).toBeGreaterThanOrEqual(0);
    expect(inputEnd).toBeGreaterThan(inputStart);
    expect(routerSrc.slice(inputStart, inputEnd)).toContain("restart: z.boolean().optional(),");
    expect(s).not.toContain("advertises a declared `--alias`; and");
    expectPins(s, "ModelHost sidecar adopt", [MODELDHOST_SIDECAR]);
  });

  test("starting-record paragraph pins adoptOrDeferStartingHost", () => {
    expect(body).toBeDefined();
    // Kills: deferring forever without the budget, promoting a wrong-model
    // engine, or the doc's defer condition drifting.
    const adopt = enclosingBody(mhSrc, "async function adoptOrDeferStartingHost(");
    expectPins(adopt, "adoptOrDeferStartingHost", [
      '.phase !== "open"',
      "if (opts.restart === true) return null;",
      "if (starting.specHash === undefined || starting.specHash !== currentHash) return null;",
      "servesHostedModel(manifest, readiness.modelIds)",
      "removeModelHostStarting(opts.key, resolved);",
      "return { ok: true, pid: starting.pid, adopted: true };",
      "if (readiness.ready) return null;",
      "const budgetMs = (opts.timeoutSeconds ?? manifest.spec.timeoutSeconds) * 1000;",
      "if (Date.now() - Date.parse(starting.startedAt) >= budgetMs) return null;",
      "from the starting record is still loading; deferring restart",
    ]);
    const serves = enclosingBody(mhSrc, "function servesHostedModel(");
    expect(serves).toContain("...aliasesFromExtraArgs(manifest.spec.extraArgs),");
    const orphan = enclosingBody(mhSrc, "async function reapStartingOrphan(");
    expect(orphan).toContain('if (verdict === "unknown") {');
    expect(orphan.indexOf("adoptOrDeferStartingHost(")).toBeGreaterThanOrEqual(0);
    expect(orphan.indexOf("confirmRecordedTeardown(")).toBeGreaterThanOrEqual(0);
    expect(orphan.indexOf("adoptOrDeferStartingHost(")).toBeLessThan(
      orphan.indexOf("confirmRecordedTeardown("),
    );
    const reap = enclosingBody(mhSrc, "async function reapOrAdoptPriorHost(");
    const marker = "return await reapStartingOrphan(manifest, opts, resolved, engine);";
    expect(reap.split(marker).length - 1).toBe(2);
    expect(s).not.toContain("when the probe times out or the engine has not yet loaded");
    expectPins(s, "starting-record adopt", [STARTING_RECORD]);
  });
});
