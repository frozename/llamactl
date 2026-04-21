/**
 * Unified secret resolver. Every secret reference in llamactl —
 * `User.tokenRef`, `CloudBinding.apiKeyRef`, `RagBinding.auth.tokenRef`,
 * `RagBinding.auth.tokenEnv` — ultimately flows through here so adding
 * a new backend (macOS Keychain, HashiCorp Vault, k8s Secret) is a
 * single-file change rather than six parallel edits.
 *
 * Reference syntax (all supported at once; scheme-prefix wins over
 * shorthand):
 *   - `env:VAR_NAME` / `$VAR_NAME`      — read `env[VAR_NAME]`.
 *   - `keychain:service/account`         — read macOS Keychain via
 *                                          `security find-generic-password`.
 *                                          Gracefully fails (throws) on
 *                                          non-Darwin hosts.
 *   - `file:~/path`  / `file:/abs/path` — read file contents.
 *   - `~/path` / `/abs/path`             — legacy: read file contents.
 *
 * Every result is `.trim()`'d — trailing newlines from `security`
 * exports and text-editor "save" actions are common and harmless.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';

export type SecretBackend = 'env' | 'file' | 'keychain';

export interface SecretResolver {
  /**
   * Resolve a secret reference to its value. Throws with a clear,
   * redaction-safe message on failure (never echoes the value or a
   * would-be value).
   */
  resolve(ref: string): string;
  /** For diagnostics + tests — backend that would handle this ref. */
  backendFor(ref: string): SecretBackend;
}

export interface SecretResolverOptions {
  env?: NodeJS.ProcessEnv;
  /**
   * Override the OS platform we compare against when routing
   * `keychain:` refs. Tests set this to `'darwin'` on any host.
   */
  hostPlatform?: NodeJS.Platform;
  /**
   * Override the `security` CLI shell-out — tests inject a stub so
   * they don't need the real binary on the test host.
   */
  runSecurityCli?: (service: string, account: string) => string;
}

export function createSecretResolver(
  opts: SecretResolverOptions = {},
): SecretResolver {
  const env = opts.env ?? process.env;
  const hostPlatform = opts.hostPlatform ?? platform();
  const runSecurity = opts.runSecurityCli ?? defaultRunSecurityCli;

  return {
    backendFor(ref) {
      return classify(ref).backend;
    },
    resolve(ref) {
      const { backend, body } = classify(ref);
      switch (backend) {
        case 'env':
          return resolveEnv(body, env);
        case 'keychain':
          if (hostPlatform !== 'darwin') {
            throw new Error(
              `keychain secret ref '${ref}' requires macOS; host is '${hostPlatform}'`,
            );
          }
          return resolveKeychain(body, runSecurity);
        case 'file':
          return resolveFile(body, env);
      }
    },
  };
}

/** Convenience for callers that don't need dependency injection. */
export function resolveSecret(
  ref: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return createSecretResolver({ env }).resolve(ref);
}

// ---- internals -----------------------------------------------------------

function classify(ref: string): { backend: SecretBackend; body: string } {
  const trimmed = ref.trim();
  if (trimmed.length === 0) {
    throw new Error('empty secret reference');
  }
  if (trimmed.startsWith('env:')) {
    return { backend: 'env', body: trimmed.slice('env:'.length) };
  }
  if (trimmed.startsWith('$')) {
    return { backend: 'env', body: trimmed.slice(1) };
  }
  if (trimmed.startsWith('keychain:')) {
    return { backend: 'keychain', body: trimmed.slice('keychain:'.length) };
  }
  if (trimmed.startsWith('file:')) {
    return { backend: 'file', body: trimmed.slice('file:'.length) };
  }
  // Legacy: anything else is a filesystem path.
  return { backend: 'file', body: trimmed };
}

function resolveEnv(varName: string, env: NodeJS.ProcessEnv): string {
  if (!varName) throw new Error('env secret ref has empty variable name');
  const value = env[varName];
  if (value === undefined || value === '') {
    throw new Error(`env var '${varName}' is not set`);
  }
  return value.trim();
}

function resolveFile(path: string, env: NodeJS.ProcessEnv): string {
  if (!path) throw new Error('file secret ref has empty path');
  const resolved = path.replace(/^~(?=$|\/)/, env.HOME ?? homedir());
  if (!existsSync(resolved)) {
    throw new Error(`file secret ref '${path}' does not exist at ${resolved}`);
  }
  return readFileSync(resolved, 'utf8').trim();
}

/**
 * Resolve `service/account` via macOS Keychain. Shells out to the
 * system `security` CLI (`/usr/bin/security`) rather than linking a
 * native addon — the CLI is part of every macOS install and its
 * exit codes are stable. Service and account may contain almost any
 * characters (the CLI takes them as argv); we pass them unmodified.
 */
function resolveKeychain(
  body: string,
  runSecurity: (service: string, account: string) => string,
): string {
  if (!body) throw new Error('keychain secret ref has empty service/account');
  const slash = body.indexOf('/');
  if (slash < 0) {
    throw new Error(
      `keychain secret ref '${body}' missing '/account' — expected 'keychain:<service>/<account>'`,
    );
  }
  const service = body.slice(0, slash);
  const account = body.slice(slash + 1);
  if (!service || !account) {
    throw new Error(
      `keychain secret ref '${body}' has empty service or account segment`,
    );
  }
  try {
    return runSecurity(service, account).trim();
  } catch (err) {
    // Don't echo any CLI stderr body — it can contain hints that
    // reveal whether a service/account exists. Just name the miss.
    throw new Error(
      `keychain lookup failed for service='${service}' account='${account}' (${(err as Error).message ?? 'unknown'})`,
    );
  }
}

function defaultRunSecurityCli(service: string, account: string): string {
  // `-w` prints only the password; `-s` = service, `-a` = account.
  // execSync throws when the item isn't found (exit 44) — the caller
  // wraps that into the redacted "lookup failed" message above.
  const out = execSync(
    `/usr/bin/security find-generic-password -w -s ${shellEscape(service)} -a ${shellEscape(account)}`,
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return out.toString();
}

/**
 * Minimal single-quote shell escape for passing service/account
 * strings to `security`. We don't build shell commands elsewhere so
 * a local helper is cheaper than a dep.
 */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
