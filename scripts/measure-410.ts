// scripts/measure-410.ts
// API surface for frozename/llamactl#410 P6: the reproducible footprint
// measurements behind the Electron-retirement decision record. Types
// and signatures only — every function throws until the implementation
// lands, and the dependency sets are empty placeholders.

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

export const REMOVABLE_DEPS: ReadonlySet<string> = new Set<string>();
export const ADDED_DEPS: readonly string[] = [];

export function countLines(_text: string): number {
  throw new Error("not implemented");
}

export function extractImportSpecifiers(_source: string): string[] {
  throw new Error("not implemented");
}

export function parseBunLock(_text: string): BunLockfile {
  throw new Error("not implemented");
}

export function lockfileDelta(
  _lock: BunLockfile,
  _removals: readonly LockfileRemoval[],
): LockfileDelta {
  throw new Error("not implemented");
}

export function diffDeps(
  _pkgJsons: readonly PackageJsonInput[],
  _names: readonly string[],
): DiffDepsResult {
  throw new Error("not implemented");
}

export function summarizeRuns(_runs: readonly GhRun[]): RunSummary {
  throw new Error("not implemented");
}

export function collectCi(_runner: CiRunner, _opts: CiOptions): CiResult {
  throw new Error("not implemented");
}

export function evaluateThresholds(_m: ThresholdInput): ThresholdResult[] {
  throw new Error("not implemented");
}
