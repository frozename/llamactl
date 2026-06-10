import type { EngineAdapter, EngineName } from "./types.js";
import { llamacppEngine } from "./llamacpp.js";
import { omlxEngine } from "./omlx.js";

export const ENGINES: Record<EngineName, EngineAdapter> = {
  llamacpp: llamacppEngine,
  omlx: omlxEngine,
};

export type {
  EngineAdapter,
  EngineBootEnv,
  EngineName,
  ModelHostSpecForEngine,
  ModelHostHostedModel,
} from "./types.js";
export { matchHostedModel } from "./omlx.js";
