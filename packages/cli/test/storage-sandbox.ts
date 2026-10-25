// Copy of packages/remote/test/storage-sandbox.ts (cross-package relative
// imports are forbidden); keep the two copies in step.
export const SANDBOX_PREFIX = "llamactl-test-storage-";

/**
 * Reroots operator state (kubeconfig, workloads, journals) into `root` and
 * strips the env overrides that would point it back at the operator's live
 * directories. Without this, tests that exercise the router's save paths
 * write real manifests into $DEV_STORAGE and the live controller then
 * reconciles them.
 */
export function sandboxOperatorStorage(env: NodeJS.ProcessEnv, root: string): void {
  env["DEV_STORAGE"] = root;
  Reflect.deleteProperty(env, "LLAMACTL_CONFIG");
  Reflect.deleteProperty(env, "LLAMACTL_WORKLOADS_DIR");
}
