// Shared helpers for the dynamic residency (docs/dynamic-residency.md) doc tests.
//
// README: every new doc-test slice goes in its own file in this directory
// (named <issue>-<slug>.test.ts), importing what it needs from here. Never
// append a slice to the shared main test file: parallel slice PRs that all
// append to one file's tail conflict with each other every batch.

import { expect } from "bun:test";
import { join, relative, resolve } from "node:path";

import { existsSync, readdirSync, readFileSync, statSync } from "../../../src/safe-fs.js";

export const REPO = resolve(import.meta.dir, "../../../../..");
export const DOC = join(REPO, "docs/dynamic-residency.md");
const INSTALL_TEST = join(REPO, "packages/remote/test/worker-rpc-install.test.ts");
const CLI_BIN = join(REPO, "packages/cli/src/bin.ts");
export const AGENT_CLI = join(REPO, "packages/cli/src/commands/agent.ts");
export const RESIDENCY_CLI = join(REPO, "packages/cli/src/commands/residency.ts");
const CHAT_ADMISSION = join(REPO, "packages/remote/src/server/chat-admission.ts");

export function readOrEmpty(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

export const doc = readOrEmpty(DOC);
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

export function sectionBody(isHeading: (line: string) => boolean): string | undefined {
  const lines = doc.split("\n");
  const start = lines.findIndex(isHeading);
  if (start === -1) return undefined;
  const end = lines.findIndex((line, i) => i > start && /^#{1,6} /.test(line));
  return lines.slice(start + 1, end === -1 ? lines.length : end).join("\n");
}

// Section matchers accept heading lines only (## or deeper, case-insensitive)
// so prose that merely mentions a phrase cannot shadow the real section.
export const sectionRe =
  (phrase: string) =>
  (line: string): boolean =>
    /^#{2,6} /.test(line) && line.toLowerCase().includes(phrase);

export const SECTIONS = {
  scope: sectionRe("scope"),
  storeBackups: sectionRe("residency store and backups"),
  ownership: sectionRe("desired-state ownership"),
  leases: sectionRe("lease registry, drain and force-unload"),
  statusPlanApply: sectionRe("status, plan and apply-profile"),
  operatorIdleEviction: sectionRe("operator-initiated idle eviction"),
  cancelRecovery: sectionRe("cancel and crash recovery"),
  admission: sectionRe("request admission"),
  declared: sectionRe("declared models and readiness"),
  artifact: sectionRe("model artifact and cache identity"),
  sleepWake: sectionRe("llama.cpp sleep and wake"),
  knobs: sectionRe("noderun residency policy knobs"),
  legacyLaunchers: sectionRe("cleanup of conflicting legacy launchers"),
  stagedEnable: sectionRe("staged enable order and rollback"),
} as const;

export function flat(text: string): string {
  return text.replaceAll(/\s+/g, " ");
}

// The text of the function or method that `signature` opens, up to its
// closing brace at the signature's indent. A signature that is missing or
// not unique yields "", so a pin can never match a second site.
export function enclosingBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  if (start === -1 || src.includes(signature, start + 1)) return "";
  const lineStart = src.lastIndexOf("\n", start) + 1;
  const indent = /^[ \t]*/.exec(src.slice(lineStart))?.[0] ?? "";
  const closers = new Set([`${indent}}`, `${indent}},`, `${indent}};`]);
  const lines = src.slice(start).split("\n");
  const end = lines.findIndex((line, i) => i > 0 && closers.has(line));
  return lines.slice(0, end === -1 ? lines.length : end + 1).join("\n");
}

// Every pin must appear in `text`; the label names the failing pin.
export function expectPins(text: string, label: string, pins: readonly string[]): void {
  for (const pin of pins) {
    expect(text, `${label} ${pin}`).toContain(pin);
  }
}

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

export function registeredInInstallTest(name: string): boolean {
  const suffix = name.startsWith("LLAMACTL_UPDATE_")
    ? name.slice("LLAMACTL_UPDATE_".length)
    : name.slice("LLAMACTL_".length);
  return installTestTokens.has(name) || installTestTokens.has(suffix);
}

export function unknownEnv(names: string[]): string[] {
  const reads = sourceEnvReads();
  return names.filter((name) => !reads.has(name) || !registeredInInstallTest(name)).sort();
}

export function codeSpans(md: string): string[] {
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

export function unknownCommands(md: string): string[] {
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
export function residencyRequiredFlags(): Map<string, string[]> {
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
export function residencyCommands(md: string): { sub: string; command: string }[] {
  const commands: { sub: string; command: string }[] = [];
  for (const span of codeSpans(md)) {
    for (const m of span.matchAll(/\bllamactl residency ([a-z][a-z-]*)[^\n`]*/g)) {
      const sub = m[1];
      if (sub !== undefined) commands.push({ sub, command: m[0] });
    }
  }
  return commands;
}

export function missingRequiredFlags(md: string, required: Map<string, string[]>): string[] {
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
export function chatAdmissionUncountedBullets(): string[] {
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
export function bulletLead(bullet: string): string {
  // Moved verbatim from a *.test.ts file, where this rule is off.
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return bullet.split(/\s+/).slice(0, 3).join(" ").split(/[,;(]/)[0]!.replace(/\.$/, "").trim();
}

export function productionRefs(symbol: string, definingFile: string): string[] {
  const refs: string[] = [];
  for (const file of srcFiles()) {
    if (file.rel === definingFile || /\.test\.tsx?$/.test(file.rel)) continue;
    if (srcText(file.path).includes(symbol)) refs.push(file.rel);
  }
  return refs.sort();
}
