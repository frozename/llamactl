import { AsyncLocalStorage } from "node:async_hooks";
import { join, resolve } from "node:path";

import { lstatSync } from "../safe-fs.js";

const mutationScope = new AsyncLocalStorage<{ runtimeDir: string; active: () => boolean }>();

export function managedRuntimeMarker(runtimeDir: string): string {
  return join(runtimeDir, "managed-residency-v1");
}

export function hasManagedRuntimeMarker(runtimeDir: string): boolean {
  try {
    lstatSync(managedRuntimeMarker(runtimeDir));
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

export function managedRuntimeRefusesMutation(runtimeDir: string): boolean {
  const scope = mutationScope.getStore();
  return scope?.runtimeDir === resolve(runtimeDir)
    ? !scope.active()
    : hasManagedRuntimeMarker(runtimeDir);
}

export function withManagedRuntimeMutation<T>(
  runtimeDir: string,
  active: () => boolean,
  run: () => T,
): T {
  return mutationScope.run({ runtimeDir: resolve(runtimeDir), active }, run);
}
