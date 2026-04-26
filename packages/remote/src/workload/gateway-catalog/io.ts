import {
  loadSiriusProviders,
  saveSiriusProviders,
  type SiriusProvider,
} from '../../config/sirius-providers.js';
import {
  loadEmbersynthConfig,
  saveEmbersynthConfig,
  type EmbersynthNode,
} from '../../config/embersynth.js';

export type GatewayKind = 'sirius' | 'embersynth';

export function readGatewayCatalog(kind: 'sirius'): SiriusProvider[];
export function readGatewayCatalog(kind: 'embersynth'): EmbersynthNode[];
export function readGatewayCatalog(kind: GatewayKind): SiriusProvider[] | EmbersynthNode[] {
  if (kind === 'sirius') return loadSiriusProviders();
  const cfg = loadEmbersynthConfig();
  return cfg ? cfg.nodes : [];
}

export function writeGatewayCatalog(kind: 'sirius', entries: SiriusProvider[]): void;
export function writeGatewayCatalog(kind: 'embersynth', entries: EmbersynthNode[]): void;
export function writeGatewayCatalog(
  kind: GatewayKind,
  entries: SiriusProvider[] | EmbersynthNode[],
): void {
  if (kind === 'sirius') {
    saveSiriusProviders(entries as SiriusProvider[]);
    return;
  }
  // For embersynth, preserve any non-node fields the operator may
  // already have (profiles, syntheticModels, etc.).
  const cur = loadEmbersynthConfig() ?? {
    server: { host: '127.0.0.1', port: 7777 },
    nodes: [],
    profiles: [],
    syntheticModels: {},
  };
  saveEmbersynthConfig({
    ...cur,
    nodes: entries as EmbersynthNode[],
  });
}