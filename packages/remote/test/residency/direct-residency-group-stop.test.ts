/**
 * #517 — regression for the callers of `directResidencyGroup` that pass no
 * `start` option (modelHostStop, the idle-evict stop and the operator
 * force-unload stop): they keep the label-only group, so an unlabelled
 * ModelHost whose hosted rel is catalogued still resolves no group there,
 * while a start resolves the catalog group.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { directResidencyGroup } from "../../src/router.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";
import { parseModelHost, saveModelHost } from "../../src/workload/modelhost-store.js";

const GROUP = "z13-large-gpu";
const GROUP_LABEL = "llamactl.io/residency-group";
const GLM_REL = "GLM-5.3-Flash-AJ-GGUF/AJ-IQ2_XXS/GLM-5.3-Flash-AJ-IQ2_XXS-00001-of-00002.gguf";

const originalEnv = { ...process.env };
let root = "";
let workloadsDir = "";

function writeHost(name: string, rel: string, group?: string): void {
  const labels = group === undefined ? "" : `  labels:\n    ${GROUP_LABEL}: ${group}\n`;
  const yaml = `
apiVersion: llamactl/v1
kind: ModelHost
metadata:
  name: ${name}
${labels}spec:
  engine: omlx
  node: local
  enabled: true
  binary: ${join(root, "fake-omlx")}
  endpoint:
    host: 127.0.0.1
    port: 18190
  hostedModels:
    - rel: ${rel}
`;
  saveModelHost(parseModelHost(yaml), workloadsDir);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "llamactl-residency-group-stop-"));
  workloadsDir = join(root, "workloads");
  Object.assign(process.env, {
    DEV_STORAGE: join(root, "dev"),
    LLAMACTL_RESIDENCY_STORE: join(root, "residency", "operations.sqlite"),
    LLAMACTL_WORKLOADS_DIR: workloadsDir,
    LOCAL_AI_RUNTIME_DIR: join(root, "runtime"),
    LLAMA_CPP_MODELS: join(root, "models"),
    LLAMACTL_CONFIG: join(root, "no-such-kubeconfig.yaml"),
  });
});

afterEach(() => {
  for (const key of Object.keys(process.env)) Reflect.deleteProperty(process.env, key);
  Object.assign(process.env, originalEnv);
  if (root !== "") {
    rmSync(root, { recursive: true, force: true });
    root = "";
  }
});

describe("directResidencyGroup without a start option", () => {
  // Kills: the catalog fallback leaking into stop-side group resolution.
  test("an unlabelled stored host with a catalogued rel resolves no group", () => {
    writeHost("glm-host", GLM_REL);
    expect(directResidencyGroup("glm-host", undefined)).toBeUndefined();
    expect(directResidencyGroup("glm-host", undefined, { inlineRel: undefined })).toBe(GROUP);
  });

  // Kills: the stop-side label lookup changing order or being dropped.
  test("labels resolve as before: inline label, then stored label, then none", () => {
    writeHost("labelled-host", "other/missing.gguf", "m4-other");
    expect(directResidencyGroup("labelled-host", undefined)).toBe("m4-other");
    expect(directResidencyGroup("labelled-host", { [GROUP_LABEL]: "inline-group" })).toBe(
      "inline-group",
    );
    expect(directResidencyGroup("no-such-host", undefined)).toBeUndefined();
    expect(directResidencyGroup("no-such-host", { [GROUP_LABEL]: GROUP })).toBe(GROUP);
  });

  // Kills: a start-side lookup of an uncatalogued rel inventing a group.
  test("a start with an uncatalogued rel and no label resolves no group", () => {
    writeHost("other-host", "other/missing.gguf");
    expect(directResidencyGroup("other-host", undefined, { inlineRel: undefined })).toBeUndefined();
    expect(directResidencyGroup("no-such-host", undefined, { inlineRel: GLM_REL })).toBe(GROUP);
  });
});
