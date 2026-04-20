/**
 * Label keys llamactl puts on every container it manages. Mirrors
 * the Docker Compose convention (`com.docker.compose.*`) so tools
 * that understand that pattern (Portainer, lazydocker, `docker ps`
 * filters) group our containers sensibly.
 *
 * `managedBy` is the load-bearing one — every filter/list call uses
 * it to scope to llamactl-managed containers and stay out of
 * containers the operator runs themselves.
 *
 * `specHash` is the idempotency key: the applier compares the hash
 * on the running container to the desired hash and decides whether
 * to leave-alone, restart, or recreate.
 */
export const LABEL_KEYS = {
  managedBy: 'llamactl.managed-by',
  composite: 'llamactl.composite',
  service: 'llamactl.service',
  specHash: 'llamactl.spec.hash',
} as const;

export const MANAGED_BY_VALUE = 'llamactl';
