import type { ManagedMemoryCalibrationKey } from "@llamactl/core/resources/memory";

import { server } from "@llamactl/core";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
} from "../safe-fs.js";

export interface CalibratableLaunch {
  engine: "llamacpp" | "kapitsa";
  binary: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
}

const LLAMA_FILES = new Set([
  "-m",
  "--model",
  "-md",
  "--model-draft",
  "--spec-draft-model",
  "--dspark",
  "--mtp-head",
  "--lora",
]);

// The allowlist separates flags with known local dependencies from open-ended
// flags such as model URLs, server presets and offload helpers.
const LLAMA_VALUES = new Set([
  "-a",
  "--alias",
  "--host",
  "--port",
  "-c",
  "--ctx-size",
  "-b",
  "--batch-size",
  "-ub",
  "--ubatch-size",
  "-np",
  "--parallel",
  "-ngl",
  "--gpu-layers",
  "--n-gpu-layers",
  "-ctk",
  "--cache-type-k",
  "-ctv",
  "--cache-type-v",
  "-fa",
  "--flash-attn",
  "-t",
  "--threads",
  "-tb",
  "--threads-batch",
  "-ngld",
  "--gpu-layers-draft",
  "--spec-type",
  "--draft-max",
  "--draft-min",
  "--draft-p-min",
  "--draft-p-split",
  "--slot-save-path",
  "--n-predict",
  "-n",
  "--temp",
  "--top-p",
  "--top-k",
  "--min-p",
  "--reasoning-format",
  "--reasoning-budget",
  "--fit",
  "--fit-target",
]);
const LLAMA_SWITCHES = new Set([
  "--metrics",
  "--slots",
  "--jinja",
  "--cont-batching",
  "--no-cont-batching",
  "--no-mmap",
  "--mmap",
  "--mlock",
  "--no-warmup",
  "--swa-full",
  "--no-kv-offload",
]);
const KAPITSA_FILES = new Set(["--model", "--dflash"]);
const KAPITSA_VALUES = new Set([
  "--model-id",
  "--host",
  "--port",
  "--mem-budget",
  "--context",
  "--slots",
  "--prefill-chunk",
]);
const KAPITSA_SWITCHES = new Set(["--local", "--private"]);
const MAX_ENTRIES = 4096;
const MAX_DEPTH = 16;

function unsafeEnvironment(env: NodeJS.ProcessEnv): boolean {
  return Object.keys(env).some((key) => /^(?:LLAMA_ARG_|LD_|DYLD_|GGML_BACKEND_PATH$)/.test(key));
}

interface ArgumentGrammar {
  files: ReadonlySet<string>;
  values: ReadonlySet<string>;
  switches: ReadonlySet<string>;
}

const ARGUMENTS = {
  llamacpp: { files: LLAMA_FILES, values: LLAMA_VALUES, switches: LLAMA_SWITCHES },
  kapitsa: { files: KAPITSA_FILES, values: KAPITSA_VALUES, switches: KAPITSA_SWITCHES },
} satisfies Record<CalibratableLaunch["engine"], ArgumentGrammar>;

function parseArgument(
  args: readonly string[],
  index: number,
  grammar: ArgumentGrammar,
): { next: number; file?: string } | undefined {
  const token = args[index] ?? "";
  const split = token.indexOf("=");
  const flag = split < 0 ? token : token.slice(0, split);
  if (grammar.switches.has(flag) && split < 0) return { next: index + 1 };
  const file = grammar.files.has(flag);
  if (!file && !grammar.values.has(flag)) return undefined;
  const value = split < 0 ? args[index + 1] : token.slice(split + 1);
  if (value === undefined || value === "" || /^-[^0-9.]/.test(value)) return undefined;
  const next = index + (split < 0 ? 2 : 1);
  return file ? { next, file: resolve(value) } : { next };
}

function modelPaths(input: CalibratableLaunch): string[] | undefined {
  const kapitsa = input.engine === "kapitsa";
  if (kapitsa && input.args[0] !== "serve") return undefined;
  const paths: string[] = [];
  let index = kapitsa ? 1 : 0;
  while (index < input.args.length) {
    const arg = parseArgument(input.args, index, ARGUMENTS[input.engine]);
    if (arg === undefined) return undefined;
    if (arg.file !== undefined) paths.push(arg.file);
    index = arg.next;
  }
  return paths.length > 0 ? paths : undefined;
}

function appendFile(
  hash: ReturnType<typeof createHash>,
  path: string,
  depth: number,
  counter: { left: number },
): boolean {
  if (--counter.left < 0 || depth > MAX_DEPTH) return false;
  const stat = statSync(path, { bigint: true });
  if (!stat.isFile() && !stat.isDirectory()) return false;
  hash.update(JSON.stringify([path, server.modelRunArtifactGenerationDigest(stat)]));
  if (stat.isFile()) return true;
  return readdirSync(path)
    .sort()
    .every((name) => appendFile(hash, join(path, name), depth + 1, counter));
}

function modelArtifactPaths(path: string): readonly string[] | undefined {
  const parts = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/.exec(path);
  if (parts === null) return [path];
  const total = parts[3] ?? "";
  const count = Number(total);
  if (parts[2] !== "00001" || count < 1 || count > 256) return undefined;
  const prefix = parts[1] ?? "";
  return Array.from(
    { length: count },
    (_, i) => `${prefix}-${String(i + 1).padStart(5, "0")}-of-${total}.gguf`,
  );
}

function isNativeHeader(header: Buffer): boolean {
  const magic = header.readUInt32BE(0);
  if (magic === 0x7f454c46) return (header[4] === 1 || header[4] === 2) && header[6] === 1;
  if (
    magic === 0xfeedface ||
    magic === 0xcefaedfe ||
    magic === 0xfeedfacf ||
    magic === 0xcffaedfe
  ) {
    return true;
  }
  // FAT Mach-O shares its magic with Java class files. The architecture
  // count is small in a native universal executable.
  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    const count = header.readUInt32BE(4);
    return count > 0 && count <= 16;
  }
  return false;
}

function nativeExecutableGeneration(path: string): string | undefined {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile()) return undefined;
    const header = Buffer.alloc(8);
    if (readSync(fd, header, 0, header.length, 0) !== header.length || !isNativeHeader(header)) {
      return undefined;
    }
    return server.modelRunArtifactGenerationDigest(stat);
  } finally {
    closeSync(fd);
  }
}

export function deriveManagedLaunchCalibrationKey(
  input: CalibratableLaunch,
  ownerNodeId: string,
): ManagedMemoryCalibrationKey | undefined {
  if (unsafeEnvironment(input.env)) return undefined;
  const paths = modelPaths(input);
  if (paths === undefined) return undefined;
  const hash = createHash("sha256").update(
    JSON.stringify([
      "managed-launch-v1",
      ownerNodeId,
      input.engine,
      Object.entries(input.env).sort(([a], [b]) => a.localeCompare(b)),
      input.binary,
      input.args,
    ]),
  );
  const counter = { left: MAX_ENTRIES };
  try {
    const binaryGeneration = nativeExecutableGeneration(input.binary);
    if (binaryGeneration === undefined) return undefined;
    hash.update(binaryGeneration);
    for (const path of paths) {
      const inputs = modelArtifactPaths(path);
      if (!inputs?.every((part) => appendFile(hash, part, 0, counter))) {
        return undefined;
      }
    }
    return { managedLaunchDigest: hash.digest("hex") };
  } catch {
    return undefined;
  }
}
