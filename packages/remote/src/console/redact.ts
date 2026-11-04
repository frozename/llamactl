// Response redaction backstop for the #410 P2b console (plan §0.11).
// redactDeep is the last-line filter every allowlisted projection runs
// through: it masks secret-looking key names, URL userinfo and Bearer
// tokens recursively. The per-procedure projections themselves are
// module-internal to allowlist.ts and layer on top of this.

const REDACTED = "[redacted]";
const SECRET_KEY = /(?:key|token|secret|password)/i;
const KEPT_CERT_KEYS = new Set(["certificate", "certificateFingerprint"]);
const USERINFO = /(?<=:\/\/)[^\s/?#@]*@/g;
const BEARER = /\bBearer\s+\S+/gi;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEmptyValue(value: unknown): boolean {
  return value === "" || value === null || value === undefined;
}

function redactString(value: string): string {
  return value.replaceAll(BEARER, `Bearer ${REDACTED}`).replaceAll(USERINFO, "");
}

function redactNode(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactNode);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] =
        SECRET_KEY.test(key) && !KEPT_CERT_KEYS.has(key) && !isEmptyValue(inner)
          ? REDACTED
          : redactNode(inner);
    }
    return out;
  }
  return value;
}

export function redactDeep<T>(value: T): T {
  return redactNode(value) as T;
}
