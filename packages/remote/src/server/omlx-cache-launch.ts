import { deriveOmlxCacheIdentity } from "@llamactl/core/engines/omlx-cache-identity";
import {
  OMLX_MODEL_SETTINGS_FILE,
  parseOmlxModelSettings,
} from "@llamactl/core/engines/omlx-model-settings";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join } from "node:path";
import { z } from "zod";

import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "../safe-fs.js";

const MAX_FILES = 65_536;
const MAX_DEPTH = 32;
const CACHE_ENV = /^(?:PYTHON|LD_|DYLD_)/;
const STOCK_LAUNCHER =
  /^#!(\/[^\s]+)\n(?:# -\*- coding: utf-8 -\*-\n)?(?:import re\n)?import sys\nfrom omlx\.cli import main\nif __name__ == (?:'__main__'|"__main__"):\n/;

const STOCK_LAUNCHER_BODIES = new Set([
  "    sys.exit(main())",
  `    if sys.argv[0].endswith("-script.pyw"):
        sys.argv[0] = sys.argv[0][:-11]
    elif sys.argv[0].endswith(".exe"):
        sys.argv[0] = sys.argv[0][:-4]
    sys.exit(main())`,
  `    sys.argv[0] = re.sub(r'(-script\\.pyw|\\.exe)?$', '', sys.argv[0])
    sys.exit(main())`,
]);

const PROBE_RUNTIME = `
import importlib.metadata, importlib.util, json, os, site, sys
if sys.prefix == sys.base_prefix or site.ENABLE_USER_SITE:
    raise SystemExit(1)
engine = importlib.util.find_spec("omlx")
if engine is None or engine.origin is None:
    raise SystemExit(1)
for package in importlib.metadata.distributions():
    link = package.read_text("direct_url.json")
    if link and json.loads(link).get("dir_info", {}).get("editable"):
        if package.metadata["Name"].lower() != "omlx":
            raise SystemExit(1)
paths = set()
for path in sys.path:
    absolute = os.path.realpath(path or os.getcwd())
    if os.path.exists(absolute):
        paths.add(absolute)
print(json.dumps({
    "engine": os.path.dirname(engine.origin),
    "interpreter": sys.executable,
    "imports": sorted(paths),
    "version": sys.version,
}))
`;

const ProbeSchema = z.strictObject({
  engine: z.string().refine(isAbsolute),
  interpreter: z.string().refine(isAbsolute),
  imports: z.array(z.string().refine(isAbsolute)).min(1),
  version: z.string().min(1),
});

function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function object(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("oMLX cache settings must be a JSON object");
  }
  return input as Record<string, unknown>;
}

function readSettings(path: string): Record<string, unknown> {
  const input = readOptional(path);
  return input === undefined ? {} : object(JSON.parse(input));
}

function addGeneration(
  path: string,
  hash: ReturnType<typeof createHash>,
  remaining: { count: number },
  depth: number,
): void {
  if (--remaining.count < 0 || depth > MAX_DEPTH) {
    throw new Error("oMLX cache inputs exceed the fingerprint limit");
  }
  const info = statSync(path, { bigint: true });
  const identity = [path, String(info.dev), String(info.ino), String(info.mode)];
  if (info.isDirectory()) {
    // Compiled Python bytecode can appear after the first start.
    hash.update(JSON.stringify(identity));
    for (const entry of readdirSync(path).sort()) {
      if (entry !== "__pycache__" && !entry.endsWith(".pyc")) {
        addGeneration(join(path, entry), hash, remaining, depth + 1);
      }
    }
  } else if (info.isFile()) {
    hash.update(
      JSON.stringify([...identity, String(info.size), String(info.mtimeNs), String(info.ctimeNs)]),
    );
  } else {
    throw new Error("oMLX cache inputs must be regular files or directories");
  }
}

function digestGeneration(paths: readonly string[]): string {
  const hash = createHash("sha256");
  const remaining = { count: MAX_FILES };
  for (const path of paths) addGeneration(path, hash, remaining, 0);
  return hash.digest("hex");
}

interface InstalledBuild {
  version: string;
  paths: string[];
  launcherGeneration: string;
  slotAvailable: boolean;
}

function inspectInstalledBuild(binary: string, env: NodeJS.ProcessEnv): InstalledBuild | undefined {
  if (!isAbsolute(binary) || Object.keys(env).some((key) => CACHE_ENV.test(key))) return undefined;
  const launcherFile = statSync(binary);
  if (!launcherFile.isFile() || launcherFile.size > 16_384) return undefined;
  const script = readFileSync(binary, "utf8");
  const header = STOCK_LAUNCHER.exec(script);
  if (header === null || !STOCK_LAUNCHER_BODIES.has(script.slice(header[0].length).trimEnd())) {
    return undefined;
  }
  const interpreter = header[1];
  if (
    interpreter === undefined ||
    dirname(interpreter) !== dirname(binary) ||
    !/^python\d*(?:\.\d+)?$/.test(basename(interpreter))
  )
    return undefined;
  const probe = ProbeSchema.parse(
    JSON.parse(
      execFileSync(interpreter, ["-B", "-c", PROBE_RUNTIME], {
        cwd: dirname(binary),
        encoding: "utf8",
        env,
        timeout: 3000,
        maxBuffer: 16_384,
        stdio: ["ignore", "pipe", "ignore"],
      }),
    ),
  );
  if (
    basename(probe.interpreter) !== basename(interpreter) ||
    realpathSync(dirname(probe.interpreter)) !== realpathSync(dirname(interpreter))
  )
    return undefined;
  const cliPath = join(probe.engine, "cli.py");
  const cli = readFileSync(cliPath, "utf8");
  const flags = ['"--paged-ssd-cache-dir"', '"--hf-cache"', '"--no-cache"'];
  if (!flags.every((flag) => cli.includes(flag))) return undefined;

  const venv = dirname(dirname(interpreter));
  const boundary = [binary, interpreter, join(venv, "pyvenv.cfg"), cliPath];
  return {
    version: probe.version,
    paths: [...boundary, probe.engine, ...probe.imports],
    launcherGeneration: digestGeneration(boundary),
    slotAvailable: cli.includes('"--slot-save-path"'),
  };
}

function requireInstalledBuild(binary: string, env: NodeJS.ProcessEnv): InstalledBuild {
  let build: InstalledBuild | undefined;
  try {
    build = inspectInstalledBuild(binary, env);
  } catch {
    // Discard interpreter errors and environment-derived output.
  }
  if (build === undefined) {
    throw new Error("oMLX cache mode requires a supported Python launcher");
  }
  return build;
}

function argvValue(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  const value = index === -1 ? undefined : args[index + 1];
  if (value === undefined || !isAbsolute(value)) throw new Error(`oMLX cache requires ${flag}`);
  return value;
}

function digestModelArtifact(modelDir: string, modelId: string): string {
  const names = readdirSync(modelDir);
  if (names.length !== 1 || names[0] !== modelId) {
    throw new Error("oMLX cache requires a single discoverable model");
  }
  return digestGeneration([join(modelDir, modelId)]);
}

function effectiveCacheSettings(global: Record<string, unknown>): Record<string, unknown> {
  const cache = global["cache"] === undefined ? {} : object(global["cache"]);
  const layout = cache["gdn_snapshot_storage"];
  return {
    paged_cache_block_size: cache["paged_cache_block_size"] ?? 256,
    hot_cache_only: cache["hot_cache_only"] ?? false,
    gdn_snapshot_storage:
      layout === "auto" ? null : (layout ?? cache["gdn_ssd_split_enabled"] ?? null),
    gdn_sidecar_precision: cache["gdn_sidecar_precision"] ?? "fp32",
  };
}

function readModelSettings(base: string, modelId: string): Record<string, unknown> {
  const raw = readOptional(join(base, OMLX_MODEL_SETTINGS_FILE));
  if (raw === undefined) return {};
  const result = parseOmlxModelSettings(raw);
  if (!result.ok) throw new Error("oMLX cache model settings are unreadable");
  return Object.hasOwn(result.document.models, modelId)
    ? (result.document.models[modelId] ?? {})
    : {};
}

function protectedCacheDir(base: string, segments: readonly string[]): string {
  let path = base;
  if (!lstatSync(base).isDirectory()) throw new Error("oMLX cache base must be a real directory");
  for (const segment of segments) {
    path = join(path, segment);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    if (!lstatSync(path).isDirectory()) throw new Error("oMLX cache path must be a real directory");
  }
  return path;
}

function separatedSlots(args: readonly string[]): { slot: boolean; args: string[] } {
  const copy = [...args];
  const index = copy.findIndex(
    (arg) => arg === "--slot-save-path" || arg.startsWith("--slot-save-path="),
  );
  if (index === -1) return { slot: false, args: copy };
  copy.splice(index, copy[index] === "--slot-save-path" ? 2 : 1);
  return { slot: true, args: copy };
}

export interface OmlxCacheLaunch {
  binary: string;
  args: string[];
  slotSavePath: string | null;
  verifyCacheInputs?: () => void;
}

interface CacheInputs {
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  base: string;
  modelDir: string;
  modelId: string;
  cacheEpoch: number;
  slot: boolean;
}

function assertedGlobalSettings(base: string, env: NodeJS.ProcessEnv): Record<string, unknown> {
  const global = readSettings(join(base, "settings.json"));
  if (global["slot_save_path"] || env["OMLX_SLOT_SAVE_PATH"]) {
    throw new Error(
      "oMLX managed cache requires slot storage to be declared with --slot-save-path",
    );
  }
  return global;
}

const DRAFT_SETTINGS = [
  ["dflash_enabled", "dflash_draft_model"],
  ["specprefill_enabled", "specprefill_draft_model"],
  ["vlm_mtp_enabled", "vlm_mtp_draft_model"],
] as const;

function cacheDraftGeneration(settings: Record<string, unknown>): string {
  const paths: string[] = [];
  for (const [enabled, draft] of DRAFT_SETTINGS) {
    const active = settings[enabled];
    if (active === undefined || active === false) continue;
    if (active !== true) throw new Error("oMLX cache requires a boolean draft setting");
    const path = settings[draft];
    if (typeof path !== "string" || !isAbsolute(path)) {
      throw new Error("oMLX cache requires a local speculative draft");
    }
    paths.push(path);
  }
  return digestGeneration(paths);
}

function cacheIdentity(input: CacheInputs, build: InstalledBuild): string | undefined {
  const { args, env, base, modelDir, modelId, cacheEpoch, slot } = input;
  const global = assertedGlobalSettings(base, env);
  if (readOptional(join(base, "model_profiles.json")) !== undefined) return undefined;

  const settings = readModelSettings(base, modelId);
  const tuning = createHash("sha256")
    .update(
      JSON.stringify([
        args,
        Object.entries(env).sort(),
        effectiveCacheSettings(global),
        cacheDraftGeneration(settings),
        // Slot saves also need the cache-neutral model settings to match.
        slot ? settings : null,
      ]),
    )
    .digest("hex");
  const derived = deriveOmlxCacheIdentity({
    modelId,
    engineBuild: `${build.version}:${digestGeneration(build.paths)}:${tuning}`,
    cacheEpoch,
    artifact: { path: join(modelDir, modelId), sha256: digestModelArtifact(modelDir, modelId) },
    settings,
  });
  return derived.ok ? derived.identity : undefined;
}

function readCacheIdentity(input: CacheInputs, build: InstalledBuild): string | undefined {
  try {
    return cacheIdentity(input, build);
  } catch {
    // An unknown generation cannot authorize reopening a prior disk cache.
    return undefined;
  }
}

export function prepareOmlxCacheLaunch(
  launch: { binary: string; args: readonly string[] },
  env: NodeJS.ProcessEnv,
  modelRel: string,
  cacheEpoch: number,
): OmlxCacheLaunch {
  const { binary, args: originalArgs } = launch;
  const { slot, args } = separatedSlots(originalArgs);
  const base = argvValue(args, "--base-path");
  assertedGlobalSettings(base, env);
  const modelDir = argvValue(args, "--model-dir");
  if (modelDir.includes(",")) {
    throw new Error("oMLX cache mode requires one model directory");
  }
  const build = requireInstalledBuild(binary, env);
  if (slot && !build.slotAvailable) {
    throw new Error("oMLX cache mode requires slot support for --slot-save-path");
  }
  const input = {
    args,
    env,
    base,
    modelDir,
    modelId: basename(modelRel),
    cacheEpoch,
    slot,
  };
  const identity = args.includes("--no-cache") ? undefined : readCacheIdentity(input, build);
  if (identity === undefined) {
    return {
      binary,
      args: [...args.filter((arg) => arg !== "--no-cache"), "--no-hf-cache", "--no-cache"],
      slotSavePath: null,
      verifyCacheInputs(): void {
        const current = requireInstalledBuild(binary, env);
        if (current.launcherGeneration !== build.launcherGeneration) {
          throw new Error("oMLX launcher changed before spawn");
        }
        assertedGlobalSettings(base, env);
      },
    };
  }

  const key = identity.slice("omlx-cache-v1:".length);
  const prefix = protectedCacheDir(base, ["cache-by-identity", key, "prefix"]);
  const slotSavePath = slot ? protectedCacheDir(base, ["cache-by-identity", key, "slots"]) : null;
  return {
    binary,
    args: [
      ...args,
      "--no-hf-cache",
      "--paged-ssd-cache-dir",
      prefix,
      ...(slotSavePath === null ? [] : ["--slot-save-path", slotSavePath]),
    ],
    slotSavePath,
    verifyCacheInputs(): void {
      if (readCacheIdentity(input, requireInstalledBuild(binary, env)) !== identity) {
        throw new Error("oMLX cache inputs changed before spawn");
      }
      protectedCacheDir(base, ["cache-by-identity", key, "prefix"]);
      if (slot) protectedCacheDir(base, ["cache-by-identity", key, "slots"]);
    },
  };
}
