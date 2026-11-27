// Part of #285 (DF-12 AC4): pins docs/dynamic-residency.md against source.
// Repo files only — no network, no processes, no live state — so a missing
// or stale doc fails by assertion, never by throw.
import { routingCatalog } from "@llamactl/core";
import { describe, expect, test } from "bun:test";
import { basename, join, relative, resolve } from "node:path";

import {
  INTERRUPTED_LIFECYCLE_STATES,
  PROFILE_SWITCH_BOOT_RECOVERY_MIN_AGE_MS,
} from "../../src/residency/boot-recovery.js";
import {
  RESIDENCY_PROFILES_ANNOTATION,
  RESIDENCY_PROTECTED_ANNOTATION,
} from "../../src/residency/coordinator.js";
import { defaultResidencyStorePath } from "../../src/residency/store.js";
import { existsSync } from "../../src/safe-fs.js";
import { lockFilePath } from "../../src/workload/lock.js";
import { MANAGED_BY_LABEL } from "../../src/workload/modelhost-schema.js";
import { ResidencyPolicySchema } from "../../src/workload/noderun-schema.js";
import {
  AGENT_CLI,
  bulletLead,
  chatAdmissionUncountedBullets,
  codeSpans,
  DOC,
  doc,
  enclosingBody,
  expectPins,
  flat,
  missingRequiredFlags,
  productionRefs,
  readOrEmpty,
  registeredInInstallTest,
  REPO,
  RESIDENCY_CLI,
  residencyCommands,
  residencyRequiredFlags,
  sectionBody,
  sectionRe,
  SECTIONS,
  unknownCommands,
  unknownEnv,
} from "./dynamic-residency/helpers.js";

describe("docs/dynamic-residency.md (#285)", () => {
  // Kills: deleting the doc, or renaming the legacy-launcher heading.
  test("case 1: doc exists with every runbook section", () => {
    expect(existsSync(DOC)).toBe(true);
    for (const [name, heading] of Object.entries(SECTIONS)) {
      expect(sectionBody(heading), `runbook section "${name}" missing`).toBeDefined();
    }
  });

  // Kills: adding `LLAMACTL_RESIDENCY_AUTO` to the doc, or a truncated
  // wildcard such as LLAMACTL_CHAT_ADMISSION_.
  test("case 2: every LLAMACTL_* var the doc names is read in source and registered in worker-rpc-install", () => {
    expect(unknownEnv(["LLAMACTL_NOT_A_REAL_KNOB"])).toEqual(["LLAMACTL_NOT_A_REAL_KNOB"]);
    expect(registeredInInstallTest("LLAMACTL_RESIDENCY_STORE")).toBe(true);
    expect(registeredInInstallTest("LLAMACTL_NODE_NAME")).toBe(true);

    const REQUIRED_ENV = [
      "LLAMACTL_RESIDENCY_STORE",
      "LLAMACTL_RESIDENCY_LEASES",
      "LLAMACTL_RESIDENCY_SESSION_IDLE_MS",
      "LLAMACTL_CHAT_ADMISSION_MAX_EXECUTIONS",
      "LLAMACTL_CHAT_ADMISSION_MAX_QUEUED",
      "LLAMACTL_DECLARED_MODELS",
      "LLAMACTL_NODE_NAME",
      "LLAMACTL_WORKLOADS_DIR",
    ];
    const docVars = [...new Set([...doc.matchAll(/LLAMACTL_[A-Z0-9_]+/g)].map((m) => m[0]))].sort();
    for (const name of REQUIRED_ENV) expect(docVars).toContain(name);
    expect(unknownEnv(docVars)).toEqual([]);
  });

  // Kills: renaming `sub === "cancel-operation"` in residency.ts, adding
  // `llamactl residency evict-all` to the doc, making --yes optional in the
  // USAGE release-session synopsis, or documenting release-session without
  // --yes.
  test("case 3: every llamactl command in code spans is a real verb/subcommand", () => {
    const spans = codeSpans(doc).join("\n");
    for (const command of [
      "llamactl residency status",
      "llamactl residency plan",
      "llamactl residency apply-profile",
      "llamactl residency cancel-operation",
      "llamactl residency force-unload",
      "llamactl residency release-session",
      "llamactl controller serve",
      "llamactl agent serve",
      "llamactl apply -f",
      "llamactl keep-alive status",
      "llamactl keep-alive stop",
      "llamactl server stop",
    ]) {
      expect(spans).toContain(command);
    }
    expect(doc).toContain("--execute --yes");
    expect(unknownCommands(doc)).toEqual([]);

    // Every residency command the doc shows carries the flags USAGE marks
    // required. Kills: dropping --to from a documented apply-profile.
    const required = residencyRequiredFlags();
    for (const [sub, flags] of [
      ["plan", ["--node", "--to"]],
      ["apply-profile", ["--node", "--to"]],
      ["status", ["--node"]],
      ["force-unload", ["--reason", "--yes"]],
      ["release-session", ["--yes"]],
    ] as const) {
      for (const flag of flags) {
        expect(required.get(sub) ?? [], `USAGE required flags for ${sub}`).toContain(flag);
      }
    }
    const shown = new Set(residencyCommands(doc).map((c) => c.sub));
    for (const sub of shown) expect(required.has(sub), `USAGE line for ${sub}`).toBe(true);
    for (const sub of [
      "plan",
      "apply-profile",
      "cancel-operation",
      "force-unload",
      "release-session",
    ]) {
      expect(shown.has(sub), `doc shows residency ${sub}`).toBe(true);
    }
    expect(missingRequiredFlags(doc, required)).toEqual([]);
    expect(
      missingRequiredFlags("`llamactl residency apply-profile --node n --execute --yes`", required),
    ).toEqual(["llamactl residency apply-profile --node n --execute --yes: missing --to"]);

    expect(unknownCommands("`llamactl residency evict-all`")).toEqual(["residency evict-all"]);
    expect(unknownCommands("`llamactl frobnicate`")).toEqual(["frobnicate"]);
    expect(unknownCommands("`llamactl enable foo` `llamactl residency`")).toEqual([]);
  });

  // Kills: renaming operations.sqlite in store.ts.
  test("case 4: store location and backups anchored to store.ts", () => {
    expect(defaultResidencyStorePath({ LLAMACTL_RESIDENCY_STORE: "/x/s.sqlite" })).toBe(
      "/x/s.sqlite",
    );
    const storeRel = relative("/BASE", defaultResidencyStorePath({ DEV_STORAGE: "/BASE" }));
    expect(storeRel).toBe("residency/operations.sqlite");
    const section = sectionBody(SECTIONS.storeBackups) ?? "";
    for (const needle of [
      storeRel,
      "`LLAMACTL_RESIDENCY_STORE`",
      "DEV_STORAGE",
      "~/.llamactl",
      "WAL",
      ".backup",
      "packages/remote/src/residency/store.ts",
    ]) {
      expect(section).toContain(needle);
    }
    // The backup snippet resolves the path like defaultResidencyStorePath
    // and backs up through that variable, never a hardcoded store path.
    const resolver = `STORE="\${LLAMACTL_RESIDENCY_STORE:-\${DEV_STORAGE:-$HOME/.llamactl}/${storeRel}}"`;
    expect(section).toContain(resolver);
    expect(section).toContain('sqlite3 "$STORE" ".backup ');
    for (const line of section.split("\n")) {
      if (line.startsWith("sqlite3 ")) expect(line).not.toContain(storeRel);
    }
  });

  // Kills: deleting the ControllerActive branch in router.ts, or renaming
  // the lock file.
  test("case 5: desired-state ownership", () => {
    const section = sectionBody(SECTIONS.ownership) ?? "";
    for (const needle of [
      basename(lockFilePath("/w")),
      "`ControllerActive`",
      "`NotServingNode`",
      `\`${MANAGED_BY_LABEL}\``,
      "`LLAMACTL_NODE_NAME`",
      "`LLAMACTL_WORKLOADS_DIR`",
      "ModelRun",
      "ModelHost",
      "NodeRun",
      "--force",
      "packages/remote/src/router.ts",
      "packages/remote/src/workload/lock.ts",
    ]) {
      expect(section).toContain(needle);
    }
    // Kills: rewriting the controller --force help so --force overrides the
    // skip, or restoring the doc's old "overrides the skip" claim.
    const controllerHelp =
      /const USAGE = `([\s\S]*?)`;/.exec(
        readOrEmpty(join(REPO, "packages/cli/src/commands/controller.ts")),
      )?.[1] ?? "";
    const helpForce = controllerHelp.replaceAll(/\s+/g, " ");
    expect(helpForce).toContain(
      "--force Start even when ModelHosts carry a llamactl.io/managed-by label.",
    );
    expect(helpForce).toContain("Labeled hosts stay skipped by the reconciler;");
    expect(helpForce).toContain("logs them as skipped-external");
    expect(section).toContain(
      "`--force` only lets the controller start anyway; it does not override the skip, so labelled hosts stay skipped on every pass and are logged as `skipped-external`",
    );
    expect(section).not.toContain("overrides the skip");
    const router = readOrEmpty(join(REPO, "packages/remote/src/router.ts"));
    expect(router).toContain('reason: "ControllerActive"');
    expect(router).toContain("liveLockHolder(workloadsDir)");
  });

  // Kills: changing the recovery window to 20 minutes, or unwiring boot
  // recovery from serve.ts.
  test("case 6: leases, apply-profile, cancel and boot recovery", () => {
    const leases = sectionBody(SECTIONS.leases) ?? "";
    for (const needle of [
      "`LLAMACTL_RESIDENCY_LEASES`",
      "`LLAMACTL_RESIDENCY_SESSION_IDLE_MS`",
      "`Unavailable`",
      "`DrainInProgress`",
      "--reason",
    ]) {
      expect(leases).toContain(needle);
    }
    const plan = sectionBody(SECTIONS.statusPlanApply) ?? "";
    for (const needle of [
      "dry-run",
      "--execute --yes",
      `\`${RESIDENCY_PROFILES_ANNOTATION}\``,
      `\`${RESIDENCY_PROTECTED_ANNOTATION}\``,
      "`Busy`",
    ]) {
      expect(plan).toContain(needle);
    }
    const cancel = sectionBody(SECTIONS.cancelRecovery) ?? "";
    for (const needle of [
      `${String(PROFILE_SWITCH_BOOT_RECOVERY_MIN_AGE_MS / 60_000)} minutes`,
      "runProfileSwitchBootRecovery",
      "process-local",
      "packages/remote/src/residency/boot-recovery.ts",
    ]) {
      expect(cancel).toContain(needle);
    }
    expect(readOrEmpty(join(REPO, "packages/remote/src/server/serve.ts"))).toContain(
      "runProfileSwitchBootRecovery(",
    );
  });

  // Kills: reverting a ranking knob row to reserved, leaving the
  // minResidencySeconds row planner-only, dropping the production-gap
  // sentence, restoring the no-runtime-effect claim, a stale
  // idleEvictSeconds status, or omitting the factory/node-identity
  // wiring from the doc.
  test("case 7: NodeRun knobs table matches ResidencyPolicySchema", () => {
    const KNOB_STATUS = {
      safetyMarginRatio: "enforced",
      minResidencySeconds: "enforced",
      switchCooldownSeconds: "enforced",
      idleEvictSeconds: "operator-only",
      residentPreference: "ranking-only",
      coldLoadPenaltyMs: "ranking-only",
    } as const;
    expect(Object.keys(ResidencyPolicySchema.shape).sort()).toEqual(
      Object.keys(KNOB_STATUS).sort(),
    );
    const section = sectionBody(SECTIONS.knobs) ?? "";
    const rows = new Map<string, string>();
    for (const line of section.split("\n")) {
      const m = /^\|\s*`([A-Za-z]+)`\s*\|\s*([a-z-]+)\s*\|/m.exec(line);
      const key = m?.[1];
      const status = m?.[2];
      if (key !== undefined && status !== undefined) rows.set(key, status);
    }
    for (const [key, status] of Object.entries(KNOB_STATUS)) {
      expect(rows.get(key), `knob table row for ${key}`).toBe(status);
    }
    expect(section).toContain("MinResidency");
    expect(section).toContain("rankRouteCandidates");
    expect(section).toContain("residencyPolicy");
    expect(section).toContain("idleEviction");
    expect(section).toContain("advisory");
    expect(section).toContain("residency evict-idle");
    expect(section).toContain("idle-evicted-at");
    expect(section).toContain("release-idle");
    expect(section).toContain("NoLongerIdle");
    const preambleLine = section.split("\n").find((line) => line.includes("status column")) ?? "";
    const statusSentence = /[^.]*status column[^.]*\./.exec(preambleLine)?.[0] ?? "";
    expect(statusSentence).toContain("operator-only");
    expect(section).not.toContain("no runtime effect until");
    expect(section).toContain("createSharedUnifiedProxy");
    expect(section).toContain("LLAMACTL_NODE_NAME");
    expect(section).toContain("#690");
    expect(section).toContain("last succeeded profile switch");
  });

  // Kills: calling setNodeLlamacppSleepController from serve.ts (the doc
  // goes stale), or deleting the sentence.
  test("case 8: library-only claims match the source", () => {
    const claims: [string, string, (line: string) => boolean][] = [
      [
        "setNodeLlamacppSleepController",
        "packages/remote/src/residency/llamacpp-sleep-status.ts",
        SECTIONS.sleepWake,
      ],
      [
        "createManagedOmlxResidency",
        "packages/remote/src/residency/omlx-managed.ts",
        SECTIONS.artifact,
      ],
      [
        "decideOmlxCacheRetention",
        "packages/core/src/engines/omlx-cache-identity.ts",
        SECTIONS.artifact,
      ],
      ["getCandidateCalibrationKey", "packages/remote/src/workload/apply.ts", SECTIONS.artifact],
    ];
    for (const [symbol, definingFile, heading] of claims) {
      const section = sectionBody(heading) ?? "";
      const claim = `\`${symbol}\` has no production caller`;
      expect(section.includes(claim), `${symbol} "no production caller" claim`).toBe(
        productionRefs(symbol, definingFile).length === 0,
      );
    }
  });

  // Kills: changing CHAT_ADMISSION_DEFAULT_MAX_QUEUED to 32, or adding a
  // declared state.
  test("case 9: declared models, readiness and admission", () => {
    const agentCli = readOrEmpty(AGENT_CLI);
    const queuedDefault = Number(/CHAT_ADMISSION_DEFAULT_MAX_QUEUED = (\d+)/.exec(agentCli)?.[1]);
    expect(queuedDefault).toBeGreaterThan(0);
    const admission = sectionBody(SECTIONS.admission) ?? "";
    for (const needle of [
      "`LLAMACTL_CHAT_ADMISSION_MAX_EXECUTIONS`",
      "`LLAMACTL_CHAT_ADMISSION_MAX_QUEUED`",
      `default ${String(queuedDefault)}`,
      "429",
      "503",
      "/v1/chat/completions",
      "/v1/messages",
      "/v1/responses",
    ]) {
      expect(admission).toContain(needle);
    }
    const declared = sectionBody(SECTIONS.declared) ?? "";
    for (const needle of [
      "`LLAMACTL_DECLARED_MODELS`",
      "spec.readiness",
      "expectStatus",
      "expectJson",
      "alias-collision",
    ]) {
      expect(declared).toContain(needle);
    }
    for (const state of routingCatalog.DeclaredModelStateSchema.options) {
      expect(declared).toContain(`\`${state}\``);
    }

    // The counted ingresses (#709, #712) sit before the uncounted list.
    const counted = admission.split("Not counted yet")[0] ?? "";
    for (const needle of ["/v1/completions", "worker RPC", "inproc://local", "/trpc"]) {
      expect(counted).toContain(needle);
    }

    // The uncounted list mirrors the chat-admission.ts UNCOUNTED BY DESIGN and
    // DEFERRED blocks in both directions, so counting an uncounted ingress, or
    // adding one, forces a doc update.
    const bullets = chatAdmissionUncountedBullets();
    const deferred = bullets.join("\n");
    expect(deferred).toContain("physical per-node accounting");
    const uncounted = /Not counted yet[\s\S]*/.exec(admission)?.[0] ?? "";
    expect(uncounted).toContain("packages/remote/src/server/chat-admission.ts");
    const docBullets = [...uncounted.matchAll(/^- (.+)$/gm)].map((m) => m[1] ?? "");
    expect(docBullets.length, "doc uncounted bullets vs source bullets").toBe(bullets.length);
    for (const bullet of bullets) {
      const lead = bulletLead(bullet);
      expect(
        docBullets.some((b) => b.startsWith(lead)),
        `source bullet missing from doc: ${lead}`,
      ).toBe(true);
    }
    for (const item of [
      "/v1/completions",
      "tRPC chat mutation",
      "/v1/embeddings",
      "RAG embedding",
      "self-deadlock",
      "/v1/rerank",
      "planner local provider",
      "resolvePlannerProvider",
      "physical per-node accounting",
      "per-model keys",
      "per-principal shares",
      "total request deadline",
      "fairness",
      "Anthropic-shaped error bodies",
    ]) {
      expect(uncounted.includes(item), `uncounted list vs Deferred block: ${item}`).toBe(
        deferred.includes(item),
      );
    }
  });

  // Kills: renaming cacheEpoch in omlx-cache-identity.ts, or dropping the
  // packages/core/src/resources/memory.ts citation.
  test("case 10: artifact identity", () => {
    const section = sectionBody(SECTIONS.artifact) ?? "";
    // Declared stale reasons match DECLARED_STALE_REASONS exactly in both the
    // artifact-identity and declared-models sections. Kills: renaming a
    // reason in packages/core/src/routing/catalog.ts.
    const reasons = [...routingCatalog.DECLARED_STALE_REASONS].sort();
    expect(reasons.length).toBeGreaterThan(0);
    for (const body of [section, sectionBody(SECTIONS.declared) ?? ""]) {
      expect(body).toContain("DECLARED_STALE_REASONS");
      const named = [...new Set([...body.matchAll(/`(stale-[a-z-]+)`/g)].map((m) => m[1]))].sort();
      expect(named).toEqual(reasons);
    }
    for (const needle of [
      "`rel`",
      "basename",
      "artifactRevision",
      "engineBuild",
      "cacheEpoch",
      "sha256",
      "packages/core/src/engines/omlx-cache-identity.ts",
      "packages/core/src/resources/memory.ts",
      "packages/remote/src/residency/catalog.ts",
    ]) {
      expect(section).toContain(needle);
    }
  });

  // Kills: dropping the keepAlive.ts citation, or removing the
  // com.llamactl.agent launchd label from agent install.
  test("case 11: legacy launcher cleanup", () => {
    const section = sectionBody(SECTIONS.legacyLaunchers) ?? "";
    for (const needle of [
      "`llamactl keep-alive status`",
      "`llamactl keep-alive stop`",
      "`llamactl server stop`",
      ".controller.lock",
      "com.llamactl.agent",
      "launchctl",
      "systemctl",
      `\`${MANAGED_BY_LABEL}\``,
      "packages/cli/src/commands/keepAlive.ts",
    ]) {
      expect(section).toContain(needle);
    }
    expect(readOrEmpty(join(REPO, "packages/cli/src/commands/agent-install/index.ts"))).toContain(
      '"com.llamactl.agent"',
    );
  });

  // Kills: reordering the stage headings, or dropping the BLOCKED note from
  // Stage 3.
  test("case 12: staged enable order", () => {
    const i0 = doc.indexOf("### Stage 0");
    const i1 = doc.indexOf("### Stage 1");
    const i2 = doc.indexOf("### Stage 2");
    const i3 = doc.indexOf("### Stage 3");
    for (const idx of [i0, i1, i2, i3]) {
      expect(idx).toBeGreaterThanOrEqual(0);
    }
    expect(i0).toBeLessThan(i1);
    expect(i1).toBeLessThan(i2);
    expect(i2).toBeLessThan(i3);

    const stage = (n: number): string =>
      sectionBody((line) => line.startsWith(`### Stage ${String(n)} `)) ?? "";
    for (const body of [stage(0), stage(1), stage(2), stage(3)]) {
      expect(body).toContain("Enable gate");
      expect(body).toContain("Rollback");
    }
    expect(stage(0)).toContain("residency plan");
    expect(stage(1)).toContain("--execute --yes");
    expect(stage(1)).toContain("cancel-operation");
    // Stage 1 shows the dry run before the wet run.
    const stage1Applies = residencyCommands(stage(1)).filter((c) => c.sub === "apply-profile");
    const dryIdx = stage1Applies.findIndex((c) => !c.command.includes("--execute"));
    const wetIdx = stage1Applies.findIndex((c) => c.command.includes("--execute --yes"));
    expect(dryIdx).toBeGreaterThanOrEqual(0);
    expect(wetIdx).toBeGreaterThan(dryIdx);
    // Stage 2 actually sets both vars for the agent, not just names them.
    expect(stage(2)).toMatch(/^export LLAMACTL_CHAT_ADMISSION_MAX_EXECUTIONS=\S+$/m);
    expect(stage(2)).toMatch(/^export LLAMACTL_DECLARED_MODELS=1$/m);
    expect(stage(2)).toContain("EnvironmentVariables.LLAMACTL_CHAT_ADMISSION_MAX_EXECUTIONS");
    expect(stage(2)).toMatch(/EnvironmentVariables\.LLAMACTL_DECLARED_MODELS -string 1 /);
    expect(stage(3)).toContain("BLOCKED");
    expect(doc).toContain("disabled by default");
    expect(doc).toContain("not deployment approval");
    expect(doc).toContain("#285");
  });

  // Kills: citing a nonexistent file.
  test("case 13: cited paths and relative links resolve", () => {
    const cited = new Set(doc.match(/packages\/[A-Za-z0-9_./-]+\.tsx?/g) ?? []);
    expect(cited.size).toBeGreaterThanOrEqual(15);
    for (const p of cited) {
      expect(existsSync(join(REPO, p)), `cited path does not exist: ${p}`).toBe(true);
    }
    const linkPattern = /\]\((?!https?:|mailto:|#)([^)\s]+)\)/g;
    for (const match of doc.matchAll(linkPattern)) {
      const target = (match[1] ?? "").split("#")[0] ?? "";
      const resolved = resolve(join(REPO, "docs"), target);
      expect(existsSync(resolved), `relative link target missing: ${target}`).toBe(true);
    }
  });

  // Part of #522
  // Kills: reverting dispatchProxyRequest to a bare createProxy() (drops
  // the NodeRun ranking wiring), or reverting the doc's wrong serve.ts
  // attribution.
  test("case 14: ranked replica serving (#728) and shared proxy location", () => {
    const k = (sectionBody(SECTIONS.knobs) ?? "").replaceAll(/\s+/g, " ");
    expect(k).not.toContain("`serve.ts` builds `sharedProxy`");
    for (const needle of [
      "`dispatchProxyRequest`",
      "`LLAMACTL_UNIFIED_PROXY`",
      "`preferredLocalWorkload`",
      "`preferredWorkload`",
      "#728",
    ]) {
      expect(k, needle).toContain(needle);
    }
    const createProxySrc = readOrEmpty(join(REPO, "packages/remote/src/proxy/create-proxy.ts"));
    expect(createProxySrc).toContain("sharedProxy ??= createSharedUnifiedProxy();");
    expect(createProxySrc).not.toContain("sharedProxy ??= createProxy();");
    // The wiring itself, not the interface field or helper name: gatedExecute
    // sets the hint on ctx and the legacy executor forwards it to proxyOpenAI.
    expect(createProxySrc).toContain("preferredLocalWorkload: hint");
    expect(
      readOrEmpty(join(REPO, "packages/remote/src/inference/legacy-local-executor.ts")),
    ).toContain("preferredWorkload: hint");
    expect(readOrEmpty(join(REPO, "packages/core/src/openaiProxy.ts"))).toContain(
      "preferredWorkload?: string",
    );
  });

  // Part of #522
  // Kills: renaming SESSION_HEADER or the 409 AffinityConflict code,
  // deleting the section, documenting the 400 as unconditional, or making
  // session acquisition unconditional in source.
  test("case 15: session affinity (#729) and session-aware stop fence (#722)", () => {
    const a = (sectionBody(sectionRe("session affinity")) ?? "").replaceAll(/\s+/g, " ");
    const proxySrc = readOrEmpty(join(REPO, "packages/core/src/openaiProxy.ts"));
    const header = /const SESSION_HEADER = "([^"]+)"/.exec(proxySrc)?.[1] ?? "";
    const max = /const MAX_SESSION_ID_LENGTH = (\d+)/.exec(proxySrc)?.[1] ?? "";
    expect(header).toBe("x-llamactl-session");
    for (const needle of [
      `\`${header}\``,
      max,
      "`InvalidSessionId`",
      "`AffinityConflict`",
      "409",
      "400",
      "`LLAMACTL_RESIDENCY_LEASES`",
      "`LLAMACTL_RESIDENCY_SESSION_IDLE_MS`",
      "`SessionsActive`",
      "`SessionsUnknown`",
      "`releasedSessions`",
      "#729",
      "#722",
    ]) {
      expect(a, needle).toContain(needle);
    }
    expect(proxySrc).toContain('code: "AffinityConflict"');
    expect(proxySrc).toContain('code: "InvalidSessionId"');
    // The 400 sits under the same condition as affinity, and the doc says so.
    const only = a.indexOf("applies only when");
    expect(only, "only-when condition").toBeGreaterThanOrEqual(0);
    expect(a.indexOf("`InvalidSessionId`")).toBeGreaterThan(only);
    expect(a).toContain("Session handling (affinity and id validation) applies only when");
    expect(proxySrc).toContain(
      "trimmedSessionId !== null && sessionRegistry !== null && leaseRegistry !== null",
    );
    expect(proxySrc).toContain("acquireProxySession(sessionRegistry, trimmedSessionId");
    const serveSrc = readOrEmpty(join(REPO, "packages/remote/src/server/serve.ts"));
    expect(serveSrc).toContain("if (opts.residencyLeases !== true) return null;");
    expect(serveSrc).toContain("if (opts.residencySessionIdleMs !== undefined) {");
    expect(readOrEmpty(join(REPO, "packages/remote/src/residency/stop-fence.ts"))).toContain(
      '"SessionsActive"',
    );
    expect(readOrEmpty(join(REPO, "packages/remote/src/residency/force-unload.ts"))).toContain(
      "releasedSessions",
    );
  });

  // Part of #522
  // Kills: dropping the sessions argument from runFenced/fencePhase in
  // profile-transition.ts, renaming the SessionsActive step detail, removing
  // the lifecycle section from buildResidencyStatus or its LifecycleUnreadable
  // reason, removing the Lifecycle:/Exclusive: lines from renderResidencyStatus,
  // or removing the planner's Cooldown refusal, any of these without updating
  // the doc. The force-unload needle pins the whole inline-code command span,
  // so split or misplaced backticks in that sentence fail it.
  test("case 16: apply-profile session refusal (#730), status lifecycle read-out (#731) and cooldown (#732)", () => {
    const s = (sectionBody(SECTIONS.statusPlanApply) ?? "").replaceAll(/\s+/g, " ");
    for (const needle of [
      "`SessionsActive: <ids>`",
      "`SessionsUnknown`",
      "at fence time",
      "after the drain window",
      "never releases sessions",
      "needs the override `llamactl residency force-unload <workload> --reason <text> --yes --node <name>` (see Session affinity)",
      "#730",
      "`residency_states`",
      "`findExclusiveGroupViolations`",
      "`StoreUnreadable`",
      "`LifecycleUnreadable`",
      "`Lifecycle:`",
      "`Exclusive:`",
      "#731",
      "`Cooldown`",
      "#732",
      "`llamactl residency status --node <name>`",
      "[NodeRun residency policy knobs](#noderun-residency-policy-knobs)",
    ]) {
      expect(s, needle).toContain(needle);
    }
    // The cooldown link's anchor resolves to a real heading in the doc.
    expect(doc.split("\n")).toContain("## NodeRun residency policy knobs");
    // The force-unload synopsis the doc shows marks --reason and --yes
    // required in USAGE, and --node optional.
    const forceUnload = residencyRequiredFlags().get("force-unload") ?? [];
    expect(forceUnload).toEqual(["--reason", "--yes"]);
    const profileTransition = readOrEmpty(
      join(REPO, "packages/remote/src/residency/profile-transition.ts"),
    );
    for (const pin of [
      'return `SessionsActive: ${check.sessions.join(",")}`;',
      'return "SessionsUnknown";',
      "fencePhase(registry, plan.victims, sessions, signal, beat)",
    ]) {
      expect(profileTransition, pin).toContain(pin);
    }
    const procedures = readOrEmpty(join(REPO, "packages/remote/src/residency/procedures.ts"));
    for (const pin of [
      "lifecycle: buildResidencyLifecycleSnapshot(input.store)",
      '"LifecycleUnreadable"',
    ]) {
      expect(procedures, pin).toContain(pin);
    }
    const residencyCli = readOrEmpty(RESIDENCY_CLI);
    for (const pin of ["Lifecycle:  ", "Exclusive:  violation in "]) {
      expect(residencyCli, pin).toContain(pin);
    }
    expect(readOrEmpty(join(REPO, "packages/core/src/residency/planner.ts"))).toContain(
      '"Cooldown"',
    );
  });

  // Part of #522
  // Kills: removing the session check from fencedStop, or removing the
  // trackedInstanceLive gate that makes a crashed instance never block;
  // renaming the "while a session is bound to its running instance" error
  // tail; making fencedStop consult sessions without a lease registry; not
  // installing the session registry in serve.ts; adding or removing a state
  // in INTERRUPTED_LIFECYCLE_STATES without updating the doc; making the
  // lifecycle sweep run outside a claimed pass without updating the doc,
  // i.e. removing either shouldClaim gate: the outer snapshot gate in
  // runProfileSwitchBootRecovery that decides whether scanWithStore runs,
  // or the inner writable-handle re-check inside claimOwnershipWhen;
  // dropping the orphan sweep, its no-nonterminal gate, its age gate or its
  // proven-down wiring without updating the doc should fail; dropping the
  // fail-closed `evict:` consequence and its operator remedy; renaming
  // failInterruptedLifecycleRows or the lifecycle log line.
  test("case 17: stop-before-start session refusal (#734) and lifecycle boot recovery (#736)", () => {
    const r = (sectionBody(sectionRe("stop-before-start")) ?? "").replaceAll(/\s+/g, " ");
    expect(sectionBody(sectionRe("stop-before-start"))).toBeDefined();
    for (const needle of [
      "`startServer`",
      "`packages/core/src/server.ts`",
      "`LeasesActive`",
      "`DrainInProgress`",
      "`SessionsActive`",
      "`SessionsUnknown`",
      "`LLAMACTL_RESIDENCY_LEASES`",
      "`LLAMACTL_RESIDENCY_SESSION_IDLE_MS`",
      "while a session is bound to its running instance",
      "crashed",
      "never releases sessions",
      "`serverStart`",
      "`packages/remote/src/router.ts`",
      "`llamactl residency force-unload <workload> --reason <text> --yes --node <name>`",
      "#734",
    ]) {
      expect(r, needle).toContain(needle);
    }
    const serverSrc = readOrEmpty(join(REPO, "packages/core/src/server.ts"));
    for (const pin of [
      'reason: "SessionsActive"',
      'reason: "SessionsUnknown"',
      '"while a session is bound to its running instance"',
      "return trackedInstanceLive(opts, resolved, key) ? objection : null;",
      "if (registry === null) return { refused: null, stopResult: await stop() };",
      "const sessionRefusal = checkStartSessions(opts, resolved, key);",
    ]) {
      expect(serverSrc, pin).toContain(pin);
    }
    expect(readOrEmpty(join(REPO, "packages/remote/src/server/serve.ts"))).toContain(
      "setSessionRefcountRegistry(sessionRefcounts)",
    );
    expect(readOrEmpty(join(REPO, "packages/remote/src/router.ts"))).toContain(
      "serverMod.startServer(",
    );

    const c = (sectionBody(SECTIONS.cancelRecovery) ?? "").replaceAll(/\s+/g, " ");
    for (const needle of [
      "`failInterruptedLifecycleRows`",
      "`residency_states`",
      "`failed`",
      "claimed pass",
      "a stale profile-switch row",
      "When the store holds no nonterminal operation row, boot recovery also sweeps lifecycle rows interrupted outside a switch (for example a direct start whose agent died in `loading`) once they have made no progress for 30 minutes and their workload is proven down by `directWorkloadProvenDown`; a younger row, a workload not proven down, or any nonterminal operation row leaves them untouched.",
      "When no `profile-switch:` row is nonterminal, boot recovery first finishes a crashed eviction's `evict:` operation rows: an `evict:<victim>` row whose `targetState` reads `evicted-by:<replacement>` and that has made no progress for 30 minutes is finished `unknown` with detail `recovered: interrupted-unverified (was <phase>)` under a claim of the apply-profile fence, and the outside-a-switch sweep then runs in the same boot.",
      "Meanwhile clear a stuck interrupted row by hand with an operator stop or `llamactl residency force-unload <workload> --reason <text> --yes --node <name>`, which an `evict:` row does not block.",
      '`[residency] lifecycle boot recovery {"failed":N,"recordFailures":M}`',
      "#736",
    ]) {
      expect(c, needle).toContain(needle);
    }
    expect(c).not.toContain("outside a switch are not swept");
    for (const state of INTERRUPTED_LIFECYCLE_STATES) {
      expect(c, state).toContain(`\`${state}\``);
    }
    expect([...INTERRUPTED_LIFECYCLE_STATES].sort()).toEqual([
      "draining",
      "loading",
      "unloading",
      "warming",
    ]);
    const bootRecovery = readOrEmpty(join(REPO, "packages/remote/src/residency/boot-recovery.ts"));
    for (const pin of [
      "function failInterruptedLifecycleRows(",
      "function sweepOrphanedLifecycleRows(",
      "nonterminal.length === 0",
      "const result = shouldClaim(preview)\n      ? scanWithStore(openStore, opts, nowMs, minStaleAgeMs, lifecycle)\n      : deferred(preview);",
      "preview = previewProfileSwitchRecovery(nonterminal, { nowMs: nowMs(), minStaleAgeMs });\n        return shouldClaim(preview);",
      "[residency] lifecycle boot recovery ${lifecycleCountsJson(lifecycle.counts)}",
      "[residency] lifecycle boot recovery failed: ",
      'to: "failed"',
      "isProvenDown?: (model: string) => boolean",
    ]) {
      expect(bootRecovery, pin).toContain(pin);
    }
    expect(readOrEmpty(join(REPO, "packages/remote/src/server/serve.ts"))).toContain(
      "isProvenDown: directWorkloadProvenDown",
    );
    expect(readOrEmpty(join(REPO, "packages/remote/src/router.ts"))).toContain(
      "export function directWorkloadProvenDown(",
    );
  });

  // Part of #522
  // Kills: reverting prepareSessionAndLease to sessionResult.release?.()
  // on an admission refusal, dropping the priorActivityMs restore or the
  // created-entry delete in cancelAcquire, changing the lease-refusal
  // status or type mapping, or rewording any claim of the #740 paragraph.
  test("case 18: session acquire undo on admission refusal (#740)", () => {
    const a = (sectionBody(sectionRe("session affinity")) ?? "").replaceAll(/\s+/g, " ");
    // Full phrases, so a swapped mapping, a changed status or a dropped
    // clause fails even though each token also appears elsewhere.
    for (const needle of [
      "A request whose residency lease admission refuses gets `503` (`model_draining` for `Draining`, `model_not_loaded` for `Unloaded`)",
      "undoes its session acquire through `cancelAcquire` (`packages/core/src/residency/sessions.ts`) instead of releasing it (`prepareSessionAndLease`/`acquireProxyResidencyLease` in `packages/core/src/openaiProxy.ts`).",
      "The refused request therefore neither binds a fresh session nor extends an idle binding: a session the refused acquire created is deleted when its refs reach 0, and otherwise the pre-acquire `lastActivityMs` is restored.",
      "That makes the post-drain session re-check of a wet switch (#730) defence in depth (#740).",
    ]) {
      expect(a, needle).toContain(needle);
    }
    const proxySrc = readOrEmpty(join(REPO, "packages/core/src/openaiProxy.ts"));
    // `{ status: 503 }` appears at several sites; pin it inside the lease
    // refusal body only.
    const acquireBody = enclosingBody(proxySrc, "function acquireProxyResidencyLease(");
    for (const pin of [
      'const draining = acquired.reason === "Draining";',
      'type: draining ? "model_draining" : "model_not_loaded",',
      "{ status: 503 },",
    ]) {
      expect(acquireBody, pin).toContain(pin);
    }
    const prepareBody = flat(enclosingBody(proxySrc, "function prepareSessionAndLease("));
    for (const pin of [
      "const admission = acquireProxyResidencyLease(leaseRegistry, routed.route);",
      "if (admission instanceof Response) { if (hasBothSeams) { sessionResult.cancel?.(); } return admission; }",
    ]) {
      expect(prepareBody, pin).toContain(pin);
    }
    const sessionsSrc = readOrEmpty(join(REPO, "packages/core/src/residency/sessions.ts"));
    const cancelBody = enclosingBody(sessionsSrc, "cancelAcquire(sessionId, generation): void {");
    for (const pin of [
      "entry.lastActivityMs = undo.priorActivityMs;",
      "if (undo.created && entry.refs === 0) {\n        sessions.delete(sessionId);",
    ]) {
      expect(cancelBody, pin).toContain(pin);
    }
  });

  // Part of #522
  // Kills: unwiring runDirectResidencyStart/Stop from router.ts,
  // rewording the in-flight start refusal, making the no-store path
  // create or require a store, making a failed claim block a stop,
  // dropping either startModelHostProcess call site or the
  // disable/delete modelHostStop call, or rewording any claim of the
  // #741 section. Part of #517 also kills: unwiring
  // serverStart/serverStop, dropping the switch scope or the ModelRun
  // label group, recording an unconfirmed stop, walking the row before
  // the stop dep runs, reverting the ModelRun proven-down rule, and —
  // for the force-unload slice — leaving either kind's stop outside
  // runDirectResidencyStop, pairing it with the wrong opts factory, or
  // keeping the doc's force-unload bypass claim.
  test("case 19: direct ModelHost start/stop lifecycle (#741)", () => {
    expect(sectionBody(sectionRe("direct modelhost start and stop"))).toBeDefined();
    const d = flat(sectionBody(sectionRe("direct modelhost start and stop")) ?? "");
    // One needle per claim, as a full phrase.
    for (const needle of [
      "The agent's `modelHostStart` and `modelHostStop` procedures (`packages/remote/src/router.ts`) wrap `startModelHost`/`stopModelHost` in `runDirectResidencyStart`/`runDirectResidencyStop` (`packages/remote/src/residency/direct-lifecycle.ts`).",
      "`llamactl apply -f` and `llamactl enable` of a ModelHost reach `modelHostStart` (`startModelHostProcess` in `packages/remote/src/workload/apply.ts`), and `llamactl disable` (`disableModelHost`) or deleting a ModelHost reaches `modelHostStop`.",
      "The agent's ModelRun `serverStart` and `serverStop` procedures wrap `startServer`/`stopServer` the same way (#517), recording the group from the agent-side ModelRun `llamactl.io/residency-group` label, and deleting a ModelRun reaches `serverStop` (`stopWorkloadForDelete`).",
      "A profile switch's own `applyManifest` calls run inside `runInResidencySwitchScope`, where the wrapper neither records nor refuses, because the switch's walk owns the row.",
      "A node with no store file runs the start or stop unrecorded and never creates the store.",
      "Otherwise the wrapper claims the shared apply-profile fence and walks the `residency_states` row through the same `withResidencyLifecycle` hops as a profile switch (`packages/remote/src/residency/lifecycle-steps.ts`).",
      "A label naming an undeclared group records no group.",
      "A same-group `ready` peer is reconciled to downloaded only when it is proven down: a known ModelHost that reads Stopped with its identity resolved, a known ModelRun with no recorded pid file or whose recorded pid is provably gone (`dead` or `reused`), or a keep-alive target whose supervisor is absent or provably gone and whose own server key (the target name) is proven down.",
      "Any other occupying same-group row refuses the start with `ExclusiveGroupOccupied`, as `residency lifecycle refused <name> <from> -> <to>: ExclusiveGroupOccupied: <detail>`, before the engine runs.",
      "A nonterminal profile switch refuses a start with `residency lifecycle refused <name>: profile switch in flight on this node; retry after it settles`.",
      "A grouped start whose store cannot be opened or claimed refuses with `store unavailable (<message>)`.",
      "A workload already running with a `ready` row is adopted and kept ready.",
      "A direct stop runs its stop before the row moves, so an occupying row keeps its exclusive group held for the whole stop.",
      "A confirmed stop walks the row `ready` -> `draining` -> `unloading` -> `downloaded`.",
      "An unconfirmed stop (the process may still be alive) is not recorded: the row stays occupying, so a same-group start is still refused, and the agent logs `[residency] lifecycle <name> stop not recorded: unconfirmed stop (process may be alive)`.",
      "A stop that throws is recorded `failed` and the error is rethrown.",
      "Bookkeeping never blocks a stop: a stop whose claim or walk fails still runs and logs `[residency] lifecycle <name> stop not recorded: …` on the agent's stderr.",
      "Known limits: a `ready` ModelRun row whose recorded pid is still alive, or whose identity cannot be verified (`unknown`), is never proven down, so it fails closed and refuses same-group starts.",
      "`llamactl residency force-unload <workload> --reason <text> --yes --node <name>` routes its `stopModelHost`/`stopServer` through `runDirectResidencyStop` after the lease drain commits, so a confirmed force-unload walks the row to `downloaded` and an unconfirmed one leaves it occupying (#517).",
    ]) {
      expect(d, needle).toContain(needle);
    }
    const directLifecycle = readOrEmpty(
      join(REPO, "packages/remote/src/residency/direct-lifecycle.ts"),
    );
    // Each source pin is anchored to its enclosing function, so a site that
    // shares text with another (two `stop not recorded:` logs, a start
    // refusal and a stop log that both say `store unavailable (`) is
    // pinned on its own.
    const bodyPins: [string, string[]][] = [
      [
        "async function unrecordedOrFail<",
        [
          'if (action === "start" && (env.managed || lifecycleGroup !== undefined)) {',
          "detail: `residency lifecycle refused ${workload}: store unavailable (${message})`,",
          "`[residency] lifecycle ${workload} ${action} not recorded: store unavailable (${message})\\n`,",
          "return { ran: true, result: await env.dep(workload) };",
        ],
      ],
      [
        "async function initialClaim<",
        [
          "detail: `residency lifecycle refused ${workload}: profile switch in flight on this node; retry after it settles`,",
          "`[residency] lifecycle ${workload} stop not recorded: profile switch in flight\\n`,",
          "return { ran: true, result: await env.dep(workload) };",
        ],
      ],
      [
        // the stop dep runs before any walk; an unconfirmed stop returns
        // unrecorded; only a settled stop is recorded, a thrown one rethrown
        "async function walkStopAfterDep<",
        [
          '  try {\n    settled = { result: await env.dep(workload) };\n  } catch (error: unknown) {\n    settled = { thrown: error };\n  }\n  if ("result" in settled && !settled.result.ok) {',
          "`[residency] lifecycle ${workload} stop not recorded: unconfirmed stop (process may be alive)\\n`,",
          "    return { ran: true, result: settled.result };\n  }\n  const token = refence(",
          "await recordSettledStop(",
          '"thrown" in settled ? messageOf(settled.thrown) : undefined,',
          'if ("thrown" in settled) {\n    throw settled.thrown;\n  }',
        ],
      ],
      [
        "async function recordSettledStop<",
        [
          "return Promise.resolve(failure === undefined ? { ok: true } : { ok: false, detail: failure });",
          "const step = await wrapped.stop(workload, undefined);",
          "`[residency] lifecycle ${workload} stop not recorded: ${stepRefusalDetail(step)}\\n`,",
        ],
      ],
      [
        "async function runRecorded<",
        [
          'if (action === "stop") {\n    return await walkStopAfterDep(workload, store, claimed, env);\n  }',
        ],
      ],
      [
        "async function runDirect<",
        [
          "if (inResidencySwitchScope()) {\n    return { ran: true, result: await dep(workload) };\n  }",
        ],
      ],
      [
        "async function adoptReadyStart<",
        [
          'if (own?.state !== "ready" || !isRunningSafe(opts, workload)) {',
          "`[residency] lifecycle ${workload} start kept ready: host already running\\n`",
        ],
      ],
      [
        "function declaredGroup(",
        ["return groups.some((declared) => declared.name === group) ? group : undefined;"],
      ],
    ];
    for (const [signature, pins] of bodyPins) {
      const body = enclosingBody(directLifecycle, signature);
      expect(body, signature).not.toBe("");
      for (const pin of pins) {
        expect(body, `${signature} ${pin}`).toContain(pin);
      }
    }
    for (const pin of [
      "if (!existsSync(opts.storePath)) {",
      // only a ready row proven down is left for reconcile
      'return !(row.state === "ready" && isProvenDownSafe(opts, row.model));',
    ]) {
      expect(directLifecycle, pin).toContain(pin);
    }
    const stepsSrc = readOrEmpty(join(REPO, "packages/remote/src/residency/lifecycle-steps.ts"));
    for (const pin of [
      "residency lifecycle refused ${workload} ${from} -> ${to}: ${decision.reason}: ${decision.detail}",
      // the refusal returns before the engine (deps.start) runs
      "if (!walkToLoading.ok) {\n    return { ok: false, detail: describeRefusal(workload, walkToLoading) };\n  }\n  const outcome = await ctx.deps.start(workload, stepCtx);",
      "-> downloaded in group ${group}: ",
    ]) {
      expect(stepsSrc, pin).toContain(pin);
    }
    const routerSrc = readOrEmpty(join(REPO, "packages/remote/src/router.ts"));
    for (const pin of [
      "runDirectResidencyStart<StartModelHostResult>(",
      "runDirectResidencyStop<StopModelHostResult>(",
      // deleting a ModelHost reaches modelHostStop
      "? await stopModelHostForDelete(manifest, stops)",
    ]) {
      expect(routerSrc, pin).toContain(pin);
    }
    // the wrapper's log is the agent's stderr
    expect(
      flat(enclosingBody(routerSrc, "function directResidencyOpts(")),
      "agent stderr log",
    ).toContain("log: (line): void => { process.stderr.write(line); },");
    expectPins(
      enclosingBody(routerSrc, "function directWorkloadProvenDown("),
      "proven down predicate",
      [
        'return status.state === "Stopped" && status.identityUnknown !== true;',
        "return serverMod.isServerProvenDown({ name: model });",
      ],
    );
    expect(
      enclosingBody(routerSrc, "function directModelRunGroup("),
      "ModelRun label group",
    ).toContain(
      "return residencyGroupLabelOf(workloadStoreMod.loadWorkloadByName(workload).metadata.labels);",
    );
    const modelRunOpts = enclosingBody(routerSrc, "function directModelRunOpts(");
    expectPins(modelRunOpts, "directModelRunOpts", [
      "group: directModelRunGroup(workload),",
      "isProvenDown: directWorkloadProvenDown,",
    ]);
    expect(flat(modelRunOpts), "ModelRun agent stderr log").toContain(
      "log: (line): void => { process.stderr.write(line); },",
    );
    const serverStart = enclosingBody(routerSrc, "serverStart: t.procedure");
    expect(serverStart).toContain("runModelRunStart(input, sig, emit, managed)");
    expectPins(enclosingBody(routerSrc, "async function runModelRunStart("), "ModelRun start", [
      "runDirectResidencyStart(",
      "serverMod.startServer(opts)",
      "serverStartOptions(input, signal,",
      "directModelRunStartOpts(input.workload, input.target),",
    ]);
    const serverStop = enclosingBody(routerSrc, "serverStop: t.procedure");
    expectPins(serverStop, "ModelRun stop call site", [
      "const outcome = await runDirectResidencyStop<{",
      "directModelRunOpts(input.workload),",
      "return outcome.ran ? outcome.result.stop",
      '...(stop.stopped ? {} : { error: "stop did not confirm process removal" }),',
    ]);
    expectPins(routerSrc, "ModelRun orchestration call sites", [
      // deleting a ModelRun reaches serverStop
      ": await stopWorkloadForDelete(manifest, stops);",
      // the switch's applyManifest runs in the switch scope
      "return await runInResidencySwitchScope(\n            async () =>\n              await workloadApplyMod.applyManifest({",
    ]);
    expect(
      enclosingBody(routerSrc, "async function stopWorkloadForDelete("),
      "delete run",
    ).toContain("const stopOutcome = (await client.serverStop.mutate({");
    expect(enclosingBody(routerSrc, "async function stopModelHostForDelete("), "delete").toContain(
      "const outcome = (await client.modelHostStop.mutate({",
    );
    // force-unload routes each kind's stop through runDirectResidencyStop
    // after the lease drain commits — one call site per branch, in
    // ternary order: the modelhost dep then directResidencyOpts(name,
    // undefined), then the modelrun dep then directModelRunOpts(name).
    // dep is the call's second arg and opts the third, so each opts
    // factory follows its own dep inside the same runDirectResidencyStop
    // call.
    const forceUnloadBody = flat(enclosingBody(routerSrc, "residencyForceUnload: t.procedure"));
    expect(forceUnloadBody, "residencyForceUnload body").not.toBe("");
    expect(
      forceUnloadBody.split("await runDirectResidencyStop").length - 1,
      "force-unload wrapped stops",
    ).toBe(2);
    const hostDep = forceUnloadBody.indexOf("stopModelHost({ key:");
    const hostOpts = forceUnloadBody.indexOf("directResidencyOpts(name, undefined)");
    const runDep = forceUnloadBody.indexOf("serverMod.stopServer({ key:");
    const runOpts = forceUnloadBody.indexOf("directModelRunOpts(name)");
    expect(hostDep, "modelhost force-unload dep").toBeGreaterThanOrEqual(0);
    expect(hostOpts, "modelhost force-unload opts").toBeGreaterThan(hostDep);
    expect(runDep, "modelrun force-unload dep").toBeGreaterThan(hostOpts);
    expect(runOpts, "modelrun force-unload opts").toBeGreaterThan(runDep);
    for (const [dep, opts] of [
      [hostDep, hostOpts],
      [runDep, runOpts],
    ] as const) {
      expect(
        forceUnloadBody.slice(Math.max(0, dep - 400), opts),
        "runDirectResidencyStop call site",
      ).toContain("await runDirectResidencyStop");
    }
    const applySrc = readOrEmpty(join(REPO, "packages/remote/src/workload/apply.ts"));
    const applyPins: [string, string[]][] = [
      ["async function startModelHostProcess(", ["client.modelHostStart.subscribe("]],
      [
        "async function applyModelHostManifest(",
        [
          "if (!manifest.spec.enabled) { return await disableModelHost(manifest, client, resolved); }",
          "const started = await startModelHostProcess(client, manifest, opts.managedBudget !== undefined);",
        ],
      ],
      [
        "async function convergeModelHostReplacement(",
        [
          "lifecycle.startInvoked = true; const started = await startModelHostProcess(client, manifest);",
        ],
      ],
      [
        "async function disableModelHost(",
        [
          "const outcome = await client.modelHostStop.mutate({ workload: manifest.metadata.name });",
        ],
      ],
    ];
    for (const [signature, pins] of applyPins) {
      const body = flat(enclosingBody(applySrc, signature));
      expect(body, signature).not.toBe("");
      for (const pin of pins) {
        expect(body, `${signature} ${pin}`).toContain(pin);
      }
    }
  });

  // Part of #522
  // Kills: M1 deleting or truncating the #750 paragraph; M2 adding or
  // renaming a ResidencyStatusSessionsUnavailableReason without updating
  // the doc; M3 changing a SESSIONS_UNAVAILABLE human string or pairing it
  // with another reason; M4 dropping sessionRegistry from the router's
  // residencyStatus input or the sessions section from buildResidencyStatus;
  // M5 changing the force-unload released-sessions line text or printing it
  // for an empty or missing releasedSessions list; M6 changing the snapshot
  // sort order, the in-flight expiry rule or dropping prune() from
  // snapshot(); M7 changing the Sessions header or row format; M8 limiting
  // the sessions section to the serving node (or lifting that limit from
  // idleEviction) while the doc still contrasts them.
  test("case 20: bound sessions in residency status and force-unload output (#750)", () => {
    const s = sectionBody(SECTIONS.statusPlanApply) ?? "";
    const para = flat(s.split(/\n\s*\n/).find((p) => p.includes("`Sessions:")) ?? "");
    const aff = flat(sectionBody(sectionRe("session affinity")) ?? "");
    const cliSrc = readOrEmpty(RESIDENCY_CLI);
    const procSrc = readOrEmpty(join(REPO, "packages/remote/src/residency/procedures.ts"));
    const sessSrc = readOrEmpty(join(REPO, "packages/core/src/residency/sessions.ts"));
    const routerSrc = readOrEmpty(join(REPO, "packages/remote/src/router.ts"));
    const mcpSrc = readOrEmpty(join(REPO, "packages/mcp/src/tools/residency.ts"));

    // (1) The #750 paragraph in the status section, as full phrases.
    expect(para).not.toBe("");
    expect(flat(s)).toContain(para);
    expectPins(para, "#750 status", [
      "`llamactl residency status --node <name>` also prints a `Sessions:` section from the serving process's session registry (`pushSessionLines` in `packages/cli/src/commands/residency.ts`, #750).",
      "The header reads `Sessions: <n> bound (idle timeout <t>; scope: serving-process)`, followed by one `<workload> <sessionId> refs <n> in flight|expires in <t>` line per session:",
      "a session with refs above 0 is `in flight` and has no expiry, while a session at refs 0 shows the rest of its idle-timeout window.",
      "Only live sessions are listed (expired ones are pruned first), most recently active first.",
      "The `residencyStatus` procedure, and the MCP tool that returns its result, carry the same data as a `sessions` section built by `buildResidencySessionSnapshot` in `packages/remote/src/residency/procedures.ts`: `status`, `scope` `serving-process`, `idleTimeoutMs`, and per session `sessionId`, `workload`, `refs`, `idleMs` and `expiresInMs` (`null` while in flight).",
      "The registry is installed only when `LLAMACTL_RESIDENCY_LEASES` is on AND `LLAMACTL_RESIDENCY_SESSION_IDLE_MS` is set (see Session affinity);",
      "Unlike `idleEviction`, the section is not limited to the serving node: whatever `--node` names, it shows the serving process's registry.",
    ]);

    // (2) The unavailable-reason codes the doc must name, read from source.
    const reasonDecl =
      /export type ResidencyStatusSessionsUnavailableReason =([^;]*);/.exec(procSrc)?.[1] ?? "";
    const reasonCodes = [...reasonDecl.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1] ?? "").sort();
    expect(reasonCodes).toEqual(["NoRegistry", "SessionsUnknown", "SnapshotUnsupported"]);

    // (3) Each reason paired with the human string the CLI prints for it,
    // read from the SESSIONS_UNAVAILABLE map; the doc must keep the pairs.
    const unavailableBody = enclosingBody(cliSrc, "const SESSIONS_UNAVAILABLE");
    const pairs = [...unavailableBody.matchAll(/^\s+(\w+): "([^"]+)",$/gm)].map(
      (m): [string, string] => [m[1] ?? "", m[2] ?? ""],
    );
    expect(pairs.map(([code]) => code).sort()).toEqual(reasonCodes);
    const phrase = new Map(pairs);
    expectPins(para, "#750 unavailable", [
      `without it the section reads \`unavailable\` with \`NoRegistry\` ("${phrase.get("NoRegistry") ?? "?"}"),`,
      `a snapshot that throws reports \`SessionsUnknown\` ("${phrase.get("SessionsUnknown") ?? "?"}"),`,
      `and a registry without a snapshot reports \`SnapshotUnsupported\` ("${phrase.get("SnapshotUnsupported") ?? "?"}").`,
    ]);

    // (4) Source pins for the CLI rendering.
    expectPins(enclosingBody(cliSrc, "function pushSessionLines("), "pushSessionLines", [
      "`Sessions:   ${String(sessions.sessions.length)} bound (idle timeout ${formatMs(sessions.idleTimeoutMs)}; scope: ${sessions.scope})`,",
      'const state = s.expiresInMs === null ? "in flight" : `expires in ${formatMs(s.expiresInMs)}`;',
      "lines.push(`  ${s.workload}  ${s.sessionId}  refs ${String(s.refs)}  ${state}`);",
    ]);
    expect(enclosingBody(cliSrc, "function renderResidencyStatus(")).toContain(
      "pushSessionLines(lines, s.sessions);",
    );

    // (5) Source pins for the procedure section and its reasons.
    expectPins(
      enclosingBody(procSrc, "export function buildResidencySessionSnapshot("),
      "buildResidencySessionSnapshot",
      [
        'if (registry === null) {\n    return { status: "unavailable", scope: "serving-process", reason: "NoRegistry" };',
        'if (registry.snapshot === undefined) {\n    return { status: "unavailable", scope: "serving-process", reason: "SnapshotUnsupported" };',
        '} catch {\n    return { status: "unavailable", scope: "serving-process", reason: "SessionsUnknown" };',
        "idleTimeoutMs: snap.idleTimeoutMs,",
        "expiresInMs: r.expiresInMs,",
      ],
    );
    expectPins(
      enclosingBody(procSrc, "export function buildResidencyStatus("),
      "buildResidencyStatus",
      [
        "const sessions = buildResidencySessionSnapshot(input.sessionRegistry);",
        "...(sessions !== undefined ? { sessions } : {}),",
      ],
    );
    // idleEviction is gated on the serving node; sessions is not.
    expect(enclosingBody(procSrc, "export function buildIdleEvictionSnapshot(")).toContain(
      'if (input.servingNode === null || input.servingNode !== input.node) {\n    return { status: "unavailable", scope, reason: "NotServingNode" };',
    );
    expect(enclosingBody(procSrc, "export function buildResidencySessionSnapshot(")).not.toContain(
      "servingNode",
    );

    // (6) The router always passes the process registry; the MCP tool
    // returns the procedure's result.
    const statusStart = routerSrc.indexOf("  residencyStatus: t.procedure");
    const statusProc =
      statusStart === -1
        ? ""
        : routerSrc.slice(
            statusStart,
            routerSrc.indexOf("  residencyPlan: t.procedure", statusStart),
          );
    expect(statusProc).toContain("sessionRegistry: currentSessionRefcounts(),");
    expect(enclosingBody(mcpSrc, "function registerResidencyStatus(")).toContain(
      "return toTextContent(await caller.residencyStatus({ node: input.node }));",
    );

    // (7) The registry snapshot: pruned, most recently active first, and
    // no expiry while refs > 0.
    expect(enclosingBody(sessSrc, "snapshot(): SessionSnapshot {")).toContain(
      "prune();\n      return buildSessionSnapshot(sessions, now(), idleTimeoutMs);",
    );
    expectPins(enclosingBody(sessSrc, "function buildSessionSnapshot("), "buildSessionSnapshot", [
      "const expiresInMs = entry.refs > 0 ? null : Math.max(0, idleTimeoutMs - idleMs);",
      "(a, b) =>\n      a.idleMs - b.idleMs ||",
    ]);
    expect(sessSrc).toContain(
      "const isExpired = (entry: SessionEntry): boolean =>\n    entry.refs === 0 && now() - entry.lastActivityMs >= idleTimeoutMs;",
    );

    // (8) Force-unload released-session output, documented in Session affinity.
    expect(aff).toContain(
      "The human output adds `Forced unload: released <n> session(s): <ids>` only when sessions were released; an agent older than #722 omits `releasedSessions`, so the line is skipped (#750).",
    );
    expectPins(enclosingBody(cliSrc, "function renderForceUnload("), "renderForceUnload", [
      "const released: unknown = r.releasedSessions;",
      "if (Array.isArray(released) && released.length > 0) {",
      '`Forced unload: released ${String(released.length)} session(s): ${released.join(", ")}`,',
    ]);
  });

  // Part of #519
  // Kills: dropping the min-residency idle-eviction claims from the knobs
  // table or the Operator-initiated idle eviction section, or removing the
  // minResidencySeconds read from idleEvictionRowFor.
  test("case 21: minResidencySeconds holds an idle-due resident from evict-idle (#519)", () => {
    const knobs = sectionBody(SECTIONS.knobs) ?? "";
    const minRow = knobs.split("\n").find((line) => line.includes("| `minResidencySeconds`")) ?? "";
    expect(minRow).toContain(
      "holds an idle-due resident in `residency evict-idle` as `MinResidency`",
    );
    const idleEvict = flat(sectionBody(sectionRe("operator-initiated idle eviction")) ?? "");
    expect(idleEvict).toContain(
      "skipped `MinResidency` until it has been ready for `minResidencySeconds`",
    );
    const procSrc = readOrEmpty(join(REPO, "packages/remote/src/residency/procedures.ts"));
    expect(enclosingBody(procSrc, "function idleEvictionRowFor(")).toContain("minResidencySeconds");
  });

  // Part of #520
  // Kills: shipping the session-aware idle-eviction skip reasons without
  // documenting them in the operator runbook section.
  test("case 22: idle eviction session skip reasons (#520)", () => {
    const section = sectionBody(SECTIONS.operatorIdleEviction) ?? "";
    for (const needle of ["skipped `SessionsActive`", "`SessionsUnknown`"]) {
      expect(section, needle).toContain(needle);
    }
  });

  // Part of #522
  // Kills: making --yes optional in the USAGE release-session synopsis, or
  // documenting release-session without --yes; dropping or renaming a
  // ReleaseSessionResult refusal reason without a doc update; making the
  // release drain, revoke leases or stop a workload; changing the session
  // id bound, or dropping confirm or force passthrough in the router;
  // removing the generation guard in release, keeping the entry instead of
  // deleting it on an idle or forced release, or flipping the force check;
  // changing the success or forced line text, contacting the node before
  // the --yes check, or allowing --node all; dropping the MCP releaseSession
  // tool or its doc sentence.
  test("case 23: operator per-session release-session (#755)", () => {
    const aff = flat(sectionBody(sectionRe("session affinity")) ?? "");
    const para = flat(
      (sectionBody(sectionRe("session affinity")) ?? "")
        .split(/\n\s*\n/)
        .find((p) => p.includes("`llamactl residency release-session")) ?? "",
    );
    expect(para).not.toBe("");
    expect(aff).toContain(para);

    const cliSrc = readOrEmpty(RESIDENCY_CLI);
    const fuSrc = readOrEmpty(join(REPO, "packages/remote/src/residency/force-unload.ts"));
    const sessSrc = readOrEmpty(join(REPO, "packages/core/src/residency/sessions.ts"));
    const routerSrc = readOrEmpty(join(REPO, "packages/remote/src/router.ts"));
    const proxySrc = readOrEmpty(join(REPO, "packages/core/src/openaiProxy.ts"));
    const mcpSrc = readOrEmpty(join(REPO, "packages/mcp/src/tools/residency.ts"));

    // (1) The #755 paragraph in Session affinity, as full phrases.
    expectPins(para, "#755", [
      "To drop one session binding without unloading anything, run `llamactl residency release-session <sessionId> --yes --node <name>` (#755).",
      "It sends one `residencyReleaseSession` mutation (`packages/remote/src/router.ts`) to the serving process, which calls `releaseResidencySession` (`packages/remote/src/residency/force-unload.ts`); the release never drains, revokes leases or stops a workload.",
      "The id follows the same bounds as the session header: at most 128 chars matching `[A-Za-z0-9._:-]`.",
      "An idle binding (refs 0) is dropped.",
      "A binding with in-flight requests refuses as `SessionInFlight` unless `--force` is given; a forced release drops only the binding, so the DF-05 leases of its in-flight requests stay held and `LeasesActive` still fences their stop.",
      "A dropped entry is deleted from the registry (`releaseSession` in `packages/core/src/residency/sessions.ts`): the late release of a force-released request is a no-op, and the next request carrying that id binds afresh with a new generation.",
      'The other refusals are `Unavailable` when no session registry is installed ("no session registry installed; nothing to release") or the registry has no per-session release, `SessionNotFound` for an unknown or idled-out id, and `SessionsUnknown` when the registry throws.',
      "Without `--yes` the CLI refuses before contacting the node, and `--node all` is refused.",
      "Success prints `Released session <id> (workload <workload>, <n> in-flight request(s))`, with `, forced; their leases stay held` appended inside the parentheses after a forced release; a refusal prints `residency release-session: <reason>: <detail>` and exits 1.",
      "The MCP `llamactl.residency.releaseSession` tool (`packages/mcp/src/tools/residency.ts`) sends the same mutation inside the MCP server's own process: it takes `sessionId`, optional `force` and `confirm`, refuses without `confirm: true` before calling the router, returns a refusal as `isError` with the payload, audits each confirmed call, and is not in the Ops Chat dispatch.",
    ]);

    // (2) The refusal reasons the doc must name, read from the
    // ReleaseSessionResult union up to the next export.
    const typeStart = fuSrc.indexOf("export type ReleaseSessionResult =");
    const typeSlice = fuSrc.slice(typeStart, fuSrc.indexOf("export function", typeStart));
    const reasons = [...typeSlice.matchAll(/reason: "([A-Za-z]+)"/g)].map((m) => m[1] ?? "").sort();
    expect(reasons).toEqual([
      "SessionInFlight",
      "SessionNotFound",
      "SessionsUnknown",
      "Unavailable",
    ]);

    // (3) releaseResidencySession maps the registry result and never
    // drains, revokes leases or stops anything.
    const releaseBody = enclosingBody(fuSrc, "export function releaseResidencySession(");
    expectPins(releaseBody, "releaseResidencySession", [
      'detail: "no session registry installed; nothing to release",',
      'detail: "the installed session registry does not support per-session release",',
      'reason: "SessionInFlight",',
      'reason: "SessionNotFound",',
      'reason: "SessionsUnknown",',
      "const result = registry.releaseSession(sessionId, force === true ? { force: true } : undefined);",
    ]);
    for (const banned of ["beginDrain", "commitUnload", "cancelDrain", "stop("]) {
      expect(releaseBody, banned).not.toContain(banned);
    }

    // (4) The router procedure bounds the id like the session header and
    // passes force through behind confirm.
    const routerStart = routerSrc.indexOf("  residencyReleaseSession: t.procedure");
    const routerSlice =
      routerStart === -1
        ? ""
        : routerSrc.slice(
            routerStart,
            routerSrc.indexOf("  serverStart: t.procedure", routerStart),
          );
    expectPins(routerSlice, "residencyReleaseSession procedure", [
      ".max(128)",
      ".regex(/^[A-Za-z0-9._:-]+$/)",
      "confirm: z.literal(true),",
      "releaseResidencySession({ sessionId: input.sessionId, force: input.force === true })",
    ]);

    // (5) The core registry: generation-guarded release, and per-session
    // release deleting the entry on idle and forced drops.
    const releaseFromBody = enclosingBody(sessSrc, "function releaseSessionFrom(");
    expectPins(releaseFromBody, "releaseSessionFrom", [
      'reason: "SessionInFlight",',
      "if (opts?.force !== true) {",
      "forced: true,",
      "forced: false,",
    ]);
    expect(
      releaseFromBody.split("sessions.delete(sessionId);").length - 1,
      "releaseSessionFrom sessions.delete count",
    ).toBeGreaterThanOrEqual(2);
    expectPins(
      enclosingBody(sessSrc, "    release(sessionId, generation): void {"),
      "session release",
      [
        "if (entry === undefined) return;",
        "if (generation !== undefined && entry.generation !== generation) return;",
      ],
    );
    expectPins(
      enclosingBody(sessSrc, "    acquire(sessionId, workload): SessionAcquireResult {"),
      "session acquire",
      ["const generation = ++nextGeneration;"],
    );
    expect(proxySrc).toContain("sessionRegistry.release(sessionId, generation);");

    // (6) The CLI: the --yes and single-node checks run before the node is
    // contacted, and the output lines match the doc.
    expectPins(enclosingBody(cliSrc, "function renderReleaseSession("), "renderReleaseSession", [
      "const inFlight = `${String(r.refs)} in-flight request(s)`;",
      'const forced = r.forced ? ", forced; their leases stay held" : "";',
      "return `Released session ${r.sessionId} (workload ${r.workload}, ${inFlight}${forced})\\n`;",
    ]);
    const runBody = enclosingBody(cliSrc, "async function runResidencyReleaseSession(");
    expectPins(runBody, "runResidencyReleaseSession", [
      '"residency release-session: --node all is not supported; name one node\\n"',
      "`residency release-session: ${result.reason}: ${result.detail}\\n`",
      "force: parsed.force,",
      "confirm: true,",
    ]);
    const usageCheck = runBody.indexOf("releaseSessionUsageError(parsed)");
    const clientCheck = runBody.indexOf("getNodeClientByName");
    expect(usageCheck, "releaseSessionUsageError call").toBeGreaterThanOrEqual(0);
    expect(usageCheck, "--yes check before node contact").toBeLessThan(clientCheck);
    expect(enclosingBody(cliSrc, "function releaseSessionUsageError(")).toContain(
      "if (!flags.yes) {",
    );

    // (7) The MCP tool projects the same mutation.
    expect(mcpSrc).toContain('"llamactl.residency.releaseSession"');
    expect(mcpSrc).toContain("caller.residencyReleaseSession(");
    expect(mcpSrc).toContain("llamactl.residency.forceUnload");
  });
});
