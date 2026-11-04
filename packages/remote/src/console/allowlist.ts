// Deny-by-default procedure allowlist for the #410 P2b console
// (plan §0.12): the 9 read-only entries of plan §1, each carrying its
// response projection, plus buildConsoleRouter — a fresh tRPC router
// containing ONLY those entries, wrapping a backend router through
// createCaller. Anything not listed here does not exist on the console
// surface.

import type { AnyProcedure, CreateRouterOptions } from "@trpc/server/unstable-core-do-not-import";

import { initTRPC } from "@trpc/server";
import { createCallerFactory } from "@trpc/server/unstable-core-do-not-import";
import { z } from "zod";

import { redactDeep } from "./redact.js";

export type ConsoleProcedureType = "query" | "mutation" | "subscription";

export interface ConsoleAllowlistEntry {
  type: ConsoleProcedureType;
  project: (out: unknown) => unknown;
  precheck?: (ctx: { node: string | null }, input: unknown) => Promise<void>;
}

const REDACTED = "[redacted]";
const ENV_SECRET_KEY = /(?:API_KEY|TOKEN|SECRET|PASSWORD)$/i;
const SECRET_FLAG_NAME = /(?:api[-_]?key|token|secret|password)/i;
const LINE_SECRET_FLAG =
  /(-{1,2}(?:hft|[^\s=]*(?:api[-_]?key|token|secret|password)[^\s=]*))([=\s])(?:\S+)/gi;
const ARGV_KEYS = new Set(["extraArgs", "args", "cmdline"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function maskEnvSecrets(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(maskEnvSecrets);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] =
        ENV_SECRET_KEY.test(key) && typeof inner === "string" && inner !== ""
          ? REDACTED
          : maskEnvSecrets(inner);
    }
    return out;
  }
  return value;
}

function maskEnvRecord(env: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(env)) {
    out[key] = inner === "" || inner === null || inner === undefined ? inner : REDACTED;
  }
  return out;
}

function maskCliEnv(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskCliEnv);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      if (key === "cli" && Array.isArray(inner)) {
        out[key] = inner.map((entry) =>
          isRecord(entry) && isRecord(entry["env"])
            ? { ...entry, env: maskEnvRecord(entry["env"]) }
            : maskCliEnv(entry),
        );
      } else {
        out[key] = maskCliEnv(inner);
      }
    }
    return out;
  }
  return value;
}

function isSecretFlag(token: string): boolean {
  const name = token.replace(/^-+/, "");
  return name === "hft" || SECRET_FLAG_NAME.test(name);
}

function maskArgv(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    const eq = token.indexOf("=");
    if (eq > 0 && isSecretFlag(token.slice(0, eq))) {
      out.push(`${token.slice(0, eq)}=${REDACTED}`);
      continue;
    }
    out.push(token);
    if (isSecretFlag(token)) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        out.push(REDACTED);
        i += 1;
      }
    }
  }
  return out;
}

function maskArgvArrays(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskArgvArrays);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] =
        ARGV_KEYS.has(key) && Array.isArray(inner) && inner.every((v) => typeof v === "string")
          ? maskArgv(inner)
          : maskArgvArrays(inner);
    }
    return out;
  }
  return value;
}

function maskLineSecrets(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replaceAll(
      LINE_SECRET_FLAG,
      (_m, flag: string, sep: string) => `${flag}${sep}${REDACTED}`,
    );
  }
  if (Array.isArray(value)) return value.map(maskLineSecrets);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) out[key] = maskLineSecrets(inner);
    return out;
  }
  return value;
}

export const CONSOLE_ALLOWLIST: Record<string, ConsoleAllowlistEntry> = {
  env: {
    project: (out) => redactDeep(maskEnvSecrets(out)),
    type: "query",
  },
  nodeFacts: {
    project: (out) => redactDeep(out),
    type: "query",
  },
  nodeList: {
    project: (out) => redactDeep(maskCliEnv(out)),
    type: "query",
  },
  nodeTest: {
    project: (out) => redactDeep(maskCliEnv(out)),
    type: "query",
  },
  serverLogs: {
    project: (out) => redactDeep(maskLineSecrets(out)),
    type: "subscription",
  },
  serverStatus: {
    project: (out) => redactDeep(maskArgvArrays(out)),
    type: "query",
  },
  workloadDescribe: {
    project: (out) => redactDeep(maskArgvArrays(out)),
    type: "query",
  },
  workloadList: {
    project: (out) => redactDeep(maskArgvArrays(out)),
    type: "query",
  },
  workloadsDir: {
    project: (out) => redactDeep(out),
    type: "query",
  },
};

const t = initTRPC.context<{ node: string | null }>().create({
  isDev: false,
  sse: { ping: { enabled: true, intervalMs: 10_000 } },
});

type BackendCaller = Record<string, ((input: unknown) => unknown) | undefined>;
type BackendCallerFactory = (
  ctx: { node: string | null },
  opts?: { signal?: AbortSignal },
) => BackendCaller;

const makeBackendCaller = createCallerFactory() as unknown as (
  backend: unknown,
) => BackendCallerFactory;

function backendCaller(
  backend: unknown,
  ctx: { node: string | null },
  signal: AbortSignal | undefined,
): BackendCaller {
  return makeBackendCaller(backend)({ node: ctx.node }, signal === undefined ? {} : { signal });
}

function wrapQuery(backend: unknown, name: string, entry: ConsoleAllowlistEntry): AnyProcedure {
  return t.procedure.input(z.unknown()).query(async ({ ctx, input, signal }) => {
    await entry.precheck?.(ctx, input);
    const procedure = backendCaller(backend, ctx, signal)[name];
    if (procedure === undefined) throw new Error(`Console backend has no procedure ${name}`);
    return entry.project(await procedure(input));
  }) as AnyProcedure;
}

function wrapSubscription(
  backend: unknown,
  name: string,
  entry: ConsoleAllowlistEntry,
): AnyProcedure {
  return t.procedure.input(z.unknown()).subscription(async function* ({ ctx, input, signal }) {
    await entry.precheck?.(ctx, input);
    const procedure = backendCaller(backend, ctx, signal)[name];
    if (procedure === undefined) throw new Error(`Console backend has no procedure ${name}`);
    const iterable = (await procedure(input)) as AsyncIterable<unknown>;
    const iterator = iterable[Symbol.asyncIterator]();
    try {
      for (;;) {
        const step = await iterator.next();
        if (step.done === true) break;
        yield entry.project(step.value);
      }
    } finally {
      await iterator.return?.();
    }
  }) as AnyProcedure;
}

export function buildConsoleRouter(backend: unknown): ReturnType<typeof t.router> {
  const procs: CreateRouterOptions = {};
  for (const [name, entry] of Object.entries(CONSOLE_ALLOWLIST)) {
    procs[name] =
      entry.type === "subscription"
        ? wrapSubscription(backend, name, entry)
        : wrapQuery(backend, name, entry);
  }
  return t.router(procs);
}
