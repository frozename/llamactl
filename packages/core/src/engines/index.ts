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
export { checkServingReadiness, formatHostForUrl } from "./lifecycle.js";
export {
  deriveOmlxResidency,
  matchHostedModel,
  OMLX_ACTIVITY_PATH,
  OMLX_MODELS_STATUS_PATH,
  OMLX_NATIVE_STATUS_REVISION,
  omlxModelActionPath,
  parseOmlxActivity,
  parseOmlxModelsStatus,
} from "./omlx.js";
export type {
  EngineAdapter,
  EngineBootEnv,
  EngineName,
  ModelHostHostedModel,
  ModelHostReadiness,
  ModelHostSpecForEngine,
  NativeModelActivity,
  NativeModelResidency,
  NativeModelStatusObservation,
} from "./types.js";
