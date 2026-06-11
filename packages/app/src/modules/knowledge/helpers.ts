import type { IndexDocumentInput } from "./types";

export function formatScore(score: number): string {
  const clamped = Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0;
  return `${(clamped * 100).toFixed(1)}%`;
}

export function scoreBadgeClass(score: number): string {
  if (!Number.isFinite(score))
    return "bg-[var(--color-surface-2)] text-[color:var(--color-text-secondary)]";
  if (score >= 0.75) return "bg-[var(--color-brand)] text-[color:var(--color-brand-contrast)]";
  if (score >= 0.45)
    return "bg-[var(--color-warn,var(--color-ok))] text-[color:var(--color-text-inverse)]";
  return "bg-[var(--color-surface-2)] text-[color:var(--color-text-secondary)]";
}

export function truncateContent(content: string, max = 300): string {
  if (content.length <= max) return content;
  return `${content.slice(0, max).trimEnd()}…`;
}

type ParseIndexResult = {
  documents: IndexDocumentInput[];
  error: string | null;
};

function isInvalidDocEntry(entry: unknown): boolean {
  return (
    !entry ||
    typeof entry !== "object" ||
    typeof (entry as { id?: unknown }).id !== "string" ||
    typeof (entry as { content?: unknown }).content !== "string"
  );
}

function toIndexDocument(entry: unknown): IndexDocumentInput {
  const e = entry as { id: string; content: string; metadata?: Record<string, unknown> };
  return {
    id: e.id,
    content: e.content,
    metadata: e.metadata && typeof e.metadata === "object" ? e.metadata : undefined,
  };
}

function parseJsonDocuments(trimmed: string): ParseIndexResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return { documents: [], error: `Invalid JSON: ${(err as Error).message}` };
  }
  if (!Array.isArray(parsed)) {
    return {
      documents: [],
      error: "JSON input must be an array of {id, content, metadata?} objects.",
    };
  }
  const docs: IndexDocumentInput[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const entry: unknown = parsed[i];
    if (isInvalidDocEntry(entry)) {
      return {
        documents: [],
        error: `Entry [${String(i)}] must have string 'id' and string 'content' fields.`,
      };
    }
    docs.push(toIndexDocument(entry));
  }
  if (docs.length === 0) return { documents: [], error: "JSON array is empty." };
  return { documents: docs, error: null };
}

function parseParagraphDocuments(trimmed: string): ParseIndexResult {
  const paragraphs = trimmed
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (paragraphs.length === 0) return { documents: [], error: "No paragraphs found." };
  const docs: IndexDocumentInput[] = paragraphs.map((content) => {
    const uuid =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID().slice(0, 8)
        : Math.random().toString(36).slice(2, 10);
    return { id: `doc-${uuid}`, content };
  });
  return { documents: docs, error: null };
}

export function parseIndexInput(raw: string): ParseIndexResult {
  const trimmed = raw.trim();
  if (!trimmed) return { documents: [], error: "Input is empty." };
  if (trimmed.startsWith("[")) return parseJsonDocuments(trimmed);
  return parseParagraphDocuments(trimmed);
}
