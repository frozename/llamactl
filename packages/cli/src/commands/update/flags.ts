export type UpdateMode = "apply" | "check" | "rollback";

export interface UpdateFlags {
  mode: UpdateMode;
  ref: string;
  /** --rollback's optional target: branch@sha, a sha, or any git revision. */
  rollbackRef: string | null;
  allowRedCi: boolean;
  waitIdleSec: number;
  json: boolean;
  repo: string | null;
  serviceManager: "launchd" | "systemd" | null;
  controllerUnit: string | null;
  agentUnit: string | null;
}

export const DEFAULT_TARGET_REF = "origin/main";
export const DEFAULT_WAIT_IDLE_SEC = 600;

const VALUE_FLAGS = new Set([
  "--agent-unit",
  "--controller-unit",
  "--ref",
  "--repo",
  "--service-manager",
  "--wait-idle",
]);

function defaultFlags(): UpdateFlags {
  return {
    mode: "check",
    ref: DEFAULT_TARGET_REF,
    rollbackRef: null,
    allowRedCi: false,
    waitIdleSec: DEFAULT_WAIT_IDLE_SEC,
    json: false,
    repo: null,
    serviceManager: null,
    controllerUnit: null,
    agentUnit: null,
  };
}

function applyValue(flags: UpdateFlags, key: string, value: string): string | null {
  switch (key) {
    case "--ref":
      flags.ref = value;
      return null;
    case "--repo":
      flags.repo = value;
      return null;
    case "--controller-unit":
      flags.controllerUnit = value;
      return null;
    case "--agent-unit":
      flags.agentUnit = value;
      return null;
    case "--service-manager":
      if (value !== "systemd" && value !== "launchd") {
        return `--service-manager must be systemd or launchd, got ${value}`;
      }
      flags.serviceManager = value;
      return null;
    case "--wait-idle": {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) return `invalid --wait-idle: ${value}`;
      flags.waitIdleSec = n;
      return null;
    }
    default:
      return `unknown flag ${key}`;
  }
}

function applySwitch(flags: UpdateFlags, arg: string): string | null {
  switch (arg) {
    case "--check":
      flags.mode = "check";
      return null;
    case "--apply":
      flags.mode = "apply";
      return null;
    case "--allow-red-ci":
      flags.allowRedCi = true;
      return null;
    case "--json":
      flags.json = true;
      return null;
    default:
      return `unknown flag ${arg}`;
  }
}

type ParseStep = { next: number } | { error: string };

function parseRollback(
  flags: UpdateFlags,
  args: readonly string[],
  i: number,
  eq: number,
): ParseStep {
  flags.mode = "rollback";
  const arg = args[i] ?? "";
  if (eq > 0) {
    flags.rollbackRef = arg.slice(eq + 1);
    return { next: i + 1 };
  }
  const next = args[i + 1];
  if (next === undefined || next.startsWith("-")) return { next: i + 1 };
  flags.rollbackRef = next;
  return { next: i + 2 };
}

function parseValueFlag(
  flags: UpdateFlags,
  args: readonly string[],
  i: number,
  key: string,
  eq: number,
): ParseStep {
  const value = eq > 0 ? (args[i] ?? "").slice(eq + 1) : args[i + 1];
  if (value === undefined || value === "") return { error: `${key} needs a value` };
  const error = applyValue(flags, key, value);
  if (error !== null) return { error };
  return { next: eq > 0 ? i + 1 : i + 2 };
}

function parseOne(flags: UpdateFlags, args: readonly string[], i: number): ParseStep {
  const arg = args[i] ?? "";
  if (arg === "-h" || arg === "--help") return { error: "help" };
  const eq = arg.indexOf("=");
  const key = eq > 0 ? arg.slice(0, eq) : arg;
  if (key === "--rollback") return parseRollback(flags, args, i, eq);
  if (VALUE_FLAGS.has(key)) return parseValueFlag(flags, args, i, key, eq);
  const error = applySwitch(flags, arg);
  return error === null ? { next: i + 1 } : { error };
}

/**
 * Parse `llamactl update` flags. Value flags take `--key value` or
 * `--key=value`; `--rollback` takes an optional positional target.
 */
export function parseUpdateFlags(args: readonly string[]): UpdateFlags | { error: string } {
  const flags = defaultFlags();
  let i = 0;
  while (i < args.length) {
    const step = parseOne(flags, args, i);
    if ("error" in step) return step;
    i = step.next;
  }
  return flags;
}
