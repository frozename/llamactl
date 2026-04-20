/**
 * macOS launchd plist templates for the llamactl agent.
 *
 * Two templates live here: a user-scope LaunchAgent and a system-scope
 * LaunchDaemon. Both use the same strict `{{key}}` placeholder grammar
 * (lowercase alphanumeric, no whitespace inside the braces) and are
 * consumed by {@link renderPlist}.
 *
 * The helpers in this module are pure — no filesystem, no subprocess.
 * Phase 3 consumes {@link buildUserPlist} and {@link buildSystemPlist}
 * to write the rendered XML to disk and then invoke `launchctl`.
 */

/**
 * LaunchAgent (user-scope) plist template. Written to
 * `~/Library/LaunchAgents/<label>.plist` and loaded via
 * `launchctl load`.
 */
export const LAUNCHD_USER_TEMPLATE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{{label}}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{{exec_path}}</string>
{{args_array}}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>{{log_dir}}/stdout.log</string>
  <key>StandardErrorPath</key><string>{{log_dir}}/stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict>
{{env_dict}}
  </dict>
</dict>
</plist>
`;

/**
 * LaunchDaemon (system-scope) plist template. Written to
 * `/Library/LaunchDaemons/<label>.plist` and loaded via
 * `launchctl bootstrap system`.
 *
 * Identical shape to {@link LAUNCHD_USER_TEMPLATE} plus three extra keys
 * (`UserName`, `GroupName`, `WorkingDirectory`) placed immediately after
 * `Label`. launchd is indifferent to key order; the placement is chosen
 * purely for readability / snapshot-diff minimality.
 */
export const LAUNCHD_SYSTEM_TEMPLATE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{{label}}</string>
  <key>UserName</key><string>{{user}}</string>
  <key>GroupName</key><string>{{group}}</string>
  <key>WorkingDirectory</key><string>{{working_dir}}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{{exec_path}}</string>
{{args_array}}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>{{log_dir}}/stdout.log</string>
  <key>StandardErrorPath</key><string>{{log_dir}}/stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict>
{{env_dict}}
  </dict>
</dict>
</plist>
`;

/**
 * XML-escape element content. We only ever interpolate into element
 * content (never attribute values), so quotes do not need escaping.
 *
 * Order matters: `&` must be escaped first, otherwise subsequent
 * substitutions would double-escape the introduced `&amp;` prefix
 * (e.g. `<` → `&lt;` → `&amp;lt;`).
 */
export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Render each arg as `{indent}<string>{xml-escaped-arg}</string>`
 * joined by `\n`. Returns an empty string for an empty array. No
 * leading or trailing newline — the surrounding template owns those.
 */
export function renderArgsArray(args: string[], indent = '    '): string {
  if (args.length === 0) return '';
  return args.map((a) => `${indent}<string>${xmlEscape(a)}</string>`).join('\n');
}

/**
 * Render each `[key, value]` as
 * `{indent}<key>{xml-escaped-key}</key><string>{xml-escaped-value}</string>`
 * joined by `\n`. Returns an empty string for an empty map. No leading
 * or trailing newline.
 *
 * Uses `Object.entries` so insertion order is preserved — snapshot
 * fixtures stay deterministic.
 */
export function renderEnvDict(env: Record<string, string>, indent = '    '): string {
  const entries = Object.entries(env);
  if (entries.length === 0) return '';
  return entries
    .map(
      ([k, v]) =>
        `${indent}<key>${xmlEscape(k)}</key><string>${xmlEscape(v)}</string>`,
    )
    .join('\n');
}

/**
 * Substitute `{{key}}` occurrences in `template` with the values from
 * `vars`. Throws if a placeholder has no corresponding key, and throws
 * again after substitution if any `{{key}}` pattern remains (the
 * belt-and-suspenders guard).
 *
 * Placeholder format is strict: `{{key}}` with no whitespace. A
 * `{{ key }}` spelling will not be matched and will surface through
 * the unresolved-placeholder check (but only if it also starts with a
 * word char — `{{ key }}` with a leading space slips past the scan; so
 * treat the strict form as the sole supported format).
 *
 * Scalar vars (`label`, `exec_path`, `log_dir`, `user`, `group`,
 * `working_dir`) are assumed pre-escaped — the caller is responsible
 * for running every user-controlled scalar through {@link xmlEscape}
 * before building the vars record. Multi-line section vars
 * (`args_array`, `env_dict`) are assumed pre-rendered XML already
 * produced by {@link renderArgsArray} / {@link renderEnvDict} (both of
 * which escape individual arg/env strings internally).
 */
export function renderPlist(
  template: string,
  vars: Record<string, string>,
): string {
  const out = template.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => {
    if (!(k in vars)) throw new Error(`plist template missing var: ${k}`);
    return vars[k]!;
  });
  if (/\{\{\w+\}\}/.test(out)) {
    throw new Error('plist template has unresolved placeholders');
  }
  return out;
}

/**
 * Shared scalar + pre-rendered vars required by both plist shapes.
 *
 * Expressed as a `type` (not an `interface`) so it is assignable to
 * `Record<string, string>` — interfaces are not assignable to string
 * index signatures under `--strict`, whereas type aliases are.
 */
export type PlistVarsCommon = {
  label: string;
  exec_path: string;
  /** Pre-rendered via {@link renderArgsArray}. */
  args_array: string;
  log_dir: string;
  /** Pre-rendered via {@link renderEnvDict}. */
  env_dict: string;
};

/** Vars expected by {@link LAUNCHD_USER_TEMPLATE}. */
export type PlistVarsUser = PlistVarsCommon;

/** Vars expected by {@link LAUNCHD_SYSTEM_TEMPLATE}. */
export type PlistVarsSystem = PlistVarsCommon & {
  user: string;
  group: string;
  working_dir: string;
};

/**
 * Structured input for {@link buildUserPlist} / {@link buildSystemPlist}.
 * The build functions own the single XML-escape point for scalars so
 * callers never have to remember which fields need escaping.
 */
export interface BuildPlistOptions {
  label: string;
  execPath: string;
  args: string[];
  logDir: string;
  env: Record<string, string>;
  /** Required for {@link buildSystemPlist}. */
  user?: string;
  /** Required for {@link buildSystemPlist}. */
  group?: string;
  /** Required for {@link buildSystemPlist}. */
  workingDir?: string;
}

/**
 * Build a rendered user-scope LaunchAgent plist from structured input.
 * Centralises XML escaping: every scalar field is passed through
 * {@link xmlEscape}, and the multi-line sections are built via
 * {@link renderArgsArray} / {@link renderEnvDict} (which escape
 * internally).
 */
export function buildUserPlist(opts: BuildPlistOptions): string {
  const vars: PlistVarsUser = {
    label: xmlEscape(opts.label),
    exec_path: xmlEscape(opts.execPath),
    args_array: renderArgsArray(opts.args),
    log_dir: xmlEscape(opts.logDir),
    env_dict: renderEnvDict(opts.env),
  };
  return renderPlist(LAUNCHD_USER_TEMPLATE, vars);
}

/**
 * Build a rendered system-scope LaunchDaemon plist from structured
 * input. Throws if the system-only fields (`user`, `group`,
 * `workingDir`) are missing.
 */
export function buildSystemPlist(opts: BuildPlistOptions): string {
  if (!opts.user || !opts.group || !opts.workingDir) {
    throw new Error('buildSystemPlist requires user, group, and workingDir');
  }
  const vars: PlistVarsSystem = {
    label: xmlEscape(opts.label),
    exec_path: xmlEscape(opts.execPath),
    args_array: renderArgsArray(opts.args),
    log_dir: xmlEscape(opts.logDir),
    env_dict: renderEnvDict(opts.env),
    user: xmlEscape(opts.user),
    group: xmlEscape(opts.group),
    working_dir: xmlEscape(opts.workingDir),
  };
  return renderPlist(LAUNCHD_SYSTEM_TEMPLATE, vars);
}
