import {
  type EmbersynthNode,
  loadEmbersynthConfig,
  saveEmbersynthConfig,
} from "../../config/embersynth.js";
import {
  loadSiriusProviders,
  saveSiriusProviders,
  type SiriusProvider,
} from "../../config/sirius-providers.js";

export type GatewayKind = "sirius" | "embersynth";

export function readGatewayCatalog(kind: "sirius"): SiriusProvider[];
export function readGatewayCatalog(kind: "embersynth"): EmbersynthNode[];
export function readGatewayCatalog(kind: GatewayKind): SiriusProvider[] | EmbersynthNode[] {
  if (kind === "sirius") return loadSiriusProviders();
  const cfg = loadEmbersynthConfig();
  return cfg ? cfg.nodes : [];
}

export function writeGatewayCatalog(kind: "sirius", entries: SiriusProvider[]): void;
export function writeGatewayCatalog(kind: "embersynth", entries: EmbersynthNode[]): void;
export function writeGatewayCatalog(
  kind: GatewayKind,
  entries: SiriusProvider[] | EmbersynthNode[],
): void {
  if (kind === "sirius") {
    saveSiriusProviders(entries as SiriusProvider[]);
    return;
  }
  // For embersynth, preserve any non-node fields the operator may
  // already have (profiles, syntheticModels, etc.).
  const cur = loadEmbersynthConfig() ?? {
    server: { host: "127.0.0.1", port: 7777 },
    nodes: [],
    profiles: [],
    syntheticModels: {},
  };
  saveEmbersynthConfig({
    ...cur,
    nodes: entries as EmbersynthNode[],
  });
}

/**
 * In-process async mutex keyed by gateway kind. The gateway catalog is a
 * single shared YAML file per kind (`sirius-providers.yaml`,
 * `embersynth.yaml`), and every mutation is a read-modify-write:
 * `readGatewayCatalog` → compute a `next` set → `writeGatewayCatalog`
 * with REPLACE semantics. Two in-process callers (a composite apply via
 * `resolveEmbersynthCatalog`, a composite teardown via
 * `cleanupGatewayCatalogs`) each derive their `next` from a snapshot
 * read; interleaved, the second writer's `next` — computed from a stale
 * read — clobbers the first writer's committed nodes, silently losing a
 * node permanently.
 *
 * `updateGatewayCatalog` closes that window: it serializes the read and
 * the write into ONE critical section, so each transform observes a
 * FRESH read and writes it back before the next caller reads. Mirrors
 * `withWorkloadsMutex` (workload/store.ts). Cross-PROCESS coordination is
 * out of scope (that needs a file lock); this guards the reported
 * in-process race only.
 */
const gatewayCatalogMutexQueues = new Map<GatewayKind, Promise<unknown>>();

function withGatewayCatalogMutex<T>(kind: GatewayKind, fn: () => T): Promise<T> {
  const tail = (gatewayCatalogMutexQueues.get(kind) ?? Promise.resolve()).catch(() => undefined);
  const run = tail.then(fn);
  gatewayCatalogMutexQueues.set(
    kind,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

export function updateGatewayCatalog(
  kind: "sirius",
  transform: (current: SiriusProvider[]) => SiriusProvider[],
): Promise<SiriusProvider[]>;
export function updateGatewayCatalog(
  kind: "embersynth",
  transform: (current: EmbersynthNode[]) => EmbersynthNode[],
): Promise<EmbersynthNode[]>;
/**
 * Atomic read-modify-write for one gateway catalog kind. Acquires the
 * per-kind async mutex, reads the catalog FRESH inside the lock, applies
 * the caller's `transform` with REPLACE semantics (the return value is
 * the FULL intended set), writes it back, releases, and returns the
 * written set. The fresh-read-inside-the-lock is the fix: no caller
 * computes its `next` from a snapshot another caller can invalidate
 * before the write. Callers MUST express removals as a reduced set
 * returned by the transform — never re-union the prior read, which would
 * resurrect deliberately-removed nodes.
 */
export function updateGatewayCatalog(
  kind: GatewayKind,
  transform: (current: SiriusProvider[] & EmbersynthNode[]) => SiriusProvider[] | EmbersynthNode[],
): Promise<SiriusProvider[] | EmbersynthNode[]> {
  return withGatewayCatalogMutex(kind, () => {
    if (kind === "sirius") {
      const current = readGatewayCatalog("sirius");
      const next = transform(current as SiriusProvider[] & EmbersynthNode[]) as SiriusProvider[];
      writeGatewayCatalog("sirius", next);
      return next;
    }
    const current = readGatewayCatalog("embersynth");
    const next = transform(current as SiriusProvider[] & EmbersynthNode[]) as EmbersynthNode[];
    writeGatewayCatalog("embersynth", next);
    return next;
  });
}
