/**
 * Thin fetch wrapper around the Docker Engine API.
 *
 * Transport: Bun's native `fetch({ unix: '/var/run/docker.sock' })`
 * (https://bun.sh/docs/api/fetch). No `dockerode`, no `docker-modem`
 * — the engine API is a simple REST surface and we only need ~8
 * endpoints; a library would outweigh them.
 *
 * The host portion of the URL is irrelevant when `unix` is set;
 * Docker uses the path + query only. Convention: `http://docker/...`
 * keeps error messages readable.
 *
 * Error mapping: every non-2xx response body is parsed as
 * `{ message: string }` (per swagger — every error uses
 * `ErrorResponse`) and surfaced as a `RuntimeError`. Network
 * failures (ENOENT on socket path, ECONNREFUSED) map to
 * `'backend-unreachable'`.
 *
 * All endpoints in this module cite their swagger operationId. The
 * authoritative source is `moby/moby/api/swagger.yaml` at basePath
 * `/v1.54`.
 */
import { RuntimeError, type RuntimeErrorCode } from '../errors.js';

/**
 * Docker Engine API version we target. Stable across Docker Desktop
 * 4.x and Engine 24.x; older engines fall back transparently.
 */
export const DOCKER_API_VERSION = 'v1.54';

/**
 * Default socket path on macOS (Docker Desktop exposes a VM proxy
 * here) and Linux. Operators on Podman can set `DOCKER_HOST` to
 * their podman-machine socket — the Podman REST API is
 * Docker-compatible.
 */
export const DEFAULT_SOCKET_PATH = '/var/run/docker.sock';

export interface DockerClientOptions {
  socketPath?: string;
  /** Override fetch — used by tests. Defaults to global `fetch`. */
  fetch?: typeof fetch;
}

export interface DockerClient {
  readonly socketPath: string;
  /**
   * Issue a request against the Engine API. `path` is relative to
   * the version prefix — callers pass `/containers/json`, not
   * `/v1.54/containers/json`.
   */
  request(
    path: string,
    init?: RequestInit & { query?: Record<string, string | number | boolean | undefined> },
  ): Promise<Response>;
}

export function createDockerClient(opts: DockerClientOptions = {}): DockerClient {
  const socketPath = opts.socketPath ?? process.env.DOCKER_SOCKET ?? DEFAULT_SOCKET_PATH;
  const fetchImpl = opts.fetch ?? fetch;

  return {
    socketPath,
    async request(path, init = {}) {
      const { query, ...rest } = init;
      const qs = query ? encodeQuery(query) : '';
      const url = `http://docker/${DOCKER_API_VERSION}${path}${qs}`;
      try {
        // Bun's fetch accepts `unix` to bind HTTP over a unix
        // socket. The TypeScript lib.dom types don't surface it yet,
        // so the cast is load-bearing — don't "clean it up".
        const res = await fetchImpl(url, {
          ...rest,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          unix: socketPath,
        } as RequestInit);
        return res;
      } catch (err) {
        throw wrapTransportError(err, socketPath);
      }
    },
  };
}

function encodeQuery(q: Record<string, string | number | boolean | undefined>): string {
  const entries = Object.entries(q).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return '';
  const sp = new URLSearchParams();
  for (const [k, v] of entries) sp.set(k, String(v));
  return `?${sp.toString()}`;
}

function wrapTransportError(err: unknown, socketPath: string): RuntimeError {
  const msg = (err as Error)?.message ?? String(err);
  // ENOENT = socket missing entirely (Docker not installed / stopped).
  // ECONNREFUSED = socket present but daemon isn't accepting.
  const code: 'backend-unreachable' = 'backend-unreachable';
  return new RuntimeError(
    code,
    `docker daemon unreachable (${msg})`,
    { socketPath, cause: err },
  );
}

/**
 * Read a JSON body from a Docker response. On non-2xx, surface the
 * `{ message }` field as a `RuntimeError` with the caller-supplied
 * code. Swagger: every error response uses schema `ErrorResponse`
 * with a single `message` string.
 */
export async function parseJsonOrThrow<T>(
  res: Response,
  errorCode: RuntimeErrorCode,
  context: string,
): Promise<T> {
  if (res.ok) {
    // Some endpoints (204, 304) return empty bodies. Defensive parse.
    const text = await res.text();
    if (text.length === 0) return undefined as unknown as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new RuntimeError('create-failed', `invalid JSON from docker (${context})`);
    }
  }
  throw await failWith(errorCode, res, context);
}

export async function failWith(
  code: RuntimeErrorCode,
  res: Response,
  context: string,
): Promise<RuntimeError> {
  const body = await res.text().catch(() => '');
  let message = body;
  try {
    const parsed = JSON.parse(body) as { message?: string };
    if (parsed.message) message = parsed.message;
  } catch {
    // body wasn't JSON — keep the raw text
  }
  return new RuntimeError(
    code,
    `${context} failed (HTTP ${res.status}): ${message.slice(0, 300)}`,
  );
}

/**
 * Read a streaming NDJSON response to EOF, returning each decoded
 * line. Used by `POST /images/create` which streams progress as one
 * JSON object per line. Any line carrying `{ error: string }`
 * short-circuits with a `RuntimeError`.
 *
 * Swagger: `POST /images/create` response schema is
 * `ProgressDetail | ImagePullError`, NDJSON framed, content-type
 * `application/json`.
 */
export async function drainNdjson(
  res: Response,
  errorCode: 'image-pull-failed' | 'create-failed',
  context: string,
): Promise<Array<Record<string, unknown>>> {
  if (!res.ok) {
    throw await failWith(errorCode, res, context);
  }
  if (!res.body) return [];
  const lines: Array<Record<string, unknown>> = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let newline = buf.indexOf('\n');
    while (newline !== -1) {
      const line = buf.slice(0, newline).trim();
      buf = buf.slice(newline + 1);
      newline = buf.indexOf('\n');
      if (line.length === 0) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // malformed line — docker occasionally interleaves non-JSON progress
      }
      if (typeof parsed.error === 'string') {
        throw new RuntimeError(errorCode, `${context}: ${parsed.error}`);
      }
      lines.push(parsed);
    }
  }
  const trailing = buf.trim();
  if (trailing.length > 0) {
    try {
      const parsed = JSON.parse(trailing) as Record<string, unknown>;
      if (typeof parsed.error === 'string') {
        throw new RuntimeError(errorCode, `${context}: ${parsed.error}`);
      }
      lines.push(parsed);
    } catch {
      // ignore — trailing junk is common
    }
  }
  return lines;
}
