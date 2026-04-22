import { Bonjour, type Service } from 'bonjour-service';

export const LLAMACTL_SERVICE_TYPE = 'llamactl-agent';

export interface PublishAgentOptions {
  port: number;
  nodeName: string;
  fingerprint: string | null;
  version: string;
  /** Override the mDNS service name. Defaults to the node name. */
  serviceName?: string;
}

export interface PublishedAgent {
  stop: () => Promise<void>;
}

/**
 * Advertise this agent on the LAN via mDNS / Bonjour. Other machines
 * on the same broadcast domain can discover it without needing to
 * paste a URL by hand — the TXT record carries the node name, TLS
 * fingerprint, and llamactl version so the control plane's UI can
 * short-list candidates before the user pastes a bootstrap blob.
 *
 * Tokens are NEVER broadcast — discovery is an unauthenticated LAN
 * protocol and leaking the bearer here would let anyone in range
 * impersonate the control plane. The fingerprint is already public
 * (it's the server's cert hash, observable to any TLS client).
 */
export function publishAgentMdns(opts: PublishAgentOptions): PublishedAgent {
  const bonjour = new Bonjour();
  const service = bonjour.publish({
    name: opts.serviceName ?? opts.nodeName,
    type: LLAMACTL_SERVICE_TYPE,
    port: opts.port,
    txt: {
      node: opts.nodeName,
      version: opts.version,
      ...(opts.fingerprint ? { fp: opts.fingerprint } : {}),
    },
  });
  // mDNS probe collisions ("Service name is already in use on the
  // network") fire as uncaught error events on the service object.
  // Without this listener, Bun's default uncaughtException kills the
  // agent under launchd (where stdio is redirected) — even though the
  // HTTP server is already listening on its TCP port. Treat the
  // collision as best-effort: log + carry on.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const eventEmitter = service as unknown as { on?: (evt: string, cb: (err: unknown) => void) => void };
  eventEmitter.on?.('error', (err) => {
    process.stderr.write(
      `mdns: ${err instanceof Error ? err.message : String(err)} (continuing without LAN advertisement)\n`,
    );
  });
  return {
    stop: async () => {
      await new Promise<void>((resolve) => {
        if (typeof service.stop === 'function') {
          service.stop(() => resolve());
        } else {
          resolve();
        }
      });
      bonjour.destroy();
    },
  };
}

export interface DiscoveredAgent {
  name: string;
  host: string;
  port: number;
  nodeName: string;
  version: string | null;
  fingerprint: string | null;
  addresses: string[];
}

/**
 * Listen briefly on mDNS for other llamactl agents and return what
 * responds within the timeout. Deduplicates by (host:port) — macOS
 * machines often advertise on multiple interfaces simultaneously.
 */
export async function discoverAgents(timeoutMs = 2500): Promise<DiscoveredAgent[]> {
  const bonjour = new Bonjour();
  const seen = new Map<string, DiscoveredAgent>();
  return new Promise<DiscoveredAgent[]>((resolve) => {
    const browser = bonjour.find({ type: LLAMACTL_SERVICE_TYPE }, (svc: Service) => {
      const host = svc.host ?? (svc.referer?.address ?? '');
      const port = svc.port ?? 0;
      const key = `${host}:${port}`;
      if (seen.has(key)) return;
      const txt = (svc.txt ?? {}) as Record<string, string | undefined>;
      seen.set(key, {
        name: svc.name ?? key,
        host,
        port,
        nodeName: txt.node ?? svc.name ?? key,
        version: txt.version ?? null,
        fingerprint: txt.fp ?? null,
        addresses: svc.addresses ?? [],
      });
    });
    setTimeout(() => {
      browser.stop();
      bonjour.destroy();
      resolve(Array.from(seen.values()));
    }, timeoutMs);
  });
}
