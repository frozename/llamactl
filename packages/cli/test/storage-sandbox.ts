// Copy of packages/remote/test/storage-sandbox.ts (cross-package relative
// imports are forbidden); keep the two copies in step.
import { join } from "node:path";

export const SANDBOX_PREFIX = "llamactl-test-storage-";

/**
 * Reroots operator state (kubeconfig, workloads, composites, journals) into
 * `root` and strips the env overrides that would point it back at the
 * operator's live directories. Without this, tests that exercise the router's
 * save paths write real manifests into $DEV_STORAGE and the live controller
 * then reconciles them.
 *
 * The composites dir is pinned through LLAMACTL_COMPOSITES_DIR, not
 * LLAMACTL_HOME. Without the override the cli falls back to LLAMACTL_HOME or
 * ~/.llamactl, and the remote router reads LLAMACTL_HOME as the llamactl repo
 * checkout for the keep-alive spawn, so LLAMACTL_HOME is left alone.
 */
export function sandboxOperatorStorage(env: NodeJS.ProcessEnv, root: string): void {
  env["DEV_STORAGE"] = root;
  env["LLAMACTL_COMPOSITES_DIR"] = join(root, "composites");
  Reflect.deleteProperty(env, "LLAMACTL_CONFIG");
  Reflect.deleteProperty(env, "LLAMACTL_WORKLOADS_DIR");
}
