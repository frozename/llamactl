import type { EngineAdapter, EngineName } from "./types.js";

import { llamacppEngine } from "./llamacpp.js";
import { omlxEngine } from "./omlx.js";
import { strataEngine } from "./strata.js";

export const ENGINES: Record<EngineName, EngineAdapter> = {
  llamacpp: llamacppEngine,
  omlx: omlxEngine,
  strata: strataEngine,
};

export { matchHostedModel } from "./omlx.js";
export type {
  EngineAdapter,
  EngineBootEnv,
  EngineName,
  ModelHostHostedModel,
  ModelHostReadiness,
  ModelHostSpecForEngine,
} from "./types.js";
