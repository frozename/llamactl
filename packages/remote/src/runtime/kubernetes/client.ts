import {
  AppsV1Api,
  type ApiConstructor,
  type ApiType,
  CoreV1Api,
  KubeConfig,
} from "@kubernetes/client-node";
import { createConfiguration } from "@kubernetes/client-node/dist/gen/configuration.js";
import { ResponseContext } from "@kubernetes/client-node/dist/gen/http/http.js";
import { Observable } from "@kubernetes/client-node/dist/gen/rxjsStub.js";
import { ServerConfiguration } from "@kubernetes/client-node/dist/gen/servers.js";
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
 *
 * Bun compatibility: under Bun, `@kubernetes/client-node`'s default
 * HTTP library (`IsomorphicFetchHttpLibrary`) imports `node-fetch`
 * and passes a Node-style `https.Agent` as `opts.agent`. Bun's
 * node-fetch compat silently drops the agent, so client-cert auth +
 * `skipTLSVerify` get lost and the TLS handshake fails with
 * `unable to verify the first certificate` against self-signed
 * clusters (Docker Desktop, k3s, kind). We substitute a
 * `BunFetchHttpLibrary` that extracts the agent's options and
 * re-passes them as Bun's native `tls:` init field. Under Node the
 * shim is bypassed — the library's default path works there.
 */
import { readFileSync } from "node:fs";

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

export function createKubernetesClient(opts: KubernetesClientOptions = {}): KubernetesClient {
  // A caller-supplied KubeConfig is the test-injection path. Those
  // tests override `kc.makeApiClient` to return fakes, so we must
  // honor the library's path and not reach for our Bun shim.
  const injectedKc = opts.kubeConfig !== undefined;
  const kc = opts.kubeConfig ?? loadKubeConfig(opts);

  if (opts.context !== undefined) {
    kc.setCurrentContext(opts.context);
  }

  const currentContext = kc.getCurrentContext();
  const namespace = resolveNamespace(kc, currentContext);

  return {
    core: makeApiClient(kc, CoreV1Api, injectedKc),
    apps: makeApiClient(kc, AppsV1Api, injectedKc),
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
  return ctx?.namespace ?? "default";
}

/**
 * Construct an API client. On Bun, wires a Bun-aware http library
 * so fetch honors the kubeconfig's TLS material. On Node, delegates
 * to the library's default `makeApiClient`.
 */
function makeApiClient<ClientType extends ApiType>(
  kc: KubeConfig,
  ClientCtor: ApiConstructor<ClientType>,
  injectedKc: boolean,
): ClientType {
  if (injectedKc) {
    // Tests rely on their stub kc.makeApiClient to return fakes.
    return kc.makeApiClient(ClientCtor);
  }
  if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") {
    return kc.makeApiClient(ClientCtor);
  }
  return makeApiClientForBun(kc, ClientCtor);
}

// ------------------------------------------------------------------
// Bun support
// ------------------------------------------------------------------

function makeApiClientForBun<ClientType extends ApiType>(
  kc: KubeConfig,
  ClientCtor: ApiConstructor<ClientType>,
): ClientType {
  const cluster = kc.getCurrentCluster();
  if (!cluster) {
    throw new Error("No active cluster!");
  }
  const config = createConfiguration({
    baseServer: new ServerConfiguration(cluster.server, {}),
    authMethods: { default: kc },
    httpApi: new BunFetchHttpLibrary(),
  });
  return new ClientCtor(config);
}

/**
 * Minimal HTTP library compatible with `@kubernetes/client-node`'s
 * `httpApi` contract. Reads TLS material off the Node `https.Agent`
 * the library's auth middleware attached to the request context and
 * re-passes it to Bun's `fetch` via the `tls:` init field.
 *
 * Response shape mirrors `ResponseContext` (status + headers +
 * `{ text(), binary() }` body). Returns an RxJS Observable via the
 * library's `from` helper so downstream middleware plumbing stays
 * intact.
 */
class BunFetchHttpLibrary {
  async sendAsync(request: KubeRequestContext): Promise<ResponseContext> {
    const url = request.getUrl();
    const method = request.getHttpMethod().toString();
    const body = request.getBody() as string | Uint8Array | null | undefined;
    const headers = request.getHeaders();
    const signal = request.getSignal();
    const agent = request.getAgent() as { options?: Record<string, unknown> } | undefined;
    const tls = agentToTls(agent);

    const init: Record<string, unknown> = {
      method,
      headers,
    };
    if (body !== undefined && body !== null) init.body = body;
    if (signal !== undefined) init.signal = signal;
    if (tls !== undefined) init.tls = tls;

    const resp = await fetch(url, init);
    const headerMap: Record<string, string> = {};
    for (const [name, value] of resp.headers.entries()) {
      headerMap[name] = value;
    }
    const respBody = {
      text: (): Promise<string> => resp.text(),
      binary: async (): Promise<Buffer<ArrayBuffer>> => Buffer.from(await resp.arrayBuffer()),
    };
    return new ResponseContext(resp.status, headerMap, respBody);
  }

  send(request: KubeRequestContext): Observable<ResponseContext> {
    // The library's default http library returns an RxJS Observable
    // (a `rxjsStub.Observable`, which is just a promise wrapper with
    // a `pipe` + `toPromise`). `from()` isn't re-exported from the
    // library root, so we construct the Observable directly using
    // the exported class.
    return new Observable<ResponseContext>(this.sendAsync(request));
  }
}

function agentToTls(
  agent: { options?: Record<string, unknown> } | undefined,
): Record<string, unknown> | undefined {
  if (!agent?.options) return undefined;
  const o = agent.options;
  const tls: Record<string, unknown> = {};
  if (o.rejectUnauthorized !== undefined) tls.rejectUnauthorized = o.rejectUnauthorized;
  if (o.ca !== undefined) tls.ca = o.ca;
  if (o.cert !== undefined) tls.cert = o.cert;
  if (o.key !== undefined) tls.key = o.key;
  if (o.passphrase !== undefined) tls.passphrase = o.passphrase;
  if (o.servername !== undefined) tls.servername = o.servername;
  if (Object.keys(tls).length === 0) return undefined;
  return tls;
}

// The `RequestContext` / `ResponseContext` / `from` symbols live on
// generated paths that aren't in the library's root typings, so we
// describe just the shape we touch.
interface KubeRequestContext {
  getUrl(): string;
  getHttpMethod(): { toString(): string };
  getBody(): unknown;
  getHeaders(): Record<string, string>;
  getSignal(): AbortSignal | undefined;
  getAgent(): unknown;
}
// Silence no-unused warnings when the file-scope imports aren't
// exercised under Node (readFileSync is reserved for future PEM-file
// loading fallbacks in the shim — currently the agent carries the
// already-decoded material in its options).
void readFileSync;
