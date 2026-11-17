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
const RESIDENCY_CLI = join(REPO, "packages/cli/src/commands/residency.ts");
const CHAT_ADMISSION = join(REPO, "packages/remote/src/server/chat-admission.ts");

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

// Required flags per residency subcommand, parsed from the Subcommands lines
// of USAGE in residency.ts: the synopsis is everything before the first run
// of 2+ spaces, and any [bracketed] group in it is optional.
function residencyRequiredFlags(): Map<string, string[]> {
  const usage = /const USAGE = `([\s\S]*?)`;/.exec(readOrEmpty(RESIDENCY_CLI))?.[1] ?? "";
  const subcommands = /Subcommands:\n([\s\S]*?)\n\n/.exec(usage)?.[1] ?? "";
  const required = new Map<string, string[]>();
  for (const line of subcommands.split("\n")) {
    const m = /^ {2}([a-z][a-z-]*)((?: \S+)*?) {2,}/.exec(line);
    const sub = m?.[1];
    if (sub === undefined) continue;
    const synopsis = (m?.[2] ?? "").replaceAll(/\[[^\]]*\]/g, " ");
    required.set(
      sub,
      [...synopsis.matchAll(/--[a-z][a-z-]*/g)].map((f) => f[0]),
    );
  }
  return required;
}

// Every `llamactl residency <sub> ...` command in a code span or a code-block
// line, as the text to the end of that line.
function residencyCommands(md: string): { sub: string; command: string }[] {
  const commands: { sub: string; command: string }[] = [];
  for (const span of codeSpans(md)) {
    for (const m of span.matchAll(/\bllamactl residency ([a-z][a-z-]*)[^\n`]*/g)) {
      const sub = m[1];
      if (sub !== undefined) commands.push({ sub, command: m[0] });
    }
  }
  return commands;
}

function missingRequiredFlags(md: string, required: Map<string, string[]>): string[] {
  const reports: string[] = [];
  for (const { sub, command } of residencyCommands(md)) {
    const tokens = new Set(command.split(/\s+/));
    for (const flag of required.get(sub) ?? []) {
      if (!tokens.has(flag)) reports.push(`${command.trim()}: missing ${flag}`);
    }
  }
  return reports.sort();
}

// The "UNCOUNTED BY DESIGN:" and "DEFERRED:" blocks of the chat-admission.ts
// header, each as a list of bullets with comment continuations joined.
function chatAdmissionUncountedBullets(): string[] {
  const header = /^\/\*\*([\s\S]*?)\*\//.exec(readOrEmpty(CHAT_ADMISSION))?.[1] ?? "";
  const bullets: string[] = [];
  for (const m of header.matchAll(/(?:UNCOUNTED BY DESIGN|DEFERRED):([\s\S]*?)\n \*\n/g)) {
    const block = (m[1] ?? "").replaceAll(/\n \* */g, " ");
    for (const part of ` ${block}`.split(/\s+-\s+/)) {
      const text = part.trim();
      if (text !== "") bullets.push(text);
    }
  }
  return bullets;
}

// A bullet's lead: its first three words, cut at the first , ; ( or final dot.
function bulletLead(bullet: string): string {
  return bullet.split(/\s+/).slice(0, 3).join(" ").split(/[,;(]/)[0]!.replace(/\.$/, "").trim();
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

    // Every residency command the doc shows carries the flags USAGE marks
    // required. Kills: dropping --to from a documented apply-profile.
    const required = residencyRequiredFlags();
    for (const [sub, flags] of [
      ["plan", ["--node", "--to"]],
      ["apply-profile", ["--node", "--to"]],
      ["status", ["--node"]],
      ["force-unload", ["--reason", "--yes"]],
    ] as const) {
      for (const flag of flags) {
        expect(required.get(sub) ?? [], `USAGE required flags for ${sub}`).toContain(flag);
      }
    }
    const shown = new Set(residencyCommands(doc).map((c) => c.sub));
    for (const sub of shown) expect(required.has(sub), `USAGE line for ${sub}`).toBe(true);
    for (const sub of ["plan", "apply-profile", "cancel-operation", "force-unload"]) {
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
  // minResidencySeconds row planner-only, or dropping the production-gap
  // sentence.
  test("case 7: NodeRun knobs table matches ResidencyPolicySchema", () => {
    const KNOB_STATUS = {
      safetyMarginRatio: "enforced",
      minResidencySeconds: "enforced",
      switchCooldownSeconds: "enforced",
      idleEvictSeconds: "parse-only",
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
    expect(section).toContain("no runtime effect until");
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
  // Kills: passing residencyPolicy into the shared createProxy() (the
  // no-runtime-effect claim goes stale), or reverting the doc's wrong
  // serve.ts attribution.
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
    expect(createProxySrc).toContain("sharedProxy ??= createProxy();");
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
});
