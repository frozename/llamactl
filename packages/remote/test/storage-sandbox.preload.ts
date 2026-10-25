import { afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdtempSync, rmSync } from "../src/safe-fs.js";
import { SANDBOX_PREFIX, sandboxOperatorStorage } from "./storage-sandbox.js";

// DEV_STORAGE is overridden even when one was given: a suite run against the
// operator's real storage root is exactly what this preload exists to
// prevent. A test that needs a specific location sets its own env or dir.
const root = mkdtempSync(join(tmpdir(), SANDBOX_PREFIX));
sandboxOperatorStorage(process.env, root);
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
