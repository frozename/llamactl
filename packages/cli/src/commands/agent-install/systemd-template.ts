/**
 * Linux systemd unit templates for the llamactl agent — the counterpart
 * to templates.ts (launchd). Pure: no filesystem, no subprocess.
 *
 * Escaping follows the systemd.service man page: `%` is a specifier in
 * every directive (`%%` for a literal), ExecStart additionally treats
 * `\` and `"` specially and expands `$VAR` when unquoted, so ExecStart
 * values double the `$`. Environment= values do not expand `$`.
 */

export interface BuildSystemdUnitOptions {
  scope: "user" | "system";
  execPath: string;
  args: string[];
  env: Record<string, string>;
  envFiles: string[];
  logDir?: string;
  workingDir?: string;
}

function assertNoNewlines(what: string, value: string): void {
  if (value.includes("\n") || value.includes("\r")) {
    throw new Error(`buildSystemdUnit: ${what} must not contain newlines`);
  }
}

/**
 * Function replacements everywhere: a `$$` replacement string in
 * String#replaceAll collapses to a single `$`, which would undo the
 * systemd escaping we are trying to emit.
 */
function escapeExecArg(arg: string): string {
  assertNoNewlines("ExecStart arg", arg);
  const escaped = arg
    .replaceAll("\\", () => "\\\\")
    .replaceAll('"', () => '\\"')
    .replaceAll("%", () => "%%")
    .replaceAll("$", () => "$$");
  // systemd word-splits on whitespace and these metacharacters.
  return escaped === "" || /[\s"';\\]/.test(escaped) ? `"${escaped}"` : escaped;
}

function escapeEnvValue(value: string): string {
  assertNoNewlines("Environment value", value);
  return value
    .replaceAll("\\", () => "\\\\")
    .replaceAll('"', () => '\\"')
    .replaceAll("%", () => "%%");
}

function escapePathValue(p: string): string {
  assertNoNewlines("path", p);
  return p.replaceAll("%", () => "%%");
}

export function buildSystemdUnit(opts: BuildSystemdUnitOptions): string {
  const lines: string[] = [];
  lines.push("[Unit]");
  lines.push("Description=llamactl agent");
  lines.push("Documentation=https://github.com/frozename/llamactl");
  if (opts.scope === "system") {
    lines.push("After=network-online.target");
    lines.push("Wants=network-online.target");
  }
  lines.push("");
  lines.push("[Service]");
  lines.push("Type=simple");
  lines.push(`ExecStart=${[opts.execPath, ...opts.args].map(escapeExecArg).join(" ")}`);
  lines.push("Restart=always");
  lines.push("KillMode=process");
  // #196: 100 is the lowest value a user unit can set under a user manager at 100 (inherited 200).
  if (opts.scope === "user") lines.push("OOMScoreAdjust=100");
  lines.push("RestartSec=10");
  if (opts.scope === "system" && opts.workingDir !== undefined) {
    lines.push(`WorkingDirectory=${escapePathValue(opts.workingDir)}`);
  }
  for (const [key, value] of Object.entries(opts.env)) {
    lines.push(`Environment="${escapeEnvValue(key)}=${escapeEnvValue(value)}"`);
  }
  for (const file of opts.envFiles) {
    lines.push(`EnvironmentFile=${escapePathValue(file)}`);
  }
  if (opts.logDir !== undefined) {
    lines.push(`StandardOutput=append:${escapePathValue(opts.logDir)}/stdout.log`);
    lines.push(`StandardError=append:${escapePathValue(opts.logDir)}/stderr.log`);
  }
  lines.push("");
  lines.push("[Install]");
  lines.push(`WantedBy=${opts.scope === "system" ? "multi-user.target" : "default.target"}`);
  lines.push("");
  return lines.join("\n");
}
