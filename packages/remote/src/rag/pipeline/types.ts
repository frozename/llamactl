/**
 * Runtime contracts shared between fetchers, transforms, and the
 * orchestrator. A pipeline is a flat producer/transformer graph:
 * a Fetcher emits RawDocs for a source, one or more Transforms
 * reshape that stream (chunking fans a doc out to many), and the
 * runtime batches the tail into the rag adapter's store().
 */

export interface RawDoc {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
}

export type LogEvent = {
  level: 'info' | 'warn' | 'error';
  msg: string;
  data?: unknown;
};

export interface FetcherContext {
  /** Source-kind-specific, pre-parsed by the caller's zod schema. */
  spec: unknown;
  log: (event: LogEvent) => void;
  signal: AbortSignal;
  /** Process env — used by fetchers that resolve secret refs. */
  env: NodeJS.ProcessEnv;
}

export interface Fetcher {
  kind: string;
  fetch(ctx: FetcherContext): AsyncIterable<RawDoc>;
}

export interface Transform {
  kind: string;
  transform(
    docs: AsyncIterable<RawDoc>,
    spec: unknown,
  ): AsyncIterable<RawDoc>;
}
