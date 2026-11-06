import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, beforeEach, afterEach } from "bun:test";

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "../src/safe-fs.js";
import { findLocalMmproj, findLocalMmprojForRel } from "../src/mmproj.js";
import { defaultModeForRel, machineLabel } from "../src/bench/mode.js";
import { resolveEnv } from "../src/env.js";
import { BUILTIN_CATALOG } from "../src/catalog.js";

const CLEANUP_ROOTS: string[] = [];

function rootFor(name: string): string {
  let root = CLEANUP_ROOTS.find((r) => r.includes(name));
  if (!root) {
    root = mkdtempSync(join(tmpdir(), `llamactl-mmproj-${name}-`));
    CLEANUP_ROOTS.push(root);
  }
  return root;
}

afterEach((): void => {
  for (const dir of CLEANUP_ROOTS) {
    rmSync(dir, { recursive: true, force: true });
  }
  CLEANUP_ROOTS.length = 0;
});

/** Helper: create a model directory and write files into it. */
function writeModelDir(
  modelDir: string,
  files: Record<string, string>,
): void {
  mkdirSync(modelDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(modelDir, name), content);
  }
}

describe("findLocalMmproj", () => {
  test("(a) non-existent directory returns null", () => {
    const dir = join(rootFor("a"), "does-not-exist");
    expect(findLocalMmproj(dir)).toBeNull();
  });

  test("(b) empty directory returns null", () => {
    const dir = join(rootFor("b"), "empty");
    expect(findLocalMmproj(dir)).toBeNull();
  });

  test("(c) directory with only a model file returns null", () => {
    const dir = join(rootFor("c"), "models");
    writeModelDir(dir, { "model-Q4_K_M.gguf": "dummy" });
    expect(findLocalMmproj(dir)).toBeNull();
  });

  test("(d) mmproj-F16.gguf returns full joined path", () => {
    const dir = join(rootFor("d"), "models");
    writeModelDir(dir, { "mmproj-F16.gguf": "dummy" });
    const result = findLocalMmproj(dir);
    expect(result).toBe(join(dir, "mmproj-F16.gguf"));
  });

  test("(e) matching is case-insensitive", () => {
    const dir = join(rootFor("e"), "models");
    writeModelDir(dir, { "MMPROJ-F16.GGUF": "dummy" });
    const result = findLocalMmproj(dir);
    expect(result).toBe(join(dir, "MMPROJ-F16.GGUF"));
  });

  test("(f) mmproj can appear anywhere in the name", () => {
    const dir = join(rootFor("f"), "models");
    writeModelDir(dir, { "Model-mmproj-f16.gguf": "dummy" });
    const result = findLocalMmproj(dir);
    expect(result).toBe(join(dir, "Model-mmproj-f16.gguf"));
  });

  test("(g) non-.gguf projector files are ignored", () => {
    const dir = join(rootFor("g"), "models");
    writeModelDir(dir, {
      "mmproj-F16.bin": "dummy",
      "mmproj.gguf.part": "dummy",
    });
    expect(findLocalMmproj(dir)).toBeNull();
  });
});

describe("findLocalMmprojForRel", () => {
  test("(i) rel with no '/' returns null even when modelsRoot holds mmproj", () => {
    const modelsRoot = join(rootFor("i"), "models");
    writeModelDir(modelsRoot, { "mmproj-F16.gguf": "dummy" });
    expect(findLocalMmprojForRel(modelsRoot, "bare.gguf")).toBeNull();
  });

  test("(j) rel with one '/' finds sibling in subdirectory", () => {
    const modelsRoot = join(rootFor("j"), "models");
    const subDir = join(modelsRoot, "Acme-GGUF");
    writeModelDir(subDir, { "Acme-Q4_K_M.gguf": "dummy", "mmproj-F16.gguf": "dummy" });
    const result = findLocalMmprojForRel(modelsRoot, "Acme-GGUF/Acme-Q4_K_M.gguf");
    expect(result).toBe(join(modelsRoot, "Acme-GGUF", "mmproj-F16.gguf"));
  });

  test("(k) only the last '/' counts — nested dirs", () => {
    const modelsRoot = join(rootFor("k"), "models");
    const nestedDir = join(modelsRoot, "org", "Acme-GGUF");
    writeModelDir(nestedDir, { "x.gguf": "dummy", "mmproj-F16.gguf": "dummy" });
    const result = findLocalMmprojForRel(
      modelsRoot,
      "org/Acme-GGUF/x.gguf",
    );
    expect(result).toBe(join(modelsRoot, "org", "Acme-GGUF", "mmproj-F16.gguf"));
  });

  test("(l) returns null when derived directory does not exist", () => {
    const modelsRoot = join(rootFor("l"), "models");
    expect(
      findLocalMmprojForRel(modelsRoot, "org/Acme-GGUF/x.gguf"),
    ).toBeNull();
  });
});

describe("bench defaultModeForRel local mmproj sibling", () => {
  let tmp: string;
  let models: string;
  let resolved: ReturnType<typeof resolveEnv>;

  function buildEnv(): ReturnType<typeof resolveEnv> {
    tmp = mkdtempSync(join(tmpdir(), "llamactl-mmproj-bench-"));
    models = join(tmp, "models");
    return resolveEnv({
      DEV_STORAGE: tmp,
      LOCAL_AI_RUNTIME_DIR: join(tmp, "local-ai"),
      LLAMA_CPP_MODELS: models,
      LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
      LOCAL_AI_RECOMMENDATIONS_SOURCE: "off",
      LOCAL_AI_CUSTOM_CATALOG_FILE: join(tmp, "local-ai", "curated-models.tsv"),
      HOME: tmp,
      PATH: "",
    });
  }

  function writeFiles(
    rel: string,
    files: Record<string, string>,
  ): void {
    const modelDir = join(models, rel.slice(0, rel.lastIndexOf("/")));
    writeModelDir(modelDir, files);
  }

  const REL = "LlamactlPinTest-GGUF/LlamactlPinTest-Q4_K_M.gguf";

  test("(m) model + mmproj sibling -> vision", () => {
    resolved = buildEnv();
    writeFiles(REL, {
      "LlamactlPinTest-Q4_K_M.gguf": "dummy",
      "mmproj-F16.gguf": "dummy",
    });
    expect(defaultModeForRel(REL, resolved)).toBe("vision");
  });

  test("(n) model present, no mmproj -> text", () => {
    resolved = buildEnv();
    writeFiles(REL, { "LlamactlPinTest-Q4_K_M.gguf": "dummy" });
    expect(defaultModeForRel(REL, resolved)).toBe("text");
  });

  test("(o) mmproj sibling present, model absent -> text", () => {
    resolved = buildEnv();
    const dir = join(models, REL.slice(0, REL.lastIndexOf("/")));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "mmproj-F16.gguf"), "dummy");
    expect(defaultModeForRel(REL, resolved)).toBe("text");
  });

  test("(p) Qwen3.5-27B-GGUF locked to text even with mmproj sibling", () => {
    resolved = buildEnv();
    const qwenRel = "Qwen3.5-27B-GGUF/Qwen3.5-27B-UD-Q5_K_XL.gguf";
    writeFiles(qwenRel, {
      "Qwen3.5-27B-UD-Q5_K_XL.gguf": "dummy",
      "mmproj-F16.gguf": "dummy",
    });
    expect(defaultModeForRel(qwenRel, resolved)).toBe("text");
  });

  test("(q) local mmproj sibling overrides non-multimodal catalog class -> vision", () => {
    resolved = buildEnv();
    const general = BUILTIN_CATALOG.find(
      (e) => e.class !== "multimodal" && e.rel.includes("/") && !e.rel.startsWith("Qwen3.5-27B-GGUF/"),
    );
    if (!general) return;
    const modelName = general.rel.split("/").pop() ?? "model.gguf";
    const files: Record<string, string> = { [modelName]: "dummy", "mmproj-F16.gguf": "dummy" };
    writeFiles(general.rel, files);
    expect(defaultModeForRel(general.rel, resolved)).toBe("vision");
  });

  test("(q) same general rel, model only, no mmproj -> text", () => {
    resolved = buildEnv();
    const general = BUILTIN_CATALOG.find(
      (e) => e.class !== "multimodal" && e.rel.includes("/") && !e.rel.startsWith("Qwen3.5-27B-GGUF/"),
    );
    if (!general) return;
    const modelName = general.rel.split("/").pop() ?? "model.gguf";
    const files: Record<string, string> = { [modelName]: "dummy" };
    writeFiles(general.rel, files);
    expect(defaultModeForRel(general.rel, resolved)).toBe("text");
  });

  test("(r) machineLabel returns expected profile", () => {
    resolved = buildEnv();
    expect(machineLabel(resolved)).toBe("macbook-pro-48g");
  });
});
