/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun's rejects/resolves matchers are typed as void. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadModels } from "../src/matrix/cli.js";
import * as types from "../src/matrix/types.js";
import { mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eval-load-models-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function commonFields(): Record<string, unknown> {
  return {
    name: "m1",
    quant: "Q4_K_M",
    family: "qwen",
    size_params: "8b",
    host: "127.0.0.1",
    port: 8080,
    extra_args: ["--ctx-size", "4096"],
  };
}

function baseSpec(): Record<string, unknown> {
  return { ...commonFields(), gguf_path: "/models/m1.gguf" };
}

function writeSpec(entries: unknown): string {
  const path = join(dir, "models.json");
  writeFileSync(path, JSON.stringify(entries));
  return path;
}

describe("loadModels happy path", () => {
  test("resolves entries and keeps optional fields", async () => {
    const entries = [
      baseSpec(),
      {
        ...baseSpec(),
        name: "m2",
        binary: "/opt/llama-server",
        start_args: ["--jinja"],
        managed: true,
        structured_outputs_supported: false,
      },
    ];
    const path = writeSpec(entries);
    const loaded: unknown = await loadModels(path);
    expect(loaded).toEqual(entries);
  });
});

describe("loadModels engine model path field", () => {
  test("omlx engine accepts mlx_model_dir without gguf_path", async () => {
    const entry = {
      ...commonFields(),
      engine: "omlx",
      mlx_model_dir: "/mlx/Qwen3-8B-4bit",
    };
    const path = writeSpec([entry]);
    const loaded: unknown = await loadModels(path);
    expect(loaded).toEqual([entry]);
  });

  test("omlx engine refuses an entry that only has gguf_path", async () => {
    const path = writeSpec([{ ...baseSpec(), engine: "omlx" }]);
    await expect(loadModels(path)).rejects.toThrow(
      "invalid ModelSpec: missing/bad field mlx_model_dir",
    );
  });

  test("default engine refuses a missing gguf_path even when mlx_model_dir is present", async () => {
    const path = writeSpec([{ ...commonFields(), mlx_model_dir: "/mlx/x" }]);
    await expect(loadModels(path)).rejects.toThrow(
      "invalid ModelSpec: missing/bad field gguf_path",
    );
  });
});

describe("loadModels required field types", () => {
  test("refuses a null entry with the name field message", async () => {
    const path = writeSpec([null]);
    await expect(loadModels(path)).rejects.toThrow("invalid ModelSpec: missing/bad field name");
  });

  test("refuses a string port with the port field message", async () => {
    const path = writeSpec([{ ...baseSpec(), port: "8080" }]);
    await expect(loadModels(path)).rejects.toThrow("invalid ModelSpec: missing/bad field port");
  });

  test("refuses a non-string extra_args element with the extra_args field message", async () => {
    const path = writeSpec([{ ...baseSpec(), extra_args: ["--a", 1] }]);
    await expect(loadModels(path)).rejects.toThrow(
      "invalid ModelSpec: missing/bad field extra_args",
    );
  });

  test("checks required fields before optional fields", async () => {
    const path = writeSpec([{ ...baseSpec(), port: "x", binary: 42 }]);
    await expect(loadModels(path)).rejects.toThrow(
      new Error("invalid ModelSpec: missing/bad field port"),
    );
  });
});

describe("loadModels optional field types", () => {
  test("refuses a non-string binary with the binary field message", async () => {
    const path = writeSpec([{ ...baseSpec(), binary: 42 }]);
    await expect(loadModels(path)).rejects.toThrow("invalid ModelSpec: missing/bad field binary");
  });

  test("refuses a non-array start_args with the start_args field message", async () => {
    const path = writeSpec([{ ...baseSpec(), start_args: "--jinja" }]);
    await expect(loadModels(path)).rejects.toThrow(
      "invalid ModelSpec: missing/bad field start_args",
    );
  });

  test("refuses a non-boolean managed with the managed field message", async () => {
    const path = writeSpec([{ ...baseSpec(), managed: "yes" }]);
    await expect(loadModels(path)).rejects.toThrow("invalid ModelSpec: missing/bad field managed");
  });

  test("refuses a non-boolean structured_outputs_supported with its field message", async () => {
    const path = writeSpec([{ ...baseSpec(), structured_outputs_supported: 1 }]);
    await expect(loadModels(path)).rejects.toThrow(
      "invalid ModelSpec: missing/bad field structured_outputs_supported",
    );
  });
});

describe("loadModels quarantine and empty list", () => {
  test("refuses a whitespace-only quarantine reason", async () => {
    const path = writeSpec([{ ...baseSpec(), quarantined: { reason: "   " } }]);
    await expect(loadModels(path)).rejects.toThrow(
      "invalid ModelSpec: quarantined must be { reason: <non-empty string> } when present",
    );
  });

  test("refuses an empty models list", async () => {
    const path = writeSpec([]);
    await expect(loadModels(path)).rejects.toThrow(
      `--models points to an empty list (${path}); nothing to bench`,
    );
  });
});

describe("loadModels eval engines", () => {
  test("EVAL_ENGINES lists llamacpp, omlx, gufo and kapitsa", () => {
    expect(types.EVAL_ENGINES).toEqual(["llamacpp", "omlx", "gufo", "kapitsa"]);
  });

  test("refuses an unknown engine", async () => {
    expect(types.EVAL_ENGINES).toEqual(["llamacpp", "omlx", "gufo", "kapitsa"]);
    const path = writeSpec([{ ...baseSpec(), engine: "vllm" }]);
    await expect(loadModels(path)).rejects.toThrow("invalid ModelSpec: unknown engine vllm");
  });

  test("refuses a managed gufo engine", async () => {
    expect(types.EVAL_ENGINES).toEqual(["llamacpp", "omlx", "gufo", "kapitsa"]);
    const path = writeSpec([{ ...baseSpec(), engine: "gufo", managed: true }]);
    await expect(loadModels(path)).rejects.toThrow(/engine gufo is not managed by eval/);
  });

  test("refuses a managed kapitsa engine", async () => {
    expect(types.EVAL_ENGINES).toEqual(["llamacpp", "omlx", "gufo", "kapitsa"]);
    const path = writeSpec([{ ...baseSpec(), engine: "kapitsa", managed: true }]);
    await expect(loadModels(path)).rejects.toThrow(/engine kapitsa is not managed by eval/);
  });

  test("gufo engine with gguf_path and managed false loads and round-trips", async () => {
    const entry = { ...baseSpec(), engine: "gufo", managed: false };
    const path = writeSpec([entry]);
    const loaded: unknown = await loadModels(path);
    expect(loaded).toEqual([entry]);
  });

  test("kapitsa engine with gguf_path loads and round-trips", async () => {
    const entry = { ...baseSpec(), engine: "kapitsa" };
    const path = writeSpec([entry]);
    const loaded: unknown = await loadModels(path);
    expect(loaded).toEqual([entry]);
  });
});
