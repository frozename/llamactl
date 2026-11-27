// #289: shared shape check for --central-bearer-ref / --tunnel-bearer-ref
// (agent serve and agent install-launchd). Only keychain refs are
// accepted: an env:/$ ref would put the token back in the process env and
// a file: ref would bypass the 0600 check the --*-bearer-file flags apply.
export const KEYCHAIN_REF_PREFIX = "keychain:";

/**
 * Why `ref` is not a usable `keychain:<service>/<account>` ref, or null.
 * "scheme" = not a keychain: ref; "shape" = a keychain: ref whose service
 * or account is missing or empty. The service is the text before the
 * first `/` and the account is everything after it, as the core secret
 * resolver splits it.
 */
export function keychainBearerRefProblem(ref: string): "scheme" | "shape" | null {
  const trimmed = ref.trim();
  if (!trimmed.startsWith(KEYCHAIN_REF_PREFIX)) return "scheme";
  const body = trimmed.slice(KEYCHAIN_REF_PREFIX.length);
  const slash = body.indexOf("/");
  if (slash < 0) return "shape";
  const service = body.slice(0, slash).trim();
  const account = body.slice(slash + 1).trim();
  if (service === "" || account === "") return "shape";
  return null;
}

/** Error text for a "shape" problem; never echoes the ref value. */
export function keychainRefShapeError(refLabel: string): string {
  return `${refLabel} must be keychain:<service>/<account> with a non-empty service and account`;
}
