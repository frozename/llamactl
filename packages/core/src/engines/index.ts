import type { EngineAdapter, EngineName } from "./types.js";

import { kapitsaEngine } from "./kapitsa.js";
import { libosmosEngine } from "./libosmos.js";
import { llamacppEngine } from "./llamacpp.js";
import { omlxEngine } from "./omlx.js";
import { strataEngine } from "./strata.js";

export const ENGINES: Record<EngineName, EngineAdapter> = {
  kapitsa: kapitsaEngine,
  libosmos: libosmosEngine,
  llamacpp: llamacppEngine,
  omlx: omlxEngine,
  strata: strataEngine,
};

export { libosmosEngine } from "./libosmos.js";
export { matchHostedModel } from "./omlx.js";
export type {
  EngineAdapter,
  EngineBootEnv,
  EngineName,
  ModelHostHostedModel,
  ModelHostReadiness,
  ModelHostSpecForEngine,
} from "./types.js";
