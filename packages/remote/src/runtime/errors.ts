/**
 * Typed errors for container-runtime backends. Each backend — today
 * DockerBackend, tomorrow KubernetesBackend — translates its native
 * failure modes (ECONNREFUSED on the daemon socket, image-manifest
 * missing for this platform, container-create 409, …) into one of
 * these codes so the composite applier + UI get a stable surface.
 *
 *   - `backend-unreachable`  — daemon / control plane not reachable
 *     (socket ENOENT, ECONNREFUSED, handshake failure).
 *   - `image-pull-failed`    — registry refused the pull or network
 *     dropped mid-stream.
 *   - `create-failed`        — daemon accepted the request but could
 *     not create the container (409 name conflict that can't be
 *     reconciled, 400 bad config, 500 internal).
 *   - `start-failed`         — container created but refused to start.
 *   - `not-found`            — container / image lookup 404.
 *   - `platform-mismatch`    — image manifest has no variant for this
 *     host's OS+arch. Surfaced clearly so operators on Apple Silicon
 *     see it rather than a cryptic daemon error.
 *   - `spec-invalid`         — caller-supplied deployment spec cannot
 *     be translated (e.g., empty image tag).
 */
export type RuntimeErrorCode =
  | 'backend-unreachable'
  | 'image-pull-failed'
  | 'create-failed'
  | 'start-failed'
  | 'not-found'
  | 'platform-mismatch'
  | 'spec-invalid';

export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;
  override readonly cause?: unknown;
  constructor(code: RuntimeErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'RuntimeError';
    this.code = code;
    this.cause = cause;
  }
}
