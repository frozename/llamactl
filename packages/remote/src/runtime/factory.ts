/**
 * Runtime backend factory. Picks a `RuntimeBackend` impl based on a
 * declared runtime kind. Used by the router's `getCompositeRuntime`
 * so composites can target docker or kubernetes without editing the
 * router code for every swap.
 *
 * Construction is eager; tests / callers that want to mock inject
 * their own backend instead of calling this function.
 */
import type { RuntimeBackend } from './backend.js';
import { createDockerBackend, type DockerBackendOptions } from './docker/backend.js';
import {
  createKubernetesBackend,
  type KubernetesBackendOptions,
} from './kubernetes/backend.js';

export type RuntimeKind = 'docker' | 'kubernetes';

export interface RuntimeFactoryOptions {
  kind: RuntimeKind;
  docker?: DockerBackendOptions;
  kubernetes?: KubernetesBackendOptions;
}

export function createRuntimeBackend(
  opts: RuntimeFactoryOptions,
): RuntimeBackend {
  switch (opts.kind) {
    case 'docker':
      return createDockerBackend(opts.docker);
    case 'kubernetes':
      return createKubernetesBackend(opts.kubernetes);
    default: {
      const exhaustive: never = opts.kind;
      throw new Error(`unknown runtime kind: ${String(exhaustive)}`);
    }
  }
}
