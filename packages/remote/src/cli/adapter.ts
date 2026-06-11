import type {
  AiProvider,
  ChatMessage,
  ProviderHealth,
  UnifiedAiRequest,
  UnifiedAiResponse,
  UnifiedStreamEvent,
} from "@nova/contracts";

/**
 * Subprocess-backed `AiProvider` for CLI subscription tools
 * (`claude -p`, `codex exec`, `gemini -p`). Spawns the declared
 * binary on the agent's own machine — where the CLI is logged in —
 * and returns the assistant response as a `UnifiedAiResponse`.
 *
 * Design constraints (see the plan's Phase 1 §"Anti-pattern guards"):
 *
 *   - Direct argv only. `shell: true` is banned: prompt content
 *     becomes a shell-injection vector the moment we route the
 *     prompt through /bin/sh.
 *   - Timeouts via AbortController, not `Bun.spawn`'s option (which
 *     doesn't exist for this use case). An AbortSignal from the
 *     adapter's own controller flips the subprocess down.
 *   - Prompt + response bodies NEVER land in the journal. Byte
 *     counts + latency + exit code only.
 *   - USD cost is never synthesized — subscriptions are flat-fee.
 *     Track calls (journal) and bytes; let humans look at the
 *     quota dashboard.
 *   - No Streaming in v1. `streamResponse` is intentionally omitted.
 *     Phase 5 adds it for presets that can line-buffer.
 */
import { randomUUID } from "node:crypto";

import type { CliBinding } from "../config/schema.js";

import { appendCliJournal, type CliJournalEntry } from "./journal.js";
import { expandArgs, resolvePreset } from "./presets.js";

export interface CliProviderOptions {
  /** The agent node's name — used for the virtual provider id +
   *  journal attribution (`<agent>.<cli>`). */
  agentName: string;
  binding: CliBinding;
  /** Injection seam for tests — swap in a fake spawn that returns
   *  canned stdout/stderr without touching the OS. Defaults to
   *  `Bun.spawn`. */
  spawn?: SpawnFn;
  /** Injection seam for the streaming path. Defaults to a Bun-
   *  backed implementation that line-buffers stdout. Tests use
   *  this to feed a hand-crafted line sequence without spawning a
   *  real process. */
  spawnStream?: SpawnStreamFn;
  /** Injection seam for tests — override the journal writer so
   *  assertions don't require a tmpdir roundtrip. */
  journalWrite?: (entry: CliJournalEntry) => Promise<void>;
  env?: NodeJS.ProcessEnv;
}

export type SpawnArgv = [command: string, ...args: string[]];

export type SpawnFn = (
  argv: SpawnArgv,
  opts: {
    env: NodeJS.ProcessEnv;
    signal: AbortSignal;
    /** When `true`, the adapter pipes the prompt on stdin (preset
     *  argv had no `{{prompt}}` token). Otherwise stdin is
     *  explicitly closed. */
    promptOnStdin: boolean;
    /** Prompt text, only read when `promptOnStdin` is true. */
    prompt: string;
  },
) => Promise<SpawnResult>;

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** `true` when the subprocess was killed by the AbortSignal
   *  (timeout). `exitCode` in that case is usually -1 or the
   *  signal number; the adapter treats it uniformly. */
  aborted: boolean;
}

/**
 * Streaming spawn contract. `stdout` yields lines as they arrive
 * (without the trailing newline); `stderrPromise` resolves to the
 * full captured stderr after the child exits; `exitedPromise`
 * resolves to the child's final state. Adapters consuming this
 * must iterate `stdout` to completion OR cancel via the caller's
 * AbortSignal — partial consumption leaks the child.
 */
export type SpawnStreamFn = (
  argv: SpawnArgv,
  opts: {
    env: NodeJS.ProcessEnv;
    signal: AbortSignal;
    promptOnStdin: boolean;
    prompt: string;
  },
) => Promise<SpawnStreamResult>;

export interface SpawnStreamResult {
  stdout: AsyncIterable<string>;
  stderrPromise: Promise<string>;
  exitedPromise: Promise<{ exitCode: number; aborted: boolean }>;
}

interface BunChildProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  stdin?: { write: (chunk: string) => void; end: () => void } | null;
  kill: () => void;
}

interface BunRuntime {
  spawn: (
    argv: SpawnArgv,
    opts: {
      env: NodeJS.ProcessEnv;
      stdout: "pipe";
      stderr: "pipe";
      stdin: "pipe" | null;
    },
  ) => BunChildProcess;
}

/**
 * Build an `AiProvider` backed by a subscription CLI. Call per-
 * request from the factory, not per-workspace — each adapter is
 * cheap (no persistent connection; every call re-spawns).
 */
function buildCliJournalEntry(
  opts: CliProviderOptions,
  startedAt: number,
  prompt: string,
  spawnResult: SpawnResult | undefined,
  ok: boolean,
): CliJournalEntry {
  const latencyMs = Date.now() - startedAt;
  const entry: CliJournalEntry = {
    ts: new Date(startedAt).toISOString(),
    agent: opts.agentName,
    binding_name: opts.binding.name,
    preset: opts.binding.preset,
    ...(opts.binding.subscription !== undefined ? { subscription: opts.binding.subscription } : {}),
    ...(opts.binding.defaultModel !== undefined ? { model: opts.binding.defaultModel } : {}),
    prompt_bytes: Buffer.byteLength(prompt, "utf8"),
    response_bytes: spawnResult ? Buffer.byteLength(spawnResult.stdout, "utf8") : 0,
    latency_ms: latencyMs,
    ok,
  };
  if (spawnResult) {
    entry.exit_code = spawnResult.exitCode;
    if (spawnResult.aborted) entry.error_code = "timeout";
    else if (spawnResult.exitCode !== 0) entry.error_code = "non-zero-exit";
  } else {
    entry.error_code = "spawn-failed";
  }
  return entry;
}

function buildCliResponse(
  opts: CliProviderOptions,
  startedAt: number,
  prompt: string,
  assistantContent: string,
  model: string,
): UnifiedAiResponse {
  // Rough token estimation — 4 chars/token is the industry
  // rule of thumb. Real adapters (openai-compat) read usage
  // off the response; CLIs don't expose it, so the journal
  // carries bytes and the UsageRecord carries an estimate.
  const promptTokens = Math.ceil(Buffer.byteLength(prompt, "utf8") / 4);
  const completionTokens = Math.ceil(Buffer.byteLength(assistantContent, "utf8") / 4);
  const latencyMs = Date.now() - startedAt;
  return {
    id: `cli-${randomUUID()}`,
    object: "chat.completion",
    model,
    created: Math.floor(startedAt / 1000),
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: assistantContent },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
    latencyMs,
    provider: `${opts.agentName}.${opts.binding.name}`,
  };
}

function throwCliError(
  providerId: string,
  opts: CliProviderOptions,
  spawnResult: SpawnResult,
  code: "timeout" | "non-zero-exit",
): never {
  const msg =
    code === "timeout"
      ? `timed out after ${String(opts.binding.timeoutMs)}ms (stderr: ${truncate(spawnResult.stderr, 400)})`
      : `exited with code ${String(spawnResult.exitCode)} (stderr: ${truncate(spawnResult.stderr, 400)})`;
  throw wrapCliError(providerId, new Error(msg), code);
}

function buildStreamErrorEvent(providerId: string, err: unknown): UnifiedStreamEvent {
  return {
    type: "error",
    error: {
      message: `cli provider '${providerId}' stream-failed: ${(err as Error).message}`,
      code: "stream-failed",
    },
  };
}

function buildStreamJournalEntry(
  opts: CliProviderOptions,
  startedAt: number,
  prompt: string,
  responseBytes: number,
  exitCode: number,
  aborted: boolean,
): CliJournalEntry {
  return {
    ts: new Date(startedAt).toISOString(),
    agent: opts.agentName,
    binding_name: opts.binding.name,
    preset: opts.binding.preset,
    ...(opts.binding.subscription !== undefined ? { subscription: opts.binding.subscription } : {}),
    ...(opts.binding.defaultModel !== undefined ? { model: opts.binding.defaultModel } : {}),
    prompt_bytes: Buffer.byteLength(prompt, "utf8"),
    response_bytes: responseBytes,
    latency_ms: Date.now() - startedAt,
    ok: !aborted && exitCode === 0,
    exit_code: exitCode,
    ...(aborted
      ? { error_code: "timeout" }
      : exitCode !== 0
        ? { error_code: "non-zero-exit" }
        : {}),
  };
}

async function createCliResponse(
  opts: CliProviderOptions,
  providerId: string,
  spawn: SpawnFn,
  journalWrite: (entry: CliJournalEntry) => Promise<void>,
  request: UnifiedAiRequest,
): Promise<UnifiedAiResponse> {
  const resolved = resolvePreset(opts.binding);
  const prompt = messagesToPrompt(request.messages);
  const { args: expandedArgs, promptOnStdin } = expandArgs(resolved.args, prompt);
  const argv: SpawnArgv = [resolved.command, ...expandedArgs];
  const env = mergeEnv(opts.env ?? process.env, opts.binding.env);

  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    ctrl.abort();
  }, opts.binding.timeoutMs);
  const startedAt = Date.now();
  let spawnResult: SpawnResult;
  try {
    spawnResult = await spawn(argv, {
      env,
      signal: ctrl.signal,
      promptOnStdin,
      prompt,
    });
  } catch (err) {
    const entry = buildCliJournalEntry(opts, startedAt, prompt, undefined, false);
    await journalWrite(entry);
    throw wrapCliError(providerId, err, "spawn-failed");
  } finally {
    clearTimeout(timer);
  }

  const entry = buildCliJournalEntry(
    opts,
    startedAt,
    prompt,
    spawnResult,
    !spawnResult.aborted && spawnResult.exitCode === 0,
  );
  await journalWrite(entry);

  if (spawnResult.aborted) {
    throwCliError(providerId, opts, spawnResult, "timeout");
  }
  if (spawnResult.exitCode !== 0) {
    throwCliError(providerId, opts, spawnResult, "non-zero-exit");
  }

  const assistantContent = parseAssistantContent(spawnResult.stdout, resolved.format);
  return buildCliResponse(opts, startedAt, prompt, assistantContent, request.model);
}

/**
 * Local AbortController: timeout + caller signal both flip it. The
 * caller's AbortSignal (from tRPC) takes precedence — if the UI
 * cancels, kill the child. `cleanup` detaches the timer + listener.
 */
function createLinkedAbort(
  timeoutMs: number,
  callerSignal?: AbortSignal,
): { ctrl: AbortController; cleanup: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    ctrl.abort();
  }, timeoutMs);
  const onCallerAbort = (): void => {
    ctrl.abort();
  };
  if (callerSignal?.aborted) ctrl.abort();
  else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  return {
    ctrl,
    cleanup: (): void => {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

function buildContentChunk(
  chunkId: string,
  model: string,
  startedAt: number,
  delta: string,
  yieldedRole: boolean,
): UnifiedStreamEvent {
  const choice: {
    index: number;
    delta: { role?: "assistant"; content: string };
  } = {
    index: 0,
    delta: yieldedRole ? { content: delta } : { role: "assistant", content: delta },
  };
  return {
    type: "chunk",
    chunk: {
      id: chunkId,
      object: "chat.completion.chunk",
      model,
      created: Math.floor(startedAt / 1000),
      choices: [choice],
    },
  };
}

/** Terminal events after the child exits: timeout / non-zero-exit
 *  errors (when applicable) followed by the closing `done`. */
function* exitStreamEvents(
  providerId: string,
  timeoutMs: number,
  exitCode: number,
  aborted: boolean,
  stderrText: string,
): Generator<UnifiedStreamEvent, void, void> {
  if (aborted) {
    yield {
      type: "error",
      error: {
        message: `cli provider '${providerId}' timeout after ${String(timeoutMs)}ms`,
        code: "timeout",
        retryable: false,
      },
    };
    yield { type: "done", finish_reason: "stop" };
    return;
  }
  if (exitCode !== 0) {
    yield {
      type: "error",
      error: {
        message: `cli provider '${providerId}' non-zero-exit ${String(exitCode)}: ${truncate(stderrText, 400)}`,
        code: "non-zero-exit",
      },
    };
  }
  yield { type: "done", finish_reason: "stop" };
}

async function* streamCliResponse(
  opts: CliProviderOptions,
  providerId: string,
  spawnStream: SpawnStreamFn,
  journalWrite: (entry: CliJournalEntry) => Promise<void>,
  request: UnifiedAiRequest,
  callerSignal?: AbortSignal,
): AsyncGenerator<UnifiedStreamEvent, void, void> {
  const resolved = resolvePreset(opts.binding);
  const prompt = messagesToPrompt(request.messages);
  const { args: expandedArgs, promptOnStdin } = expandArgs(resolved.args, prompt);
  const argv: SpawnArgv = [resolved.command, ...expandedArgs];
  const env = mergeEnv(opts.env ?? process.env, opts.binding.env);
  const { ctrl, cleanup } = createLinkedAbort(opts.binding.timeoutMs, callerSignal);
  const startedAt = Date.now();
  const chunkId = `cli-${randomUUID()}`;
  let responseBytes = 0;
  let yieldedRole = false;
  let stream: SpawnStreamResult;
  try {
    stream = await spawnStream(argv, {
      env,
      signal: ctrl.signal,
      promptOnStdin,
      prompt,
    });
  } catch (err) {
    cleanup();
    await journalWrite(buildCliJournalEntry(opts, startedAt, prompt, undefined, false));
    yield {
      type: "error",
      error: {
        message: `cli provider '${providerId}' spawn-failed: ${(err as Error).message}`,
        code: "spawn-failed",
      },
    };
    return;
  }

  try {
    for await (const rawLine of stream.stdout) {
      if (ctrl.signal.aborted) break;
      // Re-attach the newline so concatenated deltas
      // reconstruct the original output. The final
      // \n is trimmed in consumers that display
      // token-by-token.
      const delta = `${rawLine}\n`;
      responseBytes += Buffer.byteLength(delta, "utf8");
      yield buildContentChunk(chunkId, request.model, startedAt, delta, yieldedRole);
      yieldedRole = true;
    }
  } catch (err) {
    yield buildStreamErrorEvent(providerId, err);
    // Fall through to the journal write + done below.
  }

  const { exitCode, aborted } = await stream.exitedPromise;
  const stderrText = await stream.stderrPromise;
  cleanup();

  await journalWrite(
    buildStreamJournalEntry(opts, startedAt, prompt, responseBytes, exitCode, aborted),
  );

  yield* exitStreamEvents(providerId, opts.binding.timeoutMs, exitCode, aborted, stderrText);
}

async function cliHealthCheck(
  opts: CliProviderOptions,
  providerId: string,
  spawn: SpawnFn,
): Promise<ProviderHealth> {
  const resolved = resolvePreset(opts.binding);
  const startedAt = Date.now();
  const ctrl = new AbortController();
  // Short window — version probes should come back instantly. If
  // the binary hangs on --version we'd rather fail fast than
  // burn through the call timeout.
  const timer = setTimeout(() => {
    ctrl.abort();
  }, 10_000);
  try {
    const result = await spawn([resolved.command, ...resolved.versionProbe], {
      env: mergeEnv(opts.env ?? process.env, opts.binding.env),
      signal: ctrl.signal,
      promptOnStdin: false,
      prompt: "",
    });
    const latencyMs = Date.now() - startedAt;
    if (result.aborted) {
      return {
        state: "unhealthy",
        lastChecked: new Date().toISOString(),
        latencyMs,
        error: `timeout running ${resolved.command} ${resolved.versionProbe.join(" ")}`,
      };
    }
    if (result.exitCode !== 0) {
      return {
        state: "unhealthy",
        lastChecked: new Date().toISOString(),
        latencyMs,
        error: `${resolved.command} ${resolved.versionProbe.join(" ")} exited ${String(result.exitCode)}: ${truncate(result.stderr, 240)}`,
      };
    }
    return {
      state: "healthy",
      lastChecked: new Date().toISOString(),
      latencyMs,
    };
  } catch (err) {
    return {
      state: "unhealthy",
      lastChecked: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      error: (err as Error).message,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function createCliSubprocessProvider(opts: CliProviderOptions): AiProvider {
  const resolved = resolvePreset(opts.binding);
  const providerId = `${opts.agentName}.${opts.binding.name}`;
  const spawn = opts.spawn ?? defaultBunSpawn;
  const spawnStream = opts.spawnStream ?? defaultBunSpawnStream;
  const journalWrite = opts.journalWrite ?? ((e): Promise<void> => appendCliJournal(e, opts.env));

  return {
    name: providerId,
    displayName: `${opts.binding.name} (${opts.binding.preset})`,
    createResponse: (request) => createCliResponse(opts, providerId, spawn, journalWrite, request),

    // Streaming path — only wired when the preset declares
    // `stream: true`. Presets that don't support incremental
    // output omit this method entirely so routers fall through
    // to `createResponse` (which then emits a single synthetic
    // chunk via the orchestrator's own wrap logic).
    ...(resolved.stream
      ? {
          async *streamResponse(
            request: UnifiedAiRequest,
            callerSignal?: AbortSignal,
          ): AsyncGenerator<UnifiedStreamEvent, void, void> {
            yield* streamCliResponse(
              opts,
              providerId,
              spawnStream,
              journalWrite,
              request,
              callerSignal,
            );
          },
        }
      : {}),
    healthCheck: () => cliHealthCheck(opts, providerId, spawn),
  };
}

/**
 * Join a `messages[]` array into a single prompt string. Format
 * chosen for round-trip readability: `<role>: <content>\n` per
 * line, with assistant responses preserved so multi-turn context
 * reaches the CLI. CLIs like `claude -p` accept plaintext; the
 * model sees the role tags as context.
 *
 * Multipart content (text/image blocks) is collapsed: text blocks
 * concatenated with newline, image blocks replaced with a brief
 * placeholder. CLI-subscription backends don't accept multimodal
 * input via the `-p` flag today — operators use API adapters for
 * vision tasks.
 */
export function messagesToPrompt(messages: readonly ChatMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    const text = flattenContent(m.content);
    if (!text) continue;
    lines.push(`${m.role}: ${text}`);
  }
  return lines.join("\n");
}

function flattenContent(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if ("text" in block && typeof block.text === "string") {
      parts.push(block.text);
    } else if ("type" in block && block.type === "image_url") {
      parts.push("[image omitted — CLI presets do not accept multimodal input]");
    }
  }
  return parts.join("\n");
}

function parseAssistantContent(stdout: string, format: "text" | "json"): string {
  if (format === "text") return stdout.trimEnd();
  try {
    const parsed = JSON.parse(stdout) as unknown;
    // Best-effort extraction — presets that emit JSON vary. Fall back
    // to the full JSON string so nothing is silently dropped.
    return extractJsonAssistantText(parsed) ?? JSON.stringify(parsed);
  } catch {
    return stdout.trimEnd();
  }
}

/** Extract the assistant text from common JSON shapes:
 *  `{ response: string }`, `{ content: string }`,
 *  `{ choices: [{ message: { content: string } }] }`. */
function extractJsonAssistantText(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.response === "string") return obj.response;
  if (typeof obj.content === "string") return obj.content;
  const choices = obj.choices;
  if (!Array.isArray(choices) || !choices[0]) return undefined;
  const first = choices[0] as { message?: { content?: unknown } };
  return typeof first.message?.content === "string" ? first.message.content : undefined;
}

function mergeEnv(base: NodeJS.ProcessEnv, overlay?: Record<string, string>): NodeJS.ProcessEnv {
  if (!overlay) return { ...base };
  return { ...base, ...overlay };
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n)}…`;
}

function wrapCliError(
  providerId: string,
  cause: unknown,
  code: "spawn-failed" | "timeout" | "non-zero-exit" | "parse-error",
): Error {
  const msg = cause instanceof Error ? cause.message : String(cause);
  const err = new Error(`cli provider '${providerId}' ${code}: ${msg}`);
  (err as Error & { code?: string }).code = code;
  return err;
}

/**
 * Line-buffered streaming spawn — default for presets that declare
 * `stream: true`. Reads stdout as a `ReadableStream<Uint8Array>`,
 * decodes incrementally, and yields complete lines as they arrive.
 * A trailing fragment (no terminating `\n`) is yielded at close.
 *
 * stderr is buffered in full + surfaced via `stderrPromise` so the
 * adapter can include it in error messages without blocking the
 * streaming stdout path.
 */
const defaultBunSpawnStream: SpawnStreamFn = (argv, opts) => {
  const Bun = (globalThis as { Bun?: BunRuntime }).Bun;
  if (!Bun?.spawn) {
    throw new Error("Bun runtime not detected — cli adapter streaming requires Bun.spawn");
  }
  const [command, ...args] = argv;
  const proc = Bun.spawn([command, ...args], {
    env: opts.env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: opts.promptOnStdin ? "pipe" : null,
  });
  if (opts.promptOnStdin && proc.stdin) {
    try {
      proc.stdin.write(opts.prompt);
      proc.stdin.end();
    } catch {
      /* surfaced via stderr + exit code */
    }
  }
  let aborted = false;
  const onAbort = (): void => {
    aborted = true;
    try {
      proc.kill();
    } catch {
      /* already exited */
    }
  };
  opts.signal.addEventListener("abort", onAbort, { once: true });

  const stderrPromise = new Response(proc.stderr).text();
  const exitedPromise = proc.exited.then((exitCode: number) => {
    opts.signal.removeEventListener("abort", onAbort);
    return { exitCode, aborted };
  });

  async function* readLines(): AsyncIterable<string> {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl = buffer.indexOf("\n");
        while (nl >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          yield line;
          nl = buffer.indexOf("\n");
        }
      }
      // Drain decoder + yield any trailing fragment that didn't
      // end with a newline. Common for single-line outputs.
      buffer += decoder.decode();
      if (buffer.length === 0) {
        return;
      }
      yield buffer;
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
  }

  return Promise.resolve({
    stdout: readLines(),
    stderrPromise,
    exitedPromise,
  });
};

const defaultBunSpawn: SpawnFn = async (argv, opts) => {
  // Defer to Bun.spawn — the production path. Tests inject their
  // own `SpawnFn` via `CliProviderOptions.spawn` so this code only
  // runs against the real environment.
  const Bun = (globalThis as { Bun?: BunRuntime }).Bun;
  if (!Bun?.spawn) {
    throw new Error("Bun runtime not detected — cli adapter requires Bun.spawn");
  }
  const [command, ...args] = argv;
  const proc = Bun.spawn([command, ...args], {
    env: opts.env,
    stdout: "pipe",
    stderr: "pipe",
    // Bun.spawn supports stdin: 'pipe' | ArrayBuffer | file. Use
    // pipe when we need to send the prompt; null otherwise.
    stdin: opts.promptOnStdin ? "pipe" : null,
  });
  if (opts.promptOnStdin && proc.stdin) {
    try {
      proc.stdin.write(opts.prompt);
      proc.stdin.end();
    } catch {
      /* the child's own stderr + exit code will surface the issue */
    }
  }
  let aborted = false;
  const onAbort = (): void => {
    aborted = true;
    try {
      proc.kill();
    } catch {
      /* already exited */
    }
  };
  opts.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode, aborted };
  } finally {
    opts.signal.removeEventListener("abort", onAbort);
  }
};
