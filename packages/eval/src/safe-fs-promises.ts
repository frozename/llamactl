// Audited filesystem boundary (promises API) for this package. See ./safe-fs.ts.
import * as nodeFsPromises from "node:fs/promises";

// `export * from "node:fs/promises"` is mistransformed by `bun build --compile` (it
// emits an unbound `__reExport(exports, promises)` and the agent binary crashes at
// startup with "ReferenceError: promises is not defined"). Importing the namespace into
// a local binding and re-exporting it explicitly is compile-safe and preserves the
// public surface for interpreted runs too. See ./safe-fs.ts for the sync-API twin.
export default nodeFsPromises;

export const { access, appendFile, mkdir, readdir, readFile, rm, stat, writeFile } = nodeFsPromises;
