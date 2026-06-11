import type { CompositeSpecShape } from "./types";

export function countComponents(spec: CompositeSpecShape): number {
  return spec.services.length + spec.workloads.length + spec.ragNodes.length + spec.gateways.length;
}

export function formatTimestamp(iso: string | undefined): string {
  if (!iso) return "--";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function redactEndpoint(raw: string | undefined): string {
  if (!raw) return "--";
  try {
    const u = new URL(raw);
    u.username = "";
    u.password = "";
    u.search = "";
    return u.toString();
  } catch {
    if (/^[a-z0-9.-]+:\d+$/i.test(raw)) return raw;
    return "(redacted)";
  }
}

export function rewriteRuntimeInYaml(
  yaml: string,
  choice: "auto" | "docker" | "kubernetes",
): string {
  const ACTIVE = /^(\s{2})runtime:\s*(docker|kubernetes)\s*$/m;
  const COMMENTED = /^(\s{2})#\s*runtime:.*$/m;
  if (choice === "auto") {
    if (ACTIVE.test(yaml))
      return yaml.replace(ACTIVE, "$1# runtime: docker        # or kubernetes");
    return yaml;
  }
  if (ACTIVE.test(yaml)) return yaml.replace(ACTIVE, `$1runtime: ${choice}`);
  if (COMMENTED.test(yaml)) return yaml.replace(COMMENTED, `$1runtime: ${choice}`);
  return yaml.replace(/^(spec:\s*)$/m, `$1\n  runtime: ${choice}`);
}
