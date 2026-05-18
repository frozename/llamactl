import type { EngineAdapter, EngineName } from './types.js';

const placeholder = (name: EngineName): EngineAdapter => ({
  name,
  validateSpec: () => ({ ok: false, error: `engine ${name} not yet implemented` }),
  buildBootCommand: () => {
    throw new Error(`engine ${name} not yet implemented`);
  },
  probeReady: async () => ({ ready: false, modelIds: [] }),
  teardown: async () => {},
});

export const ENGINES: Record<EngineName, EngineAdapter> = {
  llamacpp: placeholder('llamacpp'),
  omlx: placeholder('omlx'),
};

export type { EngineAdapter, EngineName, ModelHostSpecForEngine, ModelHostHostedModel } from './types.js';
