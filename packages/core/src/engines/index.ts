import type { EngineAdapter, EngineName } from "./types.js";

import { llamacppEngine } from "./llamacpp.js";
import { omlxEngine } from "./omlx.js";

export const ENGINES: Record<EngineName, EngineAdapter> = {
  llamacpp: llamacppEngine,
  omlx: omlxEngine,
};

export { matchHostedModel } from "./omlx.js";
export type {
  EngineAdapter,
  EngineBootEnv,
  EngineName,
  ModelHostHostedModel,
  ModelHostSpecForEngine,
} from "./types.js";
