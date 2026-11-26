import { catalog } from "@llamactl/core";
import { defaultResidencyStorePath, exclusiveGroupLaunchRefusal } from "@llamactl/remote";
import { isAbsolute, relative, resolve } from "node:path";

import type { ModelSpec } from "./types.js";

/**
 * #517: the matrix runner records no `residency_states` row, so a managed boot
 * reads the local residency store read-only before it spawns. The residency
 * group comes from the catalog row of the model's `gguf_path` under
 * `LLAMA_CPP_MODELS`, falling back to the row whose `rel` is the model name —
 * the same resolution `llamactl eval perf --launch` uses.
 */
export function matrixLaunchRefusal(model: ModelSpec): string | null {
  const modelsDir = process.env["LLAMA_CPP_MODELS"];
  let matchedRel: string | null = null;
  let row: ReturnType<typeof catalog.findByRel> = null;

  if (modelsDir !== undefined) {
    const rel = relative(resolve(modelsDir), resolve(model.gguf_path));
    if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) {
      const found = catalog.findByRel(rel);
      if (found !== null) {
        matchedRel = rel;
        row = found;
      }
    }
  }
  row ??= catalog.findByRel(model.name);

  return exclusiveGroupLaunchRefusal({
    id: matchedRel ?? model.name,
    group: row?.residencyGroup,
    storePath: defaultResidencyStorePath(),
  });
}
