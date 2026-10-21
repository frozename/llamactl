/**
 * Shared fake engine for the InferenceRpcV1 suites (P4.1, #139): a
 * random-port OpenAI-compatible server that streams scripted chat chunks
 * and records every request and every client abort. Ids and timestamps
 * are fixed so recorded exchanges stay byte-stable for golden.json.
 */

export const FAKE_ENGINE_CHUNK_ID = "chatcmpl-fake-1";
export const FAKE_ENGINE_CREATED = 1_700_000_000;
export const FAKE_ENGINE_USAGE = { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 };

export interface FakeEngineRequest {
  path: string;
  body: Record<string, unknown> | null;
  authorization: string | null;
}

export interface FakeEngineScript {
  /** Content deltas, one chunk each. */
  pieces: readonly string[];
  /** Stream this many pieces, then hold the response open until the client aborts. */
  holdAfter?: number;
  /** End the body after the pieces with no finish_reason and no [DONE]. */
  truncate?: boolean;
  /** Answer with this HTTP error status instead of a stream. */
  status?: number;
}

export interface FakeEngine {
  readonly url: string;
  readonly requests: FakeEngineRequest[];
  /** Requests whose stream the client tore down before it finished. */
  aborts(): number;
  /** Resolves once the next client abort lands. */
  nextAbort(): Promise<void>;
  setScript(script: Partial<FakeEngineScript>): void;
  reset(): void;
  stop(): Promise<void>;
}

const DEFAULT_SCRIPT: FakeEngineScript = { pieces: ["Hel", "lo"] };

function sseData(value: unknown): string {
  return `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`;
}

function chunk(model: string, delta: Record<string, unknown>, finish: string | null): unknown {
  return {
    id: FAKE_ENGINE_CHUNK_ID,
    object: "chat.completion.chunk",
    created: FAKE_ENGINE_CREATED,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

function scriptFrames(script: FakeEngineScript, body: Record<string, unknown> | null): string[] {
  const model = typeof body?.["model"] === "string" ? body["model"] : "unknown";
  const frames = script.pieces.map((piece, i) =>
    sseData(
      chunk(model, i === 0 ? { role: "assistant", content: piece } : { content: piece }, null),
    ),
  );
  if (script.truncate === true) return frames;
  frames.push(sseData(chunk(model, {}, "stop")));
  const options = body?.["stream_options"] as { include_usage?: unknown } | undefined;
  if (options?.include_usage === true) {
    frames.push(
      sseData({
        id: FAKE_ENGINE_CHUNK_ID,
        object: "chat.completion.chunk",
        created: FAKE_ENGINE_CREATED,
        model,
        choices: [],
        usage: FAKE_ENGINE_USAGE,
      }),
    );
  }
  frames.push(sseData("[DONE]"));
  return frames;
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function startFakeEngine(): FakeEngine {
  const requests: FakeEngineRequest[] = [];
  let script: FakeEngineScript = { ...DEFAULT_SCRIPT };
  let aborts = 0;
  let abortWaiters: (() => void)[] = [];
  const encoder = new TextEncoder();

  const recordAbort = (): void => {
    aborts += 1;
    const waiters = abortWaiters;
    abortWaiters = [];
    for (const resolve of waiters) resolve();
  };

  const streamFor = (req: Request, body: Record<string, unknown> | null): ReadableStream => {
    const frames = scriptFrames(script, body);
    const hold = script.holdAfter;
    let finished = false;
    let aborted = false;
    const markAborted = (): void => {
      if (finished || aborted) return;
      aborted = true;
      recordAbort();
    };
    req.signal.addEventListener("abort", markAborted, { once: true });
    return new ReadableStream({
      start(controller): void {
        const sent = hold === undefined ? frames : frames.slice(0, hold);
        for (const frame of sent) controller.enqueue(encoder.encode(frame));
        if (hold !== undefined) return;
        finished = true;
        controller.close();
      },
      cancel: markAborted,
    });
  };

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req: Request): Promise<Response> {
      const path = new URL(req.url).pathname;
      const body = await readJson(req);
      requests.push({ path, body, authorization: req.headers.get("authorization") });
      if (script.status !== undefined) {
        return Response.json(
          { error: { message: "fake engine failure" } },
          { status: script.status },
        );
      }
      return new Response(streamFor(req, body), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });

  return {
    url: `http://127.0.0.1:${String(server.port)}`,
    requests,
    aborts: (): number => aborts,
    nextAbort: (): Promise<void> =>
      new Promise((resolve) => {
        abortWaiters.push(resolve);
      }),
    setScript: (next): void => {
      script = { ...DEFAULT_SCRIPT, ...next };
    },
    reset: (): void => {
      requests.length = 0;
      aborts = 0;
      script = { ...DEFAULT_SCRIPT };
    },
    stop: async (): Promise<void> => {
      await server.stop(true);
    },
  };
}
