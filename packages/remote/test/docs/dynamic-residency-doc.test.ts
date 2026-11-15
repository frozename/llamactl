import { routingCatalog } from "@llamactl/core";
// Part of #285 (DF-12 AC4): pins docs/dynamic-residency.md against source.
// Repo files only — no network, no processes, no live state — so a missing
// or stale doc fails by assertion, never by throw.
import { describe, expect, test } from "bun:test";
import { basename, join, relative, resolve } from "node:path";

import { PROFILE_SWITCH_BOOT_RECOVERY_MIN_AGE_MS } from "../../src/residency/boot-recovery.js";
import {
  RESIDENCY_PROFILES_ANNOTATION,
  RESIDENCY_PROTECTED_ANNOTATION,
} from "../../src/residency/coordinator.js";
import { defaultResidencyStorePath } from "../../src/residency/store.js";
import { existsSync, readdirSync, readFileSync, statSync } from "../../src/safe-fs.js";
import { lockFilePath } from "../../src/workload/lock.js";
import { MANAGED_BY_LABEL } from "../../src/workload/modelhost-schema.js";
import { ResidencyPolicySchema } from "../../src/workload/noderun-schema.js";

const REPO = resolve(import.meta.dir, "../../../..");
const DOC = join(REPO, "docs/dynamic-residency.md");
const INSTALL_TEST = join(REPO, "packages/remote/test/worker-rpc-install.test.ts");
const CLI_BIN = join(REPO, "packages/cli/src/bin.ts");
const AGENT_CLI = join(REPO, "packages/cli/src/commands/agent.ts");

function readOrEmpty(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

const doc = readOrEmpty(DOC);
// Whole [A-Z0-9_] tokens, so a name only counts as registered when it is not
// a fragment of a longer identifier.
const installTestTokens = new Set(
  [...readOrEmpty(INSTALL_TEST).matchAll(/[A-Z0-9_]+/g)].map((m) => m[0]),
);
const topVerbs = new Set(
  [...readOrEmpty(CLI_BIN).matchAll(/case "([a-z][a-z-]*)"/g)]
    .map((m) => m[1])
    .filter((verb): verb is string => verb !== undefined),
);

function sectionBody(isHeading: (line: string) => boolean): string | undefined {
  const lines = doc.split("\n");
  const start = lines.findIndex(isHeading);
  if (start === -1) return undefined;
  const end = lines.findIndex((line, i) => i > start && /^#{1,6} /.test(line));
  return lines.slice(start + 1, end === -1 ? lines.length : end).join("\n");
}

// Section matchers accept heading lines only (## or deeper, case-insensitive)
// so prose that merely mentions a phrase cannot shadow the real section.
const sectionRe =
  (phrase: string) =>
  (line: string): boolean =>
    /^#{2,6} /.test(line) && line.toLowerCase().includes(phrase);

const SECTIONS = {
  scope: sectionRe("scope"),
  storeBackups: sectionRe("residency store and backups"),
  ownership: sectionRe("desired-state ownership"),
  leases: sectionRe("lease registry, drain and force-unload"),
  statusPlanApply: sectionRe("status, plan and apply-profile"),
  cancelRecovery: sectionRe("cancel and crash recovery"),
  admission: sectionRe("request admission"),
  declared: sectionRe("declared models and readiness"),
  artifact: sectionRe("model artifact and cache identity"),
  sleepWake: sectionRe("llama.cpp sleep and wake"),
  knobs: sectionRe("noderun residency policy knobs"),
  legacyLaunchers: sectionRe("cleanup of conflicting legacy launchers"),
  stagedEnable: sectionRe("staged enable order and rollback"),
} as const;

interface SrcFile {
  path: string;
  rel: string;
}

let srcFilesCache: SrcFile[] | undefined;
const srcTextCache = new Map<string, string>();

function srcFiles(): SrcFile[] {
  if (srcFilesCache !== undefined) return srcFilesCache;
  const files: SrcFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      files.push({ path, rel: relative(REPO, path) });
    }
  };
  const packagesDir = join(REPO, "packages");
  for (const pkg of readdirSync(packagesDir)) {
    const src = join(packagesDir, pkg, "src");
    if (existsSync(src)) walk(src);
  }
  srcFilesCache = files;
  return files;
}

function srcText(path: string): string {
  let text = srcTextCache.get(path);
  if (text === undefined) {
    text = readFileSync(path, "utf8");
    srcTextCache.set(path, text);
  }
  return text;
}

let envReadsCache: Set<string> | undefined;

// Same walker as the I1 env baseline in worker-rpc-install.test.ts: every
// LLAMACTL_* literal under packages/*/src/**/*.ts(x) counts as read in source.
function sourceEnvReads(): Set<string> {
  if (envReadsCache !== undefined) return envReadsCache;
  const reads = new Set<string>();
  for (const file of srcFiles()) {
    if (!/\.tsx?$/.test(file.path)) continue;
    for (const m of srcText(file.path).matchAll(/LLAMACTL_[A-Z0-9_]+/g)) {
      reads.add(m[0]);
    }
  }
  envReadsCache = reads;
  return reads;
}

function registeredInInstallTest(name: string): boolean {
  const suffix = name.startsWith("LLAMACTL_UPDATE_")
    ? name.slice("LLAMACTL_UPDATE_".length)
    : name.slice("LLAMACTL_".length);
  return installTestTokens.has(name) || installTestTokens.has(suffix);
}

function unknownEnv(names: string[]): string[] {
  const reads = sourceEnvReads();
  return names.filter((name) => !reads.has(name) || !registeredInInstallTest(name)).sort();
}

function codeSpans(md: string): string[] {
  const spans: string[] = [];
  const rest = md.replaceAll(/```[\s\S]*?```/g, (block) => {
    spans.push(block);
    return "\n";
  });
  for (const m of rest.matchAll(/`[^`\n]+`/g)) {
    spans.push(m[0]);
  }
  return spans;
}

const SUBVERB_FILES = new Map<string, string>([
  ["residency", join(REPO, "packages/cli/src/commands/residency.ts")],
  ["agent", join(REPO, "packages/cli/src/commands/agent.ts")],
  ["controller", join(REPO, "packages/cli/src/commands/controller.ts")],
  ["keep-alive", join(REPO, "packages/cli/src/commands/keepAlive.ts")],
  ["server", join(REPO, "packages/cli/src/commands/server.ts")],
]);

const subverbCache = new Map<string, Set<string>>();

function subverbs(file: string): Set<string> {
  let verbs = subverbCache.get(file);
  if (verbs === undefined) {
    verbs = new Set(
      [...readOrEmpty(file).matchAll(/(?:case|sub [!=]==) "([a-z][a-z-]*)"/g)]
        .map((m) => m[1])
        .filter((verb): verb is string => verb !== undefined),
    );
    subverbCache.set(file, verbs);
  }
  return verbs;
}

function knownSubverb(verb: string, sub: string): boolean {
  const file = SUBVERB_FILES.get(verb);
  return file === undefined || subverbs(file).has(sub);
}

function unknownCommand(verb: string | undefined, sub: string | undefined): string | undefined {
  if (verb === undefined) return undefined;
  if (!topVerbs.has(verb)) return verb;
  if (sub !== undefined && !knownSubverb(verb, sub)) return `${verb} ${sub}`;
  return undefined;
}

function unknownCommands(md: string): string[] {
  const reports = new Set<string>();
  for (const span of codeSpans(md)) {
    for (const m of span.matchAll(/\bllamactl ([a-z][a-z-]*)(?: ([a-z][a-z-]*))?/g)) {
      const report = unknownCommand(m[1], m[2]);
      if (report !== undefined) reports.add(report);
    }
  }
  return [...reports].sort();
}

function productionRefs(symbol: string, definingFile: string): string[] {
  const refs: string[] = [];
  for (const file of srcFiles()) {
    if (file.rel === definingFile || /\.test\.tsx?$/.test(file.rel)) continue;
    if (srcText(file.path).includes(symbol)) refs.push(file.rel);
  }
  return refs.sort();
}

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

  // Kills: renaming `sub === "cancel-operation"` in residency.ts, or adding
  // `llamactl residency evict-all` to the doc.
  test("case 3: every llamactl command in code spans is a real verb/subcommand", () => {
    const spans = codeSpans(doc).join("\n");
    for (const command of [
      "llamactl residency status",
      "llamactl residency plan",
      "llamactl residency apply-profile",
      "llamactl residency cancel-operation",
      "llamactl residency force-unload",
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

  // Kills: adding a knob to ResidencyPolicySchema, or marking
  // idleEvictSeconds enforced in the doc.
  test("case 7: NodeRun knobs table matches ResidencyPolicySchema", () => {
    const KNOB_STATUS = {
      safetyMarginRatio: "enforced",
      minResidencySeconds: "planner-only",
      switchCooldownSeconds: "planner-only",
      idleEvictSeconds: "parse-only",
      residentPreference: "reserved",
      coldLoadPenaltyMs: "reserved",
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
    expect(section).toContain("#690");
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
  });

  // Kills: renaming cacheEpoch in omlx-cache-identity.ts, or dropping the
  // packages/core/src/resources/memory.ts citation.
  test("case 10: artifact identity", () => {
    const section = sectionBody(SECTIONS.artifact) ?? "";
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
    expect(stage(2)).toContain("LLAMACTL_CHAT_ADMISSION_MAX_EXECUTIONS");
    expect(stage(2)).toContain("LLAMACTL_DECLARED_MODELS");
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
});
