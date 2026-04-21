/**
 * Labels llamactl stamps on every k8s resource it manages. Mirrors
 * the docker-backend label convention but uses k8s-native keys
 * (`app.kubernetes.io/*`) alongside our own `llamactl.io/*` so
 * `kubectl`, k9s, and dashboards group them sensibly.
 *
 * The Helm common-labels convention is the precedent:
 * https://kubernetes.io/docs/concepts/overview/working-with-objects/common-labels/
 *
 * `managedBy` + `composite` are the load-bearing filters:
 *   - List/destroy operations scope by both so we never touch an
 *     operator-authored resource that happens to share a namespace.
 *   - Namespace-per-composite is the GC boundary — deleting the
 *     namespace cascades through Deployments/StatefulSets/PVCs/
 *     Secrets/Services authored for that composite.
 *
 * `specHash` on the `llamactl.io/spec-hash` annotation drives drift
 * detection, same semantics as the docker backend's
 * `llamactl.spec.hash` label. Annotations, not labels, because hash
 * values can exceed the 63-char label value limit in edge cases.
 */
export const K8S_LABEL_KEYS = {
  managedBy: 'app.kubernetes.io/managed-by',
  instance: 'app.kubernetes.io/instance',
  partOf: 'app.kubernetes.io/part-of',
  // llamactl-namespaced — our drift detection + scoping
  composite: 'llamactl.io/composite',
  component: 'llamactl.io/component',
  node: 'llamactl.io/node',
} as const;

export const K8S_ANNOTATION_KEYS = {
  specHash: 'llamactl.io/spec-hash',
} as const;

export const MANAGED_BY_VALUE = 'llamactl';
