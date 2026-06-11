import type { FormState, SourceState } from "./pipeline-types";

export function parseTagString(raw: string): Record<string, unknown> | undefined {
  if (!raw.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    const out: Record<string, string> = {};
    for (const pair of raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      const eq = pair.indexOf("=");
      if (eq > 0) out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
    if (Object.keys(out).length > 0) return out;
  }
  return undefined;
}

export function buildSource(s: SourceState): Record<string, unknown> {
  const tag = s.tag ? parseTagString(s.tag) : undefined;
  if (s.kind === "filesystem")
    return {
      kind: "filesystem",
      root: s.root.trim(),
      glob: s.glob.trim() || "**/*",
      ...(tag ? { tag } : {}),
    };
  if (s.kind === "http") {
    const out: Record<string, unknown> = {
      kind: "http",
      url: s.url.trim(),
      max_depth: s.max_depth,
      same_origin: s.same_origin,
      ignore_robots: s.ignore_robots,
      rate_limit_per_sec: s.rate_limit_per_sec,
      timeout_ms: s.timeout_ms,
    };
    if (s.tokenRef?.trim()) out.auth = { tokenRef: s.tokenRef.trim() };
    if (tag) out.tag = tag;
    return out;
  }
  const out: Record<string, unknown> = {
    kind: "git",
    repo: s.repo.trim(),
    glob: s.glob.trim() || "**/*.md",
  };
  if (s.ref?.trim()) out.ref = s.ref.trim();
  if (s.subpath?.trim()) out.subpath = s.subpath.trim();
  if (s.tokenRef?.trim()) out.auth = { tokenRef: s.tokenRef.trim() };
  if (tag) out.tag = tag;
  return out;
}

export function buildManifest(form: FormState): unknown {
  const spec: Record<string, unknown> = {
    destination: { ragNode: form.ragNode.trim(), collection: form.collection.trim() },
    sources: form.sources.map((s) => buildSource(s)),
    transforms: [
      {
        kind: "markdown-chunk",
        chunk_size: form.transform.chunk_size,
        overlap: form.transform.overlap,
        preserve_headings: form.transform.preserve_headings,
      },
    ],
    on_duplicate: form.on_duplicate,
  };
  if (form.schedule.trim()) spec.schedule = form.schedule.trim();
  return {
    apiVersion: "llamactl/v1",
    kind: "RagPipeline",
    metadata: { name: form.name.trim() },
    spec,
  };
}

export function validate(form: FormState): string[] {
  const errs: string[] = [];
  if (!form.name.trim()) errs.push("name is required");
  if (!form.ragNode.trim()) errs.push("destination.ragNode is required");
  if (!form.collection.trim()) errs.push("destination.collection is required");
  if (form.sources.length === 0) errs.push("at least one source is required");
  for (const [i, s] of form.sources.entries()) {
    if (s.kind === "filesystem" && !s.root.trim())
      errs.push(`sources[${String(i)}].root is required`);
    if (s.kind === "http" && !s.url.trim()) errs.push(`sources[${String(i)}].url is required`);
    if (s.kind === "git" && !s.repo.trim()) errs.push(`sources[${String(i)}].repo is required`);
  }
  return errs;
}
