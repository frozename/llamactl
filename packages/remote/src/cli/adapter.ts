import type { CliBinding } from "@llamactl/core/config/schema";
import type {
  AiProvider,
  ChatMessage,
  OpenAICompatOnUsageObservation,
  ProviderExecutionContext,
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
  /** Provenance-tagged usage callback (nova's
   *  `OpenAICompatOnUsageObservation`). Fires exactly once per
   *  successful non-stream `createResponse` with the adapter's
   *  byte-estimated counts marked `source: 'estimated'` — the
   *  estimate is never presented on the response itself. Callback
   *  exceptions are swallowed; production wiring leaves this unset
   *  so estimates never reach the observed-usage corpus. */
  onUsageObservation?: OpenAICompatOnUsageObservation;
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
    /** Grace window between SIGTERM and the SIGKILL escalation on
     *  abort. Defaults to `CLI_KILL_GRACE_MS`; tests shorten it. */
    killGraceMs?: number;
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
    /** Same kill-grace override as `SpawnFn`. */
    killGraceMs?: number;
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
  kill: (signal?: number | string) => void;
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
  errorCode?: string,
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
    if (errorCode !== undefined) entry.error_code = errorCode;
    else if (spawnResult.aborted) entry.error_code = "timeout";
    else if (spawnResult.exitCode !== 0) entry.error_code = "non-zero-exit";
  } else {
    entry.error_code = errorCode ?? "spawn-failed";
  }
  return entry;
}

function buildCliResponse(
  opts: CliProviderOptions,
  startedAt: number,
  prompt: string,
  assistantContent: string,
  model: string,
  context?: ProviderExecutionContext,
): UnifiedAiResponse {
  // Rough token estimation — 4 chars/token is the industry
  // rule of thumb. CLIs don't expose upstream usage, so the
  // estimate is reported ONLY through the observation hook with
  // `source: 'estimated'` — never on `response.usage`, which
  // consumers read as upstream-observed. The byte journal stays
  // the quota record.
  const promptTokens = Math.ceil(Buffer.byteLength(prompt, "utf8") / 4);
  const completionTokens = Math.ceil(Buffer.byteLength(assistantContent, "utf8") / 4);
  const latencyMs = Date.now() - startedAt;
  try {
    opts.onUsageObservation?.({
      provider: `${opts.agentName}.${opts.binding.name}`,
      model,
      kind: "chat",
      latency_ms: latencyMs,
      observation: {
        source: "estimated",
        input_tokens: promptTokens,
        output_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
      ...(context?.requestId !== undefined ? { request_id: context.requestId } : {}),
      ...(context?.attemptId !== undefined ? { attempt_id: context.attemptId } : {}),
    });
  } catch {
    /* a misbehaving telemetry callback must not bleed into the response path */
  }
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
  exitCode: number | null,
  errorCode?: string,
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
    ok: errorCode === undefined,
    exit_code: exitCode,
    ...(errorCode !== undefined ? { error_code: errorCode } : {}),
  };
}

/**
 * Which abort source fired first — recorded so an aborted child can
 * be attributed back to the caller (their reason), a caller-supplied
 * deadline (TimeoutError), or the binding's own timeout (the legacy
 * 'timeout' wrap). An abort with no recorded source is
 * "unattributed" and maps to the binding timeout.
 */
type LinkedAbortSource = "caller" | "deadline" | "binding";

function timeoutError(): DOMException {
  return new DOMException("The operation timed out.", "TimeoutError");
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException("This operation was aborted", "AbortError");
}

function abortErrorCode(source: LinkedAbortSource | undefined): string {
  if (source === "caller") return "aborted";
  if (source === "deadline") return "deadline";
  return "timeout";
}

/**
 * Reject cancellation that pre-dates the spawn: an already-aborted
 * caller signal throws the caller's own reason (normally AbortError),
 * a deadline already in the past throws TimeoutError. Neither case
 * may spawn a child nor write a journal entry.
 */
function throwIfPreAborted(signal: AbortSignal | undefined, deadline: number | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
  if (deadline !== undefined && deadline <= Date.now()) throw timeoutError();
}

/**
 * Map a reaped-but-aborted child (or a non-zero exit) onto the call's
 * failure: caller cancellation rethrows the caller's reason, a
 * deadline produces TimeoutError, and the binding timer — or an abort
 * the spawner reports with no recorded source — keeps the legacy
 * 'timeout' wrap. Non-zero exits keep 'non-zero-exit'.
 */
function throwForAbortOrExit(
  providerId: string,
  opts: CliProviderOptions,
  spawnResult: SpawnResult,
  abortSource: LinkedAbortSource | undefined,
  callerSignal: AbortSignal | undefined,
): void {
  if (spawnResult.aborted) {
    if (abortSource === "caller") throw abortReason(callerSignal);
    if (abortSource === "deadline") throw timeoutError();
    throwCliError(providerId, opts, spawnResult, "timeout");
  }
  if (spawnResult.exitCode !== 0) {
    throwCliError(providerId, opts, spawnResult, "non-zero-exit");
  }
}

/**
 * Local AbortController: the binding timeout, the caller's signal,
 * and an optional absolute deadline all flip it; `source()` reports
 * which fired first. `cleanup` detaches timers + the listener.
 */
function createLinkedAbort(opts: {
  timeoutMs: number;
  callerSignal?: AbortSignal;
  deadline?: number;
}): {
  ctrl: AbortController;
  source: () => LinkedAbortSource | undefined;
  cleanup: () => void;
} {
  const ctrl = new AbortController();
  let fired: LinkedAbortSource | undefined;
  const record = (s: LinkedAbortSource): void => {
    fired ??= s;
    ctrl.abort();
  };
  const bindingTimer = setTimeout(() => {
    record("binding");
  }, opts.timeoutMs);
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  if (opts.deadline !== undefined) {
    const ms = opts.deadline - Date.now();
    if (ms <= 0) record("deadline");
    else {
      deadlineTimer = setTimeout(() => {
        record("deadline");
      }, ms);
    }
  }
  const onCallerAbort = (): void => {
    record("caller");
  };
  if (opts.callerSignal?.aborted) record("caller");
  else opts.callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  return {
    ctrl,
    source: () => fired,
    cleanup: (): void => {
      clearTimeout(bindingTimer);
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      opts.callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

/**
 * Journal + rethrow for a rejected spawn. First-source attribution
 * only: a deadline recorded before a late caller abort stays
 * 'deadline'; re-checking callerSignal.aborted here would mislabel
 * the ordering.
 */
async function journalSpawnFailure(
  opts: CliProviderOptions,
  providerId: string,
  journalWrite: (entry: CliJournalEntry) => Promise<void>,
  startedAt: number,
  prompt: string,
  err: unknown,
  src: LinkedAbortSource | undefined,
  callerSignal: AbortSignal | undefined,
): Promise<never> {
  const entry = buildCliJournalEntry(
    opts,
    startedAt,
    prompt,
    undefined,
    false,
    src === undefined ? undefined : abortErrorCode(src),
  );
  await journalWrite(entry);
  if (src === "caller") throw abortReason(callerSignal);
  if (src === "deadline") throw timeoutError();
  throw wrapCliError(providerId, err, src === "binding" ? "timeout" : "spawn-failed");
}

async function createCliResponse(
  opts: CliProviderOptions,
  providerId: string,
  spawn: SpawnFn,
  journalWrite: (entry: CliJournalEntry) => Promise<void>,
  request: UnifiedAiRequest,
  context?: ProviderExecutionContext,
): Promise<UnifiedAiResponse> {
  const callerSignal = context?.signal;
  // A call that is already cancelled never reaches the subprocess —
  // the caller's own reason for an aborted signal, TimeoutError for
  // a deadline already in the past. Neither spawns nor journals.
  throwIfPreAborted(callerSignal, context?.deadline);

  const resolved = resolvePreset(opts.binding);
  const prompt = messagesToPrompt(request.messages);
  const { args: expandedArgs, promptOnStdin } = expandArgs(resolved.args, prompt);
  const argv: SpawnArgv = [resolved.command, ...expandedArgs];
  const env = mergeEnv(opts.env ?? process.env, opts.binding.env);

  const { ctrl, source, cleanup } = createLinkedAbort({
    timeoutMs: opts.binding.timeoutMs,
    ...(callerSignal !== undefined ? { callerSignal } : {}),
    ...(context?.deadline !== undefined ? { deadline: context.deadline } : {}),
  });
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
    return await journalSpawnFailure(
      opts,
      providerId,
      journalWrite,
      startedAt,
      prompt,
      err,
      source(),
      callerSignal,
    );
  } finally {
    cleanup();
  }

  const abortSource = source();
  const entry = buildCliJournalEntry(
    opts,
    startedAt,
    prompt,
    spawnResult,
    !spawnResult.aborted && spawnResult.exitCode === 0,
    spawnResult.aborted ? abortErrorCode(abortSource) : undefined,
  );
  await journalWrite(entry);

  throwForAbortOrExit(providerId, opts, spawnResult, abortSource, callerSignal);

  const assistantContent = parseAssistantContent(spawnResult.stdout, resolved.format);
  return buildCliResponse(opts, startedAt, prompt, assistantContent, request.model, context);
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

/** Terminal error events after the child exits: timeout / non-zero-
 *  exit failures yield exactly one error event and NO `done` — a
 *  truncated run never masquerades as a completed stream. */
function* exitStreamErrorEvents(
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
    return;
  }
  yield {
    type: "error",
    error: {
      message: `cli provider '${providerId}' non-zero-exit ${String(exitCode)}: ${truncate(stderrText, 400)}`,
      code: "non-zero-exit",
    },
  };
}

interface CliStreamRead {
  responseBytes: number;
  readFailed: boolean;
  /** True when the drain ended before stdout reached EOF. */
  truncated: boolean;
}

/**
 * Drain the child's stdout into content chunks. Returns the byte
 * count + whether a transport (non-cancellation) read failure
 * occurred — a read failure yields its error event here, while a
 * caller abort that surfaces as a read rejection defers to the
 * caller's reap+journal+throw path.
 *
 * Once the child's exit is reaped, remaining stdout is buffered
 * output it already produced — a binding/deadline timer must not cut
 * that drain, or truncated output would masquerade as a clean run.
 * A caller abort still interrupts immediately.
 */
async function* readCliStreamChunks(
  stream: SpawnStreamResult,
  ctx: {
    ctrl: AbortController;
    source: () => LinkedAbortSource | undefined;
    callerSignal: AbortSignal | undefined;
    providerId: string;
    bytes: { n: number };
  },
  request: UnifiedAiRequest,
  startedAt: number,
  chunkId: string,
): AsyncGenerator<UnifiedStreamEvent, CliStreamRead, void> {
  let yieldedRole = false;
  // Ref object, not a bare boolean — the assignment lands inside a
  // promise callback, and a captured `let` would narrow to `false`
  // for the drain loop's lifetime.
  const childExit = { settled: false };
  void stream.exitedPromise.then(
    () => {
      childExit.settled = true;
    },
    () => {
      childExit.settled = true;
    },
  );
  let truncated = false;
  try {
    for await (const rawLine of stream.stdout) {
      if (ctx.source() === "caller" || (ctx.ctrl.signal.aborted && !childExit.settled)) {
        truncated = true;
        break;
      }
      // Re-attach the newline so concatenated deltas reconstruct
      // the original output. The final \n is trimmed in consumers
      // that display token-by-token.
      const delta = `${rawLine}\n`;
      ctx.bytes.n += Buffer.byteLength(delta, "utf8");
      yield buildContentChunk(chunkId, request.model, startedAt, delta, yieldedRole);
      yieldedRole = true;
    }
  } catch (err) {
    if (ctx.source() === "caller") {
      return { responseBytes: ctx.bytes.n, readFailed: false, truncated: true };
    }
    ctx.ctrl.abort();
    yield buildStreamErrorEvent(ctx.providerId, err);
    return { responseBytes: ctx.bytes.n, readFailed: true, truncated: true };
  }
  return { responseBytes: ctx.bytes.n, readFailed: false, truncated };
}

/** Journal error_code for a settled stream run — the same
 *  precedence the terminal-event logic applies. A clean exit
 *  (code 0) outranks a racing `aborted` flag: a kill that lands on
 *  an already-dead child did not truncate anything. */
function streamErrorCode(s: {
  callerAborted: boolean;
  readFailed: boolean;
  truncated: boolean;
  aborted: boolean;
  abortSource: LinkedAbortSource | undefined;
  exitCode: number;
}): string | undefined {
  if (s.callerAborted) return "aborted";
  if (s.readFailed) return "stream-failed";
  if (s.exitCode !== 0) return s.aborted ? abortErrorCode(s.abortSource) : "non-zero-exit";
  if (s.truncated) return "truncated";
  return undefined;
}

/**
 * Terminal events after the child is reaped + journalled. Caller
 * cancellation throws the caller's reason — it is not an in-stream
 * error event. A read failure already yielded its error during the
 * drain. The remaining failures yield exactly one error event and
 * NO done — a done after an error would present truncation as
 * success. Only a clean exit earns `done` + `completion: 'upstream'`.
 */
function* finishStreamEvents(s: {
  providerId: string;
  timeoutMs: number;
  exitCode: number;
  aborted: boolean;
  callerAborted: boolean;
  readFailed: boolean;
  truncated: boolean;
  stderrText: string;
  callerSignal: AbortSignal | undefined;
}): Generator<UnifiedStreamEvent, void, void> {
  if (s.callerAborted) throw abortReason(s.callerSignal);
  if (s.readFailed) return;
  if (s.exitCode !== 0) {
    yield* exitStreamErrorEvents(s.providerId, s.timeoutMs, s.exitCode, s.aborted, s.stderrText);
    return;
  }
  if (s.truncated) {
    yield {
      type: "error",
      error: {
        message: `cli provider '${s.providerId}' output truncated before EOF`,
        code: "truncated",
        retryable: false,
      },
    };
    return;
  }
  yield { type: "done", finish_reason: "stop", completion: "upstream" };
}

async function* streamCliResponse(
  opts: CliProviderOptions,
  providerId: string,
  spawnStream: SpawnStreamFn,
  journalWrite: (entry: CliJournalEntry) => Promise<void>,
  request: UnifiedAiRequest,
  callerSignal?: AbortSignal,
): AsyncGenerator<UnifiedStreamEvent, void, void> {
  // An already-aborted caller never reaches the subprocess — throw
  // the caller's reason before spawning (and before journaling).
  throwIfPreAborted(callerSignal, undefined);

  const resolved = resolvePreset(opts.binding);
  const prompt = messagesToPrompt(request.messages);
  const { args: expandedArgs, promptOnStdin } = expandArgs(resolved.args, prompt);
  const argv: SpawnArgv = [resolved.command, ...expandedArgs];
  const env = mergeEnv(opts.env ?? process.env, opts.binding.env);
  const { ctrl, source, cleanup } = createLinkedAbort({
    timeoutMs: opts.binding.timeoutMs,
    ...(callerSignal !== undefined ? { callerSignal } : {}),
  });
  const startedAt = Date.now();
  const chunkId = `cli-${randomUUID()}`;
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

  let childSettled = false;
  let exitCodeForJournal: number | null = null;
  let journaled = false;
  const readBytes = { n: 0 };
  try {
    const read = yield* readCliStreamChunks(
      stream,
      { ctrl, source, callerSignal, providerId, bytes: readBytes },
      request,
      startedAt,
      chunkId,
    );

    const { exitCode, aborted } = await stream.exitedPromise;
    childSettled = true;
    exitCodeForJournal = exitCode;
    const stderrText = await stream.stderrPromise;
    cleanup();

    // First-source attribution only — a late caller abort must not
    // rewrite a 'deadline'/'binding' cause recorded earlier.
    const abortSource = source();
    const callerAborted = abortSource === "caller";
    const errorCode = streamErrorCode({
      callerAborted,
      readFailed: read.readFailed,
      truncated: read.truncated,
      aborted,
      abortSource,
      exitCode,
    });
    await journalWrite(
      buildStreamJournalEntry(opts, startedAt, prompt, read.responseBytes, exitCode, errorCode),
    );
    journaled = true;

    yield* finishStreamEvents({
      providerId,
      timeoutMs: opts.binding.timeoutMs,
      exitCode,
      aborted,
      callerAborted,
      readFailed: read.readFailed,
      truncated: read.truncated,
      stderrText,
      callerSignal,
    });
  } finally {
    if (!childSettled) ctrl.abort();
    if (!journaled) {
      // Consumer detach (iterator.return/throw) or an abrupt reap
      // failure skips the normal journal path — record the attempt as
      // 'cancelled' so a mid-stream break can't vanish from the audit
      // trail.
      try {
        await journalWrite(
          buildStreamJournalEntry(
            opts,
            startedAt,
            prompt,
            readBytes.n,
            exitCodeForJournal,
            "cancelled",
          ),
        );
      } catch {
        /* teardown must not throw */
      }
    }
    cleanup();
  }
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
    createResponse: (request, context) =>
      createCliResponse(opts, providerId, spawn, journalWrite, request, context),

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
  if (typeof obj["response"] === "string") return obj["response"];
  if (typeof obj["content"] === "string") return obj["content"];
  const choices = obj["choices"];
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
/**
 * Grace window between the abort's SIGTERM and the SIGKILL
 * escalation. A child that traps or ignores SIGTERM (a wedged
 * subscription CLI sitting in a signal handler) must still die so
 * `createResponse` / `streamResponse` settle within timeout + grace.
 * Overridable per-spawn via `opts.killGraceMs` for tests.
 */
export const CLI_KILL_GRACE_MS = 250;

function killWithEscalation(proc: BunChildProcess, graceMs: number): void {
  try {
    proc.kill("SIGTERM");
  } catch {
    /* already exited */
  }
  const timer = setTimeout(() => {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already exited */
    }
  }, graceMs);
  (timer as unknown as { unref?: () => void }).unref?.();
  void proc.exited.then(
    () => {
      clearTimeout(timer);
    },
    () => {
      clearTimeout(timer);
    },
  );
}

export const defaultBunSpawnStream: SpawnStreamFn = (argv, opts) => {
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
    killWithEscalation(proc, opts.killGraceMs ?? CLI_KILL_GRACE_MS);
  };
  opts.signal.addEventListener("abort", onAbort, { once: true });
  // A signal aborted before the listener attached never fires the
  // 'abort' event — kill the just-spawned child immediately.
  if (opts.signal.aborted) onAbort();

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

export const defaultBunSpawn: SpawnFn = async (argv, opts) => {
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
    killWithEscalation(proc, opts.killGraceMs ?? CLI_KILL_GRACE_MS);
  };
  opts.signal.addEventListener("abort", onAbort, { once: true });
  // Same pre-aborted-signal guard as the streaming spawner — the
  // child must not outlive an already-fired cancellation.
  if (opts.signal.aborted) onAbort();
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
