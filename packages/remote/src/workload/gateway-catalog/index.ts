export { CompositeOwnershipSchema, ProviderConfigCommonSchema } from './schema.js';
export type {
  CompositeOwnership,
  ProviderConfigCommon,
  ApplyConflict,
} from './schema.js';
export { deriveSiriusEntries } from './sirius-entries.js';
export type { DerivedSiriusEntry } from './sirius-entries.js';
export { deriveEmbersynthEntries } from './embersynth-entries.js';
export type { DerivedEmbersynthEntry } from './embersynth-entries.js';
export { entrySpecHash } from './hash.js';
export { applyCompositeEntries } from './apply.js';
export type { ApplyOpts, ApplyResult } from './apply.js';
export { removeCompositeEntries } from './remove.js';
export type { RemoveOpts, RemoveResult } from './remove.js';
export { readGatewayCatalog, writeGatewayCatalog } from './io.js';
export type { GatewayKind } from './io.js';