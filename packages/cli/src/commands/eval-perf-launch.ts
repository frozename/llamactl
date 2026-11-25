import type { BootResult, ModelSpec, PerfSuiteLoadHooks } from "@llamactl/eval";

import { catalog } from "@llamactl/core";
import { ensureModelServing, teardownIfOwned } from "@llamactl/eval";
import { defaultResidencyStorePath, exclusiveGroupLaunchRefusal } from "@llamactl/remote";
import { isAbsolute, relative, resolve } from "node:path";

import { existsSync } from "../safe-fs.js";

/**
 * `llamactl eval perf --launch` boots llama-server through the eval matrix
 * lifecycle inside the perf suite's load hooks. The hooks own no process
 * themselves; they delegate ownership-aware boot and teardown to
 * ensureModelServing/teardownIfOwned so an already-serving engine is never
 * killed by eval perf.
 */

export interface EvalPerfLaunchDeps {
  ensure(spec: ModelSpec): Promise<BootResult>;
  teardown(boot: BootResult): Promise<void>;
}

export const defaultLaunchDeps = (): EvalPerfLaunchDeps => {
  return { ensure: ensureModelServing, teardown: teardownIfOwned };
};

export interface ValidateLaunchInput {
  engine: string;
  hostname: string;
  url: string;
  flags: readonly string[] | null;
  model: string;
}

export type LaunchValidationResult = { spec: ModelSpec } | { error: string };

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(hostname);
}

export function validateLaunch(
  values: Record<string, string>,
  input: ValidateLaunchInput,
): LaunchValidationResult {
  const engine = values["--engine"] ?? input.engine;
  if (engine !== "llamacpp") {
    return {
      error: `--launch starts llama-server through the eval matrix lifecycle and supports only --engine llamacpp (got ${engine})`,
    };
  }

  const hostname = input.hostname;
  if (!isLoopback(hostname)) {
    return {
      error: `--launch needs a loopback --url (got ${hostname}); the engine is started on this machine`,
    };
  }

  const parsed = new URL(input.url);
  if (parsed.port === "") {
    return { error: "--launch needs an explicit port in --url" };
  }

  const binary = values["--binary"];
  const gguf = values["--gguf"];
  if (binary === undefined || gguf === undefined) {
    return { error: "--launch needs --binary <path> and --gguf <path>" };
  }
  if (!existsSync(binary)) {
    return { error: `--launch needs an existing --binary (not found: ${binary})` };
  }
  if (!existsSync(gguf)) {
    return { error: `--launch needs an existing --gguf (not found: ${gguf})` };
  }
  if (values["--pid"] !== undefined) {
    return {
      error:
        "--pid cannot be combined with --launch; the launched engine's PID is not known before the suite starts",
    };
  }

  const model = values["--model"] ?? input.model;
  return {
    spec: {
      name: model,
      engine: "llamacpp",
      gguf_path: gguf,
      binary,
      host: hostname,
      port: Number(parsed.port),
      managed: true,
      request_model_id: model,
      extra_args: input.flags ?? [],
      quant: values["--quant"] ?? "",
      family: "",
      size_params: "",
    },
  };
}

export function launchRefusal(model: string, gguf: string): string | null {
  const modelsDir = process.env["LLAMA_CPP_MODELS"];
  let matchedRel: string | null = null;
  let row: ReturnType<typeof catalog.findByRel> = null;

  if (modelsDir !== undefined) {
    const rel = relative(resolve(modelsDir), resolve(gguf));
    if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) {
      const found = catalog.findByRel(rel);
      if (found !== null) {
        matchedRel = rel;
        row = found;
      }
    }
  }
  row ??= catalog.findByRel(model);

  // #517: the launch gate uses the artifact's catalog residency group, with
  // --model only as the fallback when --gguf does not resolve to a catalog rel.
  return exclusiveGroupLaunchRefusal({
    id: matchedRel ?? model,
    group: row?.residencyGroup,
    storePath: defaultResidencyStorePath(),
  });
}

export function createLaunchLoadHooks(
  spec: ModelSpec,
  deps: EvalPerfLaunchDeps,
): {
  hooks: PerfSuiteLoadHooks;
  foreign(): boolean;
  failure(): string | null;
  teardown(): Promise<void>;
} {
  let boot: BootResult | null = null;
  let isForeign = false;
  let failureMessage: string | null = null;
  const host = spec.host;
  const port = spec.port;

  const ensure = async (): Promise<void> => {
    try {
      const next = await deps.ensure(spec);
      boot = next;
      if (!next.owned) {
        isForeign = true;
        throw new Error(
          `an engine was already serving at ${host}:${String(port)} before --launch started one; cold/warm load is measured only for an engine eval perf starts`,
        );
      }
    } catch (err) {
      if (!isForeign && failureMessage === null) {
        failureMessage = err instanceof Error ? err.message : String(err);
      }
      throw err;
    }
  };

  const cold = async (): Promise<void> => {
    await ensure();
  };

  const warm = async (): Promise<void> => {
    const current = boot;
    boot = null;
    if (current !== null) {
      await deps.teardown(current);
    }
    await ensure();
  };

  const teardown = async (): Promise<void> => {
    const current = boot;
    boot = null;
    if (current !== null) {
      await deps.teardown(current);
    }
  };

  return {
    hooks: { cold, warm },
    foreign: () => isForeign,
    failure: () => failureMessage,
    teardown,
  };
}

export const LAUNCH_SLOTS_REASON =
  "--launch starts the engine inside the perf suite, so GET /props is not probed before the run; pass --slots <n> to measure c2/c4";

export async function preflightLaunch(
  url: string,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  try {
    const resp = await fetchImpl(new URL("/health", url));
    const status = String(resp.status);
    return `--launch needs a free port, but something is already answering at ${url} (GET /health returned HTTP ${status})`;
  } catch {
    return null;
  }
}
