#!/usr/bin/env bun
// Issue frozename/llamactl#410 P6: read-only footprint measurements behind
// the Electron-retirement decision record. Prints exactly one JSON object to
// stdout (diagnostics to stderr), rerunnable in P7:
//   cd packages/app && bun run ../../scripts/measure-410.ts

import { dirname, join, relative, resolve } from "node:path";

import { existsSync, readdirSync, readFileSync } from "./safe-fs.js";

export const ROOT = join(import.meta.dir, "..");

export const REMOVABLE_DEPS: ReadonlySet<string> = new Set([
  "bufferutil",
  "electron",
  "electron-builder",
  "electron-trpc",
  "electron-vite",
  "undici",
  "utf-8-validate",
]);

export const ADDED_DEPS: readonly string[] = ["@playwright/test"];

const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

export interface DependencyFields {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

export interface LockWorkspace extends DependencyFields {
  name?: string;
  version?: string;
}

export interface BunLockfile {
  lockfileVersion?: number;
  workspaces: Record<string, LockWorkspace>;
  packages: Record<string, readonly unknown[]>;
}

export interface LockfileRemoval {
  workspace: string;
  deps: readonly string[];
}

export interface LockfileDelta {
  totalEntries: number;
  before: number;
  after: number;
  removed: number;
  removedPackages: ReadonlySet<string>;
}

export interface PackageJsonInput {
  path: string;
  json: Record<string, unknown>;
}

export interface DiffDepsEntry {
  name: string;
  path: string;
  field: string;
  version: string;
}

export interface DiffDepsResult {
  present: DiffDepsEntry[];
  absent: string[];
}

export interface GhRun {
  attempt: number;
  conclusion: string;
  status: string;
  createdAt: string;
  startedAt: string;
  updatedAt: string;
}

export interface RunSummary {
  runs: number;
  reruns: number;
  rerunPasses: number;
  failures: number;
  wallClockMinutes: number;
}

export type CiRunner = (args: string[]) => { code: number; stdout: string; stderr: string };

export interface CiOptions {
  sinceDays?: number;
  now?: Date;
  offline?: boolean;
}

export interface CiReport {
  workflows: Record<string, RunSummary>;
  electronUiTotal: RunSummary;
}

export interface CiResult {
  value: CiReport | null;
  reason: string | null;
}

export interface ThresholdInput {
  taskCoverage: readonly { id: string; covered: boolean }[];
  setup: {
    console: {
      commands: number;
      launcherPresent: boolean;
      signingRequired: boolean;
    };
  };
  dependencies: { removablePresent: number; added: number };
  renderer: { ratio: number | null };
  electronMcp: { consolePathReferences: number };
}

export type ThresholdVerdict = "fail" | "not-measured" | "pass";

export interface ThresholdResult {
  id: string;
  verdict: ThresholdVerdict;
}

export const CONSOLE_WORKFLOWS: readonly string[] = [
  "ui-audit",
  "ui-tier-a",
  "ui-flows-nightly",
  "console-e2e",
];

export const ELECTRON_UI_WORKFLOWS: readonly string[] = [
  "ui-audit",
  "ui-tier-a",
  "ui-flows-nightly",
];

export function countLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

const IMPORT_SPECIFIERS =
  /\b(?:import|export)\b[^"']*?\bfrom\s*["']([^"']+)["']|\bimport\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

export function extractImportSpecifiers(source: string): string[] {
  const code = source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  const out: string[] = [];
  for (const match of code.matchAll(IMPORT_SPECIFIERS)) {
    const spec = match[1] ?? match[2] ?? match[3];
    if (spec !== undefined && !out.includes(spec)) {
      out.push(spec);
    }
  }
  return out;
}

export function parseBunLock(text: string): BunLockfile {
  const parsed: unknown = JSON.parse(stripTrailingCommas(text));
  return parsed as BunLockfile;
}

function skipSpaces(text: string, from: number): number {
  let next = from;
  while (next < text.length && /\s/.test(text[next] ?? "")) {
    next += 1;
  }
  return next;
}

function isTrailingComma(text: string, index: number): boolean {
  const next = skipSpaces(text, index + 1);
  return text[next] === "}" || text[next] === "]";
}

function stripTrailingCommas(text: string): string {
  const out: string[] = [];
  let inString = false;
  let escaped = false;
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (inString) {
      out.push(char);
      inString = advanceStringState(char, escaped);
      escaped = inString && !escaped && char === "\\";
      index += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      out.push(char);
      index += 1;
      continue;
    }
    if (char === "," && isTrailingComma(text, index)) {
      index += 1;
      continue;
    }
    out.push(char);
    index += 1;
  }
  return out.join("");
}

function advanceStringState(char: string, escaped: boolean): boolean {
  if (escaped) {
    return true;
  }
  return char !== '"';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function depMapOf(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  const names: Record<string, string> = {};
  for (const field of DEP_FIELDS) {
    const block = value[field];
    if (isRecord(block)) {
      for (const [name, version] of Object.entries(block)) {
        if (typeof version === "string") {
          names[name] = version;
        }
      }
    }
  }
  return names;
}

function packageDeps(lock: BunLockfile, key: string): Record<string, string> {
  return depMapOf(lock.packages[key]?.[2]);
}

function workspaceDeps(workspace: LockWorkspace): Record<string, string> {
  return depMapOf(workspace);
}

function resolveDep(lock: BunLockfile, fromKey: string, dep: string): string | undefined {
  if (fromKey !== "") {
    const nested = `${fromKey}/${dep}`;
    if (lock.packages[nested] !== undefined) {
      return nested;
    }
  }
  return lock.packages[dep] === undefined ? undefined : dep;
}

function closureFrom(lock: BunLockfile, seed: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...seed];
  while (queue.length > 0) {
    const key = queue.shift();
    if (key === undefined || seen.has(key)) {
      continue;
    }
    seen.add(key);
    for (const dep of Object.keys(packageDeps(lock, key))) {
      const resolved = resolveDep(lock, key, dep);
      if (resolved !== undefined && !seen.has(resolved)) {
        queue.push(resolved);
      }
    }
  }
  return seen;
}

function workspaceSeeds(lock: BunLockfile, removals: readonly LockfileRemoval[]): string[] {
  const removedFor = new Map<string, Set<string>>();
  for (const removal of removals) {
    removedFor.set(removal.workspace, new Set(removal.deps));
  }
  const seeds: string[] = [];
  for (const [workspace, spec] of Object.entries(lock.workspaces)) {
    const removed = removedFor.get(workspace) ?? new Set<string>();
    for (const dep of Object.keys(workspaceDeps(spec))) {
      if (removed.has(dep)) {
        continue;
      }
      const resolved = resolveDep(lock, "", dep);
      if (resolved !== undefined) {
        seeds.push(resolved);
      }
    }
  }
  return seeds;
}

export function lockfileDelta(
  lock: BunLockfile,
  removals: readonly LockfileRemoval[],
): LockfileDelta {
  const before = closureFrom(lock, workspaceSeeds(lock, []));
  const after = closureFrom(lock, workspaceSeeds(lock, removals));
  const removedPackages = new Set<string>();
  for (const key of before) {
    if (!after.has(key)) {
      removedPackages.add(key);
    }
  }
  return {
    totalEntries: Object.keys(lock.packages).length,
    before: before.size,
    after: after.size,
    removed: removedPackages.size,
    removedPackages,
  };
}

function fieldDeps(
  input: PackageJsonInput,
  field: string,
  names: readonly string[],
): DiffDepsEntry[] {
  const block = input.json[field];
  if (!isRecord(block)) {
    return [];
  }
  const out: DiffDepsEntry[] = [];
  for (const name of names) {
    const version = block[name];
    if (typeof version === "string") {
      out.push({ field, name, path: input.path, version });
    }
  }
  return out;
}

export function diffDeps(
  pkgJsons: readonly PackageJsonInput[],
  names: readonly string[],
): DiffDepsResult {
  const present: DiffDepsEntry[] = [];
  for (const input of pkgJsons) {
    for (const field of DEP_FIELDS) {
      present.push(...fieldDeps(input, field, names));
    }
  }
  const found = new Set(present.map((entry) => entry.name));
  const absent = names.filter((name) => !found.has(name));
  return { absent, present };
}

export function summarizeRuns(runs: readonly GhRun[]): RunSummary {
  let reruns = 0;
  let rerunPasses = 0;
  let failures = 0;
  let minutes = 0;
  for (const run of runs) {
    if (run.attempt > 1) {
      reruns += run.attempt - 1;
      if (run.conclusion === "success") {
        rerunPasses += 1;
      }
    }
    if (run.conclusion === "failure") {
      failures += 1;
    }
    const start = Date.parse(run.startedAt);
    const end = Date.parse(run.updatedAt);
    if (Number.isFinite(start) && Number.isFinite(end)) {
      minutes += Math.max(0, (end - start) / 60_000);
    }
  }
  return {
    failures,
    rerunPasses,
    reruns,
    runs: runs.length,
    wallClockMinutes: Math.round(minutes),
  };
}

function emptySummary(): RunSummary {
  return { failures: 0, rerunPasses: 0, reruns: 0, runs: 0, wallClockMinutes: 0 };
}

function ghRunFields(): string {
  return ["attempt", "conclusion", "status", "createdAt", "startedAt", "updatedAt"].join(",");
}

function createdSince(now: Date, sinceDays: number): string {
  const since = new Date(now.getTime() - sinceDays * 86_400_000);
  return `>=${since.toISOString().slice(0, 10)}`;
}

function ghArgs(workflow: string, since: string): string[] {
  return [
    "run",
    "list",
    "--repo",
    "frozename/llamactl",
    "--workflow",
    `${workflow}.yml`,
    "--created",
    since,
    "--limit",
    "1000",
    "--json",
    ghRunFields(),
  ];
}

function toGhRun(value: unknown): GhRun | null {
  if (!isRecord(value)) {
    return null;
  }
  const asString = (key: string): string => {
    const raw = value[key];
    return typeof raw === "string" ? raw : "";
  };
  const attempt = value["attempt"];
  return {
    attempt: typeof attempt === "number" ? attempt : 1,
    conclusion: asString("conclusion"),
    createdAt: asString("createdAt"),
    startedAt: asString("startedAt"),
    status: asString("status"),
    updatedAt: asString("updatedAt"),
  };
}

function parseRuns(stdout: string): GhRun[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) {
    return [];
  }
  const runs: GhRun[] = [];
  for (const entry of parsed) {
    const run = toGhRun(entry);
    if (run !== null) {
      runs.push(run);
    }
  }
  return runs;
}

function combine(runs: GhRun[]): RunSummary {
  return summarizeRuns(runs);
}

export function collectCi(runner: CiRunner, opts: CiOptions): CiResult {
  if (opts.offline === true) {
    return { reason: "offline (MEASURE_410_OFFLINE=1)", value: null };
  }
  const now = opts.now ?? new Date();
  const sinceDays = opts.sinceDays ?? 30;
  const since = createdSince(now, sinceDays);
  const byWorkflow: Record<string, RunSummary> = {};
  try {
    for (const workflow of CONSOLE_WORKFLOWS) {
      const result = runner(ghArgs(workflow, since));
      if (result.code !== 0) {
        return { reason: `gh exited ${String(result.code)}: ${result.stderr.trim()}`, value: null };
      }
      byWorkflow[workflow] = combine(parseRuns(result.stdout));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { reason: `gh unavailable: ${message}`, value: null };
  }
  return { reason: null, value: { electronUiTotal: totalOf(byWorkflow), workflows: byWorkflow } };
}

function totalOf(byWorkflow: Record<string, RunSummary>): RunSummary {
  const total = emptySummary();
  for (const workflow of ELECTRON_UI_WORKFLOWS) {
    const summary = byWorkflow[workflow];
    if (summary === undefined) {
      continue;
    }
    total.failures += summary.failures;
    total.rerunPasses += summary.rerunPasses;
    total.reruns += summary.reruns;
    total.runs += summary.runs;
    total.wallClockMinutes += summary.wallClockMinutes;
  }
  return total;
}

export function evaluateThresholds(m: ThresholdInput): ThresholdResult[] {
  const covered = new Set<string>();
  for (const task of m.taskCoverage) {
    if (task.covered) {
      covered.add(task.id);
    }
  }
  const tasksCovered = ["T1", "T2", "T3", "T4", "T5"].every((id) => covered.has(id));
  const setup = m.setup.console;
  const renderer = m.renderer.ratio;
  return [
    { id: "T1-T5-no-cli-fallback", verdict: tasksCovered ? "pass" : "fail" },
    {
      id: "setup-le-3-no-signing",
      verdict:
        setup.commands <= 3 && setup.launcherPresent && !setup.signingRequired ? "pass" : "fail",
    },
    {
      id: "net-deps-removed-gt-added",
      verdict: m.dependencies.removablePresent > m.dependencies.added ? "pass" : "fail",
    },
    {
      id: "renderer-le-25pct",
      verdict: renderer === null ? "not-measured" : renderer <= 0.25 ? "pass" : "fail",
    },
    {
      id: "zero-electron-mcp",
      verdict: m.electronMcp.consolePathReferences === 0 ? "pass" : "fail",
    },
  ];
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) {
    return null;
  }
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  return isRecord(parsed) ? parsed : null;
}

function relPath(path: string): string {
  return relative(ROOT, path).split("\\").join("/");
}

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

function walkIfExists(dir: string): string[] {
  return existsSync(dir) ? walk(dir) : [];
}

function sourceFiles(dir: string): string[] {
  return walkIfExists(dir).filter((file) => /\.tsx?$/.test(file) && !file.endsWith(".d.ts"));
}

function packageJsonInputs(): PackageJsonInput[] {
  const inputs: PackageJsonInput[] = [];
  const rootJson = readJson(join(ROOT, "package.json"));
  if (rootJson !== null) {
    inputs.push({ json: rootJson, path: "package.json" });
  }
  for (const file of walkIfExists(join(ROOT, "packages"))) {
    if (file.endsWith("/package.json")) {
      const json = readJson(file);
      if (json !== null) {
        inputs.push({ json, path: relPath(file) });
      }
    }
  }
  return inputs;
}

function presentNames(diff: DiffDepsResult): string[] {
  const names = new Set<string>();
  for (const entry of diff.present) {
    names.add(entry.name);
  }
  return [...names];
}

export interface DependenciesMeasurement {
  added: number;
  addedDeclared: string[];
  present: DiffDepsEntry[];
  removablePresent: number;
  removableTotal: number;
  undiciRendererImportedByAnyFile: boolean;
}

function measureDependencies(pkgJsons: PackageJsonInput[]): DependenciesMeasurement {
  const removable = [...REMOVABLE_DEPS];
  const diff = diffDeps(pkgJsons, [...removable, ...ADDED_DEPS]);
  const present = presentNames(diff);
  const removablePresent = present.filter((name) => REMOVABLE_DEPS.has(name)).length;
  const added = present.filter((name) => ADDED_DEPS.includes(name)).length;
  const undiciRenderer = rendererImportsUndici();
  return {
    added,
    addedDeclared: ADDED_DEPS.filter((name) => present.includes(name)),
    present: diff.present,
    removablePresent,
    removableTotal: removable.length,
    undiciRendererImportedByAnyFile: undiciRenderer,
  };
}

function rendererImportsUndici(): boolean {
  for (const file of sourceFiles(join(ROOT, "packages/app/src"))) {
    const specs = extractImportSpecifiers(readFileSync(file, "utf8"));
    if (specs.some((spec) => spec === "undici" || spec.startsWith("undici/"))) {
      return true;
    }
  }
  return false;
}

function resolveImport(fromFile: string, spec: string, srcDir: string): string | null {
  if (spec.startsWith(".")) {
    const base = resolve(dirname(fromFile), spec);
    return firstExistingModule(base);
  }
  if (spec.startsWith("@/")) {
    return firstExistingModule(join(srcDir, spec.slice(2)));
  }
  return null;
}

function firstExistingModule(base: string): string | null {
  const candidates = [
    base,
    base.endsWith(".js") ? base.slice(0, -3) : base,
    `${base}.ts`,
    `${base}.tsx`,
  ];
  for (const candidate of candidates) {
    if (/\.(?:ts|tsx)$/.test(candidate) && existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export interface RendererMeasurement {
  entry: string;
  ratio: number | null;
  retainedFiles: number;
  retainedLines: number;
  totalFiles: number;
  totalLines: number;
}

function measureRenderer(): RendererMeasurement {
  const srcDir = join(ROOT, "packages/app/src");
  const entry = join(srcDir, "main.web.tsx");
  const seen = new Set<string>();
  const queue: string[] = [entry];
  while (queue.length > 0) {
    const file = queue.shift();
    if (file === undefined || seen.has(file) || !existsSync(file)) {
      continue;
    }
    seen.add(file);
    for (const spec of extractImportSpecifiers(readFileSync(file, "utf8"))) {
      const next = resolveImport(file, spec, srcDir);
      if (next !== null) {
        queue.push(next);
      }
    }
  }
  const retained = [...seen].filter((file) => file.endsWith(".tsx") || file.endsWith(".ts"));
  const retainedLines = retained.reduce(
    (sum, file) => sum + countLines(readFileSync(file, "utf8")),
    0,
  );
  const allSource = sourceFiles(srcDir);
  const totalLines = allSource.reduce(
    (sum, file) => sum + countLines(readFileSync(file, "utf8")),
    0,
  );
  const ratio =
    totalLines === 0 ? null : Math.round((retainedLines / totalLines) * 10_000) / 10_000;
  return {
    entry: relPath(entry),
    ratio,
    retainedFiles: retained.length,
    retainedLines,
    totalFiles: allSource.length,
    totalLines,
  };
}

function measureElectron(): Record<string, unknown> {
  const files = walkIfExists(join(ROOT, "packages/app/electron"));
  return { count: files.length, files: files.map(relPath).sort() };
}

export interface ElectronMcpMeasurement {
  consolePathReferences: number;
  referencingWorkflows: string[];
}

function measureElectronMcp(): ElectronMcpMeasurement {
  const workflowsDir = join(ROOT, ".github/workflows");
  const referencing: string[] = [];
  let consolePathReferences = 0;
  for (const file of walkIfExists(workflowsDir)) {
    if (!file.endsWith(".yml")) {
      continue;
    }
    const text = readFileSync(file, "utf8");
    const matches = text.match(/electron-mcp/g) ?? [];
    if (matches.length > 0) {
      referencing.push(relPath(file));
    }
    if (file.endsWith("console-e2e.yml")) {
      consolePathReferences = matches.length;
    }
  }
  return { consolePathReferences, referencingWorkflows: referencing.sort() };
}

function countMatches(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

export interface ShimsMeasurement {
  absent: string[];
  bunShim: boolean;
  bunSqliteShim: boolean;
  cjsFormatUses: number;
  dispatcherLines: number;
  v10ShimSymbols: number;
  workspaceBundleEntries: number;
}

const SHIM_FILES = {
  dispatcher: "packages/app/electron/trpc/dispatcher.ts",
  vite: "packages/app/electron.vite.config.ts",
} as const;

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

export function measureShims(root: string = ROOT): ShimsMeasurement {
  const vite = readIfExists(join(root, SHIM_FILES.vite));
  const dispatcher = readIfExists(join(root, SHIM_FILES.dispatcher));
  const bundle = /const WORKSPACE_BUNDLE = \[([\s\S]*?)\]/.exec(vite ?? "")?.[1] ?? "";
  return {
    absent: Object.values(SHIM_FILES)
      .filter((file) => !existsSync(join(root, file)))
      .sort(),
    bunShim: existsSync(join(root, "packages/app/electron/shims/bun.ts")),
    bunSqliteShim: existsSync(join(root, "packages/app/electron/shims/bun-sqlite.ts")),
    cjsFormatUses: countMatches(vite ?? "", /format:\s*"cjs"/g),
    dispatcherLines: dispatcher === null ? 0 : countLines(dispatcher),
    v10ShimSymbols: countMatches(
      dispatcher ?? "",
      /asyncIterableToObservable|V10ProcedureCallOptions/g,
    ),
    workspaceBundleEntries: countMatches(bundle, /"[^"]+"/g),
  };
}

function braceBlock(text: string, openingIndex: number): string {
  let depth = 0;
  let index = openingIndex;
  while (index < text.length) {
    const char = text[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(openingIndex, index + 1);
      }
    }
    index += 1;
  }
  return text.slice(openingIndex);
}

export interface ConsoleUpkeepMeasurement {
  absent: string[];
  allowlistKeys: number;
  mutationEntries: number;
  projectionEntries: number;
  sentinelCases: number;
}

const UPKEEP_FILES = {
  allowlist: "packages/remote/src/console/allowlist.ts",
  seed: "packages/app/e2e/harness/fixtures/seed.ts",
} as const;

function braceBlockAfter(text: string | null, marker: string): string {
  if (text === null) {
    return "";
  }
  return braceBlock(text, text.indexOf("{", text.indexOf(marker)));
}

export function measureConsoleUpkeep(root: string = ROOT): ConsoleUpkeepMeasurement {
  const body = braceBlockAfter(
    readIfExists(join(root, UPKEEP_FILES.allowlist)),
    "CONSOLE_ALLOWLIST",
  );
  const keys = [...body.matchAll(/^ {2}([A-Za-z]\w*):\s*\{/gm)].map((match) => match[1] ?? "");
  const sentinelBody = braceBlockAfter(
    readIfExists(join(root, UPKEEP_FILES.seed)),
    "E2E_SENTINELS",
  );
  const sentinels = [...sentinelBody.matchAll(/^ {2}([A-Za-z]\w*):/gm)].map(
    (match) => match[1] ?? "",
  );
  return {
    absent: Object.values(UPKEEP_FILES)
      .filter((file) => !existsSync(join(root, file)))
      .sort(),
    allowlistKeys: keys.length,
    mutationEntries: countMatches(body, /type:\s*"mutation"/g),
    projectionEntries: countMatches(body, /project:\s*\(out\)\s*=>/g),
    sentinelCases: sentinels.length,
  };
}

export interface CoverageProbe {
  needles: readonly string[];
  spec: string;
}

export type CoverageStatus = "covered" | "missing" | "partial";

export interface TaskCoverageRow {
  covered: boolean;
  id: string;
  missingNeedles: string[];
  specs: string[];
  status: CoverageStatus;
  wallTime: null;
}

export interface TaskCoverageMeasurement {
  rows: TaskCoverageRow[];
}

// Plan #410 P6 task list mapped to the specs that actually exist in
// packages/app/e2e. Coverage means the spec exists AND its comment-stripped
// text contains every needle: stripCommentLines drops commented lines before
// matching, so a needle that appears only in a comment never counts. The T2,
// T5 and T6 needles are assertion fragments — each one matches
// /expect\(|\)\.to[A-Z]/ — so a hit implies the spec asserts the behaviour
// rather than mentioning it. T1, T3 and T4 keep their legacy bare needles
// until a follow-up tightens them the same way.
export const COVERAGE_PROBES: Readonly<Record<string, readonly CoverageProbe[]>> = {
  T1: [
    { needles: ["unreachable"], spec: "packages/app/e2e/fleet.spec.ts" },
    { needles: ["unreachable: e2e node unreachable"], spec: "packages/app/e2e/nodes.spec.ts" },
  ],
  T2: [
    {
      needles: ['[target="_blank"]`)).toHaveCount(1)'],
      spec: "packages/app/e2e/fleet.spec.ts",
    },
    {
      needles: [
        'await expect(row).toContainText("Running");',
        '-stopped")).toContainText("Stopped");',
        'await expect(row.getByRole("link", { name: endpoint })).toHaveAttribute("href", endpoint);',
        'await expect(liveStatus).toContainText(`"advertisedEndpoint": "${endpoint}"`);',
      ],
      spec: "packages/app/e2e/workloads.spec.ts",
    },
  ],
  T3: [{ needles: ["agent-1", "serverLogs"], spec: "packages/app/e2e/logs.spec.ts" }],
  T4: [
    {
      needles: ["the typed name matches", "zero stop mutations"],
      spec: "packages/app/e2e/lifecycle.spec.ts",
    },
  ],
  T5: [
    {
      needles: [
        "expect(localStops).toEqual([]);",
        'await expect(connA).toHaveAttribute("data-state", "streaming");',
        'await expect(connB).toHaveAttribute("data-state", "streaming");',
        ".filter({ hasText: markerA })).toHaveCount(0);",
        ".filter({ hasText: markerB })).toHaveCount(0);",
      ],
      spec: "packages/app/e2e/two-tabs.spec.ts",
    },
  ],
  T6: [
    {
      needles: [
        'await expect(page.getByRole("alert")).toHaveText(INVALID_SESSION_MESSAGE);',
        'await expect(page.getByRole("alert")).toHaveCount(0);',
        "expect(after[0]?.value).not.toBe(oldCookie);",
      ],
      spec: "packages/app/e2e/restart.spec.ts",
    },
  ],
};

export const CREDENTIALS_SPEC_PROBE: CoverageProbe = {
  needles: [
    "expect(sentinelsIn(entry.request.url)).toEqual([]);",
    "expect(sentinelsIn(headerText)).toEqual([]);",
    'expect(sentinelsIn(entry.response.content?.text ?? "")).toEqual([]);',
    'expect(await harPage.evaluate(() => document.cookie)).toBe("");',
    "expect(cookie?.httpOnly).toBe(true);",
  ],
  spec: "packages/app/e2e/credentials.spec.ts",
};

export function stripCommentLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith("//") && !trimmed.startsWith("/*") && !trimmed.startsWith("*");
    })
    .join("\n");
}

function probeMisses(
  probe: CoverageProbe,
  text: string | null,
): { hit: boolean; misses: string[] } {
  if (text === null) {
    return { hit: false, misses: [`${probe.spec} (absent)`] };
  }
  const code = stripCommentLines(text);
  const misses = probe.needles
    .filter((needle) => !code.includes(needle))
    .map((needle) => `${probe.spec}#${needle}`);
  return { hit: misses.length === 0, misses };
}

export function coverageStatus(
  probes: readonly CoverageProbe[],
  readSpec: (spec: string) => string | null,
): { covered: boolean; missingNeedles: string[]; status: CoverageStatus } {
  if (probes.length === 0) {
    return { covered: false, missingNeedles: [], status: "missing" };
  }
  const missingNeedles: string[] = [];
  let hit = 0;
  for (const probe of probes) {
    const result = probeMisses(probe, readSpec(probe.spec));
    missingNeedles.push(...result.misses);
    if (result.hit) {
      hit += 1;
    }
  }
  const status: CoverageStatus =
    missingNeedles.length === 0 ? "covered" : hit > 0 ? "partial" : "missing";
  return { covered: status === "covered", missingNeedles, status };
}

export function measureTaskCoverage(root: string = ROOT): TaskCoverageMeasurement {
  const rows: TaskCoverageRow[] = [];
  for (const id of ["T1", "T2", "T3", "T4", "T5", "T6"]) {
    const probes = COVERAGE_PROBES[id] ?? [];
    const status = coverageStatus(probes, (spec) => readIfExists(join(root, spec)));
    rows.push({
      covered: status.covered,
      id,
      missingNeedles: status.missingNeedles,
      specs: probes.map((probe) => probe.spec),
      status: status.status,
      wallTime: null,
    });
  }
  return { rows };
}

export interface SecurityChecklistMeasurement {
  credentialsSpec: boolean;
  items: { evidenced: boolean; file: string; item: string; missingNeedles: string[] }[];
}

export function measureSecurityChecklist(root: string = ROOT): SecurityChecklistMeasurement {
  const probes: [string, string, string[]][] = [
    [
      "session cookie is port-scoped HttpOnly",
      "packages/remote/test/console/session.test.ts",
      ["HttpOnly session cookie"],
    ],
    [
      "CSRF + loopback hostname guard",
      "packages/remote/test/console/guards.test.ts",
      ["cross_site_request_forbidden", "refuses a non-loopback hostname"],
    ],
    ["batch size guard", "packages/remote/test/console/batch.test.ts", ["bad_batch"]],
    [
      "no sentinel on the wire",
      "packages/remote/test/console/redaction.test.ts",
      ["no sentinel on the wire"],
    ],
    [
      "node credentials fail closed",
      "packages/remote/test/console/fail-closed.test.ts",
      ["node_credentials_unavailable"],
    ],
    [
      "zero stop calls on precheck failure",
      "packages/remote/test/console/stop-precheck.test.ts",
      ["zero stop calls"],
    ],
    [
      "forged stops refused before backend",
      "packages/app/e2e/lifecycle.spec.ts",
      ["forged stops are refused before the backend"],
    ],
    ["sentinel guard in harness", "packages/app/e2e/harness/test.ts", ["sentinelGuard"]],
    [
      "node scope never touches localStorage",
      "packages/remote/test/console/node-scope.test.ts",
      ["never touches localStorage"],
    ],
  ];
  const items = probes.map(([item, file, needles]) => {
    const text = existsSync(join(root, file)) ? readFileSync(join(root, file), "utf8") : "";
    return {
      evidenced: needles.length > 0 && needles.every((needle) => text.includes(needle)),
      file,
      item,
      missingNeedles: needles.filter((needle) => !text.includes(needle)),
    };
  });
  const credentialsSpec = coverageStatus([CREDENTIALS_SPEC_PROBE], (spec) =>
    readIfExists(join(root, spec)),
  ).covered;
  return { credentialsSpec, items };
}

export interface ConsoleSetupMeasurement {
  buildWebPresent: boolean;
  commands: number;
  launcherPresent: boolean;
  signingRequired: boolean;
}

export interface SetupMeasurement {
  buildWebPresent: boolean;
  console: ConsoleSetupMeasurement;
  signing: { adHoc: boolean; identity: string };
}

function measureSetup(pkgJsons: PackageJsonInput[]): SetupMeasurement {
  const app = pkgJsons.find((entry) => entry.path === "packages/app/package.json");
  const rawScripts = app === undefined ? undefined : app.json["scripts"];
  const scripts = isRecord(rawScripts) ? rawScripts : {};
  const builder = existsSync(join(ROOT, "packages/app/electron-builder.yml"))
    ? readFileSync(join(ROOT, "packages/app/electron-builder.yml"), "utf8")
    : "";
  const identity = /^\s*identity:\s*"?([^"\n]+)"?/m.exec(builder)?.[1]?.trim() ?? "";
  const signingRequired = identity.length > 0 && identity !== "-";
  const launcherPresent =
    existsSync(join(ROOT, "packages/cli/src/commands/console.ts")) ||
    (existsSync(join(ROOT, "packages/cli/src/bin.ts")) &&
      readFileSync(join(ROOT, "packages/cli/src/bin.ts"), "utf8").includes('case "console"'));
  return {
    buildWebPresent: typeof scripts["build:web"] === "string",
    console: {
      buildWebPresent: typeof scripts["build:web"] === "string",
      commands: 3,
      launcherPresent,
      signingRequired,
    },
    signing: { adHoc: identity === "-", identity },
  };
}

const GH_TIMEOUT_MS = 30_000;

function ghRunner(args: string[]): { code: number; stderr: string; stdout: string } {
  const proc = Bun.spawnSync({ cmd: ["gh", ...args], cwd: ROOT, timeout: GH_TIMEOUT_MS });
  return {
    code: proc.exitCode,
    stderr: proc.stderr.toString("utf8"),
    stdout: proc.stdout.toString("utf8"),
  };
}

function currentCommit(): string | null {
  const proc = Bun.spawnSync({ cmd: ["git", "rev-parse", "HEAD"], cwd: ROOT });
  return proc.exitCode === 0 ? proc.stdout.toString("utf8").trim() : null;
}

function measureCi(): Record<string, unknown> {
  const offline = process.env["MEASURE_410_OFFLINE"] === "1";
  const result = collectCi(ghRunner, { offline });
  return {
    electronUiWorkflows: [...ELECTRON_UI_WORKFLOWS],
    offline,
    reason: result.reason,
    runsOn: {
      "console-e2e": "ubuntu-latest",
      "ui-audit": "macos-latest",
      "ui-flows-nightly": "macos-latest",
      "ui-tier-a": "macos-latest",
    },
    value: result.value,
  };
}

export function thresholdInput(
  setup: SetupMeasurement,
  dependencies: DependenciesMeasurement,
  renderer: RendererMeasurement,
  electronMcp: ElectronMcpMeasurement,
  taskCoverage: TaskCoverageMeasurement,
): ThresholdInput {
  return {
    dependencies: { added: dependencies.added, removablePresent: dependencies.removablePresent },
    electronMcp: { consolePathReferences: electronMcp.consolePathReferences },
    renderer: { ratio: renderer.ratio },
    setup: {
      console: {
        commands: setup.console.commands,
        launcherPresent: setup.console.launcherPresent,
        signingRequired: setup.console.signingRequired,
      },
    },
    taskCoverage: taskCoverage.rows,
  };
}

export interface CiIndependentFields {
  taskCoverage: TaskCoverageMeasurement;
  thresholds: ThresholdResult[];
}

export function ciIndependentFields(): CiIndependentFields {
  const pkgJsons = packageJsonInputs();
  const setup = measureSetup(pkgJsons);
  const dependencies = measureDependencies(pkgJsons);
  const renderer = measureRenderer();
  const electronMcp = measureElectronMcp();
  const taskCoverage = measureTaskCoverage();
  return {
    taskCoverage,
    thresholds: evaluateThresholds(
      thresholdInput(setup, dependencies, renderer, electronMcp, taskCoverage),
    ),
  };
}

function buildReport(): Record<string, unknown> {
  const lockText = readFileSync(join(ROOT, "bun.lock"), "utf8");
  const lock = parseBunLock(lockText);
  const pkgJsons = packageJsonInputs();
  const setup = measureSetup(pkgJsons);
  const dependencies = measureDependencies(pkgJsons);
  const renderer = measureRenderer();
  const electronMcp = measureElectronMcp();
  const taskCoverage = measureTaskCoverage();
  const delta = lockfileDelta(lock, [{ deps: [...REMOVABLE_DEPS], workspace: "packages/app" }]);
  return {
    ci: measureCi(),
    commit: currentCommit(),
    consoleUpkeep: measureConsoleUpkeep(),
    dependencies,
    electron: measureElectron(),
    electronMcp,
    lockfile: { delta },
    renderer,
    schema: "measure-410/v1",
    securityChecklist: measureSecurityChecklist(),
    setup,
    shims: measureShims(),
    taskCoverage,
    thresholds: evaluateThresholds(
      thresholdInput(setup, dependencies, renderer, electronMcp, taskCoverage),
    ),
  };
}

function main(): void {
  try {
    process.stdout.write(`${JSON.stringify(buildReport(), null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`measure-410: ${message}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
