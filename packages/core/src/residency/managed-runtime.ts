import { AsyncLocalStorage } from "node:async_hooks";
import { join, resolve } from "node:path";

import { lstatSync } from "../safe-fs.js";

const mutationScope = new AsyncLocalStorage<string>();

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
  return mutationScope.getStore() !== resolve(runtimeDir) && hasManagedRuntimeMarker(runtimeDir);
}

export function withManagedRuntimeMutation<T>(runtimeDir: string, run: () => T): T {
  return mutationScope.run(resolve(runtimeDir), run);
}
