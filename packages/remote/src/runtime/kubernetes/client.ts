/**
 * Thin wrapper around `@kubernetes/client-node`'s KubeConfig +
 * typed API clients. Every k8s-backend entrypoint flows through
 * here so the resolved context + namespace + makeApiClient calls
 * are centralised and mockable.
 *
 * The real KubeConfig.loadFromDefault() reads `~/.kube/config` + a
 * small cascade of other sources (KUBECONFIG env, in-cluster service
 * account, etc.). Tests inject `loadConfig` to bypass filesystem
 * altogether.
 */
import {
  AppsV1Api,
  CoreV1Api,
  KubeConfig,
} from '@kubernetes/client-node';

export interface KubernetesClientOptions {
  /** Override the kubeconfig path. When unset, uses KubeConfig.loadFromDefault(). */
  kubeconfigPath?: string;
  /** Override which context to use. When unset, uses current-context. */
  context?: string;
  /**
   * Inject a pre-built KubeConfig — tests pass a stub so the real
   * loader never touches the filesystem or the default
   * `~/.kube/config` of whoever is running the suite.
   */
  kubeConfig?: KubeConfig;
}

export interface KubernetesClient {
  readonly core: CoreV1Api;
  readonly apps: AppsV1Api;
  readonly currentContext: string;
  readonly currentNamespace: string;
  /** Underlying KubeConfig — retained for future apis (StorageV1, NetworkingV1). */
  readonly kc: KubeConfig;
}

export function createKubernetesClient(
  opts: KubernetesClientOptions = {},
): KubernetesClient {
  const kc = opts.kubeConfig ?? loadKubeConfig(opts);

  if (opts.context !== undefined) {
    kc.setCurrentContext(opts.context);
  }

  const currentContext = kc.getCurrentContext();
  const namespace = resolveNamespace(kc, currentContext);

  return {
    core: kc.makeApiClient(CoreV1Api),
    apps: kc.makeApiClient(AppsV1Api),
    currentContext,
    currentNamespace: namespace,
    kc,
  };
}

function loadKubeConfig(opts: KubernetesClientOptions): KubeConfig {
  const kc = new KubeConfig();
  if (opts.kubeconfigPath) {
    kc.loadFromFile(opts.kubeconfigPath);
  } else {
    kc.loadFromDefault();
  }
  return kc;
}

function resolveNamespace(kc: KubeConfig, contextName: string): string {
  const ctx = kc.getContextObject(contextName);
  return ctx?.namespace ?? 'default';
}
