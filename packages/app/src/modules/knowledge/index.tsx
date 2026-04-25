import * as React from 'react';
import { useMemo, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { Badge, Button, StatusDot, Input, Kbd } from '@/ui';
import { PipelinesTab } from './pipelines-tab';
import { QualityTab } from './quality-tab';

/**
 * Knowledge module. First UI consumer of the RAG stack shipped in
 * Phase 4 (`ragSearch`, `ragStore`, `ragDelete`, `ragListCollections`
 * on the base tRPC router). Walks the `RetrievalProvider` methods in
 * a three-tab shape: Query / Collections / Indexing.
 *
 * The node picker is hoisted to the module root so the three tabs
 * share a single `nodeList` fetch. We never surface the node's
 * `endpoint` (could leak a Postgres URL with credentials) — only
 * `name`, `provider`, and `kind` are operator-safe.
 *
 * File upload with chunking is intentionally deferred to a follow-up
 * slice (see rag-nodes.md § "Follow-up slices"). v1 ships a plain
 * JSON / paragraph text area.
 */

type RagProviderKind = 'chroma' | 'pgvector';

interface EmbedderBinding {
  node: string;
  model: string;
}

type RagNodeSummary = {
  name: string;
  provider: RagProviderKind | null;
  kind: 'rag';
  embedder: EmbedderBinding | null;
};

interface AgentNodeSummary {
  name: string;
  endpoint: string;
}

type TabId = 'query' | 'collections' | 'indexing' | 'pipelines' | 'quality';

interface SearchResultDoc {
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
}

interface SearchResult {
  document: SearchResultDoc;
  score: number;
  distance?: number;
}

interface SearchResponse {
  results: SearchResult[];
  collection: string;
}

interface CollectionInfo {
  name: string;
  count?: number;
  dimensions?: number;
  metadata?: Record<string, unknown>;
}

interface ListCollectionsResponse {
  collections: CollectionInfo[];
}

interface StoreResponse {
  ids: string[];
  collection: string;
}

interface IndexDocumentInput {
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
}

/** Format a cosine-similarity score (0..1) as a percentage string. */
function formatScore(score: number): string {
  const clamped = Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0;
  return `${(clamped * 100).toFixed(1)}%`;
}

/** Classify score into a Tailwind badge palette matching the project conventions. */
function scoreBadgeClass(score: number): string {
  if (!Number.isFinite(score)) {
    return 'bg-[var(--color-surface-2)] text-[color:var(--color-text-secondary)]';
  }
  if (score >= 0.75) {
    return 'bg-[var(--color-brand)] text-[color:var(--color-brand-contrast)]';
  }
  if (score >= 0.45) {
    return 'bg-[var(--color-warn,var(--color-ok))] text-[color:var(--color-text-inverse)]';
  }
  return 'bg-[var(--color-surface-2)] text-[color:var(--color-text-secondary)]';
}

function truncateContent(content: string, max = 300): string {
  if (content.length <= max) return content;
  return `${content.slice(0, max).trimEnd()}…`;
}

/**
 * Parse the Indexing tab's free-form input.
 *
 *   - If the trimmed text starts with `[`, treat as JSON array; each
 *     entry must carry `id` + `content` (metadata is optional).
 *   - Otherwise split on blank lines (`\n\n`), one paragraph per doc,
 *     auto-generating `doc-<8-char-uuid>` IDs.
 */
function parseIndexInput(raw: string): {
  documents: IndexDocumentInput[];
  error: string | null;
} {
  const trimmed = raw.trim();
  if (!trimmed) return { documents: [], error: 'Input is empty.' };

  if (trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      return {
        documents: [],
        error: `Invalid JSON: ${(err as Error).message}`,
      };
    }
    if (!Array.isArray(parsed)) {
      return {
        documents: [],
        error: 'JSON input must be an array of {id, content, metadata?} objects.',
      };
    }
    const docs: IndexDocumentInput[] = [];
    for (let i = 0; i < parsed.length; i++) {
      const entry = parsed[i];
      if (
        !entry ||
        typeof entry !== 'object' ||
        typeof (entry as { id?: unknown }).id !== 'string' ||
        typeof (entry as { content?: unknown }).content !== 'string'
      ) {
        return {
          documents: [],
          error: `Entry [${i}] must have string 'id' and string 'content' fields.`,
        };
      }
      const e = entry as {
        id: string;
        content: string;
        metadata?: Record<string, unknown>;
      };
      docs.push({
        id: e.id,
        content: e.content,
        metadata:
          e.metadata && typeof e.metadata === 'object' ? e.metadata : undefined,
      });
    }
    if (docs.length === 0) {
      return { documents: [], error: 'JSON array is empty.' };
    }
    return { documents: docs, error: null };
  }

  const paragraphs = trimmed
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (paragraphs.length === 0) {
    return { documents: [], error: 'No paragraphs found.' };
  }
  const docs: IndexDocumentInput[] = paragraphs.map((content) => {
    const uuid =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID().slice(0, 8)
        : Math.random().toString(36).slice(2, 10);
    return { id: `doc-${uuid}`, content };
  });
  return { documents: docs, error: null };
}

/**
 * Query tab. Runs a single `ragSearch` on submit. Uses the
 * `trpc.useUtils()` imperative fetcher (same pattern as workloads /
 * nodes / bench) because the procedure is a tRPC `.query` and we
 * want to assemble the input at submit time rather than binding it
 * to hook-render order.
 */
/**
 * Collection header — shows count / dimensions / embedder for the
 * currently-targeted collection so the operator can see, BEFORE
 * running a query, whether the collection is empty, what embedder
 * produced the vectors, and whether the pgvector binding is missing
 * its embedder (queries will fail otherwise). Surfaces CollectionInfo
 * fields that the Collections tab already shows in a table form but
 * were invisible from the Query tab.
 */
function CollectionHeader(props: {
  nodeName: string;
  collection: string;
  embedder: EmbedderBinding | null;
  provider: RagProviderKind | null;
}): React.JSX.Element | null {
  const { nodeName, collection, embedder, provider } = props;
  const list = trpc.ragListCollections.useQuery(
    { node: nodeName },
    { enabled: !!nodeName, retry: false },
  );
  const data = list.data as ListCollectionsResponse | undefined;
  const rows = data?.collections ?? [];
  // Targeted collection: explicit `collection` if matches a row, else
  // the first collection the node reports (matches the node-default
  // adapters fall back to on search).
  const targeted = collection.trim()
    ? rows.find((c) => c.name === collection.trim()) ?? null
    : rows[0] ?? null;
  if (list.isLoading) {
    return (
      <div
        className="rounded-md border border-dashed border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-2  text-[color:var(--color-text-secondary)]" style={{ fontSize: 12 }}
        data-testid="knowledge-collection-header"
      >
        Loading collection info…
      </div>
    );
  }
  if (list.error) {
    return null;
  }
  if (!targeted) {
    return (
      <div
        className="rounded-md border border-dashed border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-2  text-[color:var(--color-text-secondary)]" style={{ fontSize: 12 }}
        data-testid="knowledge-collection-header"
      >
        No collection picked yet — switch to the Collections tab to see what's
        available on <Badge variant="default" className="mono">{nodeName}</Badge>.
      </div>
    );
  }
  const count = typeof targeted.count === 'number' ? targeted.count : null;
  const dims = typeof targeted.dimensions === 'number' ? targeted.dimensions : null;
  const warnings: string[] = [];
  if (count === 0) {
    warnings.push(
      'collection is empty — index documents in the Indexing tab before querying',
    );
  }
  if (!embedder && provider === 'pgvector') {
    warnings.push(
      'no embedder bound on this pgvector node — queries will fail. Bind one in the panel above.',
    );
  }
  const metaEntries = targeted.metadata
    ? Object.entries(targeted.metadata as Record<string, unknown>)
    : [];
  return (
    <div
      className="space-y-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3"
      data-testid="knowledge-collection-header"
    >
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1  text-[color:var(--color-text-secondary)]" style={{ fontSize: 12 }}>
        <span>
          collection{' '}
          <span
            className="mono text-[color:var(--color-text)]"
            data-testid="knowledge-collection-name"
          >
            {targeted.name}
          </span>
        </span>
        <span>
          count{' '}
          <span
            className="mono text-[color:var(--color-text)]"
            data-testid="knowledge-collection-count"
          >
            {count !== null ? count.toLocaleString() : '—'}
          </span>
        </span>
        <span>
          dims{' '}
          <span
            className="mono text-[color:var(--color-text)]"
            data-testid="knowledge-collection-dims"
          >
            {dims !== null ? dims : '—'}
          </span>
        </span>
        <span>
          embedder{' '}
          {embedder ? (
            <span
              className="mono text-[color:var(--color-text)]"
              data-testid="knowledge-collection-embedder"
            >
              {embedder.node}/{embedder.model}
            </span>
          ) : (
            <span
              className="mono text-[color:var(--color-text-secondary)]"
              data-testid="knowledge-collection-embedder"
            >
              none
            </span>
          )}
        </span>
      </div>
      {metaEntries.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {metaEntries.map(([k, v]) => (
            <span
              key={k}
              className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1.5 py-0.5 mono text-[10px] text-[color:var(--color-text-secondary)]"
            >
              {k}: {typeof v === 'string' ? v : JSON.stringify(v)}
            </span>
          ))}
        </div>
      )}
      {warnings.length > 0 && (
        <ul
          className="space-y-0.5  text-[color:var(--color-warn,var(--color-ok))]" style={{ fontSize: 12 }}
          data-testid="knowledge-collection-warnings"
        >
          {warnings.map((w, i) => (
            <li key={i}>⚠ {w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function QueryTab(props: {
  nodeName: string;
  collection: string;
  onCollectionChange: (value: string) => void;
  embedder: EmbedderBinding | null;
  provider: RagProviderKind | null;
}): React.JSX.Element {
  const { nodeName, collection, onCollectionChange, embedder, provider } = props;
  const utils = trpc.useUtils();
  const [query, setQuery] = useState('');
  const [topK, setTopK] = useState(10);
  const [filterText, setFilterText] = useState('');
  const [filterError, setFilterError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [openResult, setOpenResult] = useState<string | null>(null);
  const [lastResponse, setLastResponse] = useState<SearchResponse | null>(null);
  const [isSearching, setIsSearching] = useState(false);

  async function onSubmit(): Promise<void> {
    setSubmitError(null);
    setFilterError(null);
    const q = query.trim();
    if (!q) {
      setSubmitError('Query text is required.');
      return;
    }

    let parsedFilter: Record<string, unknown> | undefined;
    if (filterText.trim()) {
      try {
        const value: unknown = JSON.parse(filterText);
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          setFilterError('Filter must be a JSON object.');
          return;
        }
        parsedFilter = value as Record<string, unknown>;
      } catch (err) {
        setFilterError(`Invalid JSON: ${(err as Error).message}`);
        return;
      }
    }

    const input: {
      node: string;
      query: string;
      topK: number;
      collection?: string;
      filter?: Record<string, unknown>;
    } = { node: nodeName, query: q, topK };
    if (collection.trim()) input.collection = collection.trim();
    if (parsedFilter) input.filter = parsedFilter;

    setIsSearching(true);
    try {
      const response = await utils.ragSearch.fetch(input);
      setLastResponse(response as SearchResponse);
    } catch (err) {
      setLastResponse(null);
      setSubmitError((err as Error).message);
    } finally {
      setIsSearching(false);
    }
  }

  const results = lastResponse?.results ?? [];

  return (
    <div className="space-y-4">
      <CollectionHeader
        nodeName={nodeName}
        collection={collection}
        embedder={embedder}
        provider={provider}
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void onSubmit();
        }}
        className="space-y-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-4"
        data-testid="knowledge-query-form"
      >
        <label className="block " style={{ fontSize: 14 }}>
          <span className="mb-1 block  text-[color:var(--color-text-secondary)]" style={{ fontSize: 12 }}>
            Query
          </span>
          <textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Ask the knowledge base…"
            rows={3}
            className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono text-[color:var(--color-text)]"
          />
        </label>
        <div className="grid grid-cols-12 gap-3">
          <label className="col-span-4 " style={{ fontSize: 14 }}>
            <span className="mb-1 block  text-[color:var(--color-text-secondary)]" style={{ fontSize: 12 }}>
              topK ({topK})
            </span>
            <Input
              type="range"
              min={1}
              max={100}
              value={topK}
              onChange={(e) => setTopK(Math.max(1, Number(e.target.value) || 10))}
              className="w-full"
            />
          </label>
          <label className="col-span-4 " style={{ fontSize: 14 }}>
            <span className="mb-1 block  text-[color:var(--color-text-secondary)]" style={{ fontSize: 12 }}>
              Collection (optional)
            </span>
            <Input
              type="text"
              value={collection}
              onChange={(e) => onCollectionChange(e.target.value)}
              placeholder="defaults to node's collection"
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono text-[color:var(--color-text)]"
            />
          </label>
          <div className="col-span-4 flex items-end">
            <Button variant="primary" size="sm"
              type="submit"
              disabled={isSearching}
              data-testid="knowledge-query-submit"
              
            >
              {isSearching ? 'Searching…' : 'Search'}
            </Button>
          </div>
        </div>
        <label className="block " style={{ fontSize: 14 }}>
          <span className="mb-1 block  text-[color:var(--color-text-secondary)]" style={{ fontSize: 12 }}>
            Filter (metadata JSON, optional)
          </span>
          <Input
            type="text"
            value={filterText}
            onChange={(e) => {
              setFilterText(e.target.value);
              setFilterError(null);
            }}
            placeholder='e.g. {"source":"docs","lang":"en"}'
            className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono text-[color:var(--color-text)]"
          />
          {filterError && (
            <span className="mt-1 block  text-[color:var(--color-err)]" style={{ fontSize: 12 }}>
              {filterError}
            </span>
          )}
        </label>
      </form>

      {submitError && (
        <div
          className="rounded-md border border-[var(--color-err)] bg-[var(--color-surface-1)] px-3 py-2  text-[color:var(--color-err)]" style={{ fontSize: 14 }}
          data-testid="knowledge-query-error"
        >
          Failed to reach <Badge variant="default" className="mono">{nodeName}</Badge>: {submitError}
        </div>
      )}

      {lastResponse && !submitError && (
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3  text-[color:var(--color-text-secondary)]" style={{ fontSize: 12 }}>
          <span>
            {results.length} result{results.length === 1 ? '' : 's'}
          </span>
          <span> · collection </span>
          <Badge variant="default" className="mono">{lastResponse.collection}
          </Badge>
        </div>
      )}

      <div className="space-y-2" data-testid="knowledge-query-results">
        {results.length === 0 && lastResponse && (
          <div className="rounded-md border border-dashed border-[var(--color-border)] p-4  text-[color:var(--color-text-secondary)]" style={{ fontSize: 14 }}>
            No results. Try lowering the similarity threshold or widening the query.
          </div>
        )}
        {results.map((r, i) => {
          const key = `${r.document.id}-${i}`;
          const isOpen = openResult === key;
          const hasMeta =
            !!r.document.metadata &&
            Object.keys(r.document.metadata).length > 0;
          return (
            <div
              key={key}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3"
            >
              <div className="flex items-baseline justify-between gap-3">
                <div className="flex items-baseline gap-2">
                  <span
                    className={`rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] ${scoreBadgeClass(r.score)}`}
                    title={`score ${r.score.toFixed(6)}${typeof r.distance === 'number' ? ` · distance ${r.distance.toFixed(6)}` : ''}`}
                  >
                    {formatScore(r.score)}
                  </span>
                  <Badge variant="default" className="mono">{r.document.id}
                  </Badge>
                  {typeof r.distance === 'number' && (
                    <span className="text-[10px] text-[color:var(--color-text-secondary)]">
                      distance {r.distance.toFixed(4)}
                    </span>
                  )}
                </div>
                {hasMeta && (
                  <Button
                    type="button"
                    onClick={() => setOpenResult(isOpen ? null : key)}
                    className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-0.5 text-[10px] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text)]"
                  >
                    {isOpen ? 'Hide metadata' : 'Show metadata'}
                  </Button>
                )}
              </div>
              <div className="mt-2  whitespace-pre-wrap text-[color:var(--color-text)]" style={{ fontSize: 14 }}>
                {truncateContent(r.document.content)}
              </div>
              {isOpen && hasMeta && (
                <pre className="mt-2 overflow-x-auto rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2 mono text-[10px] text-[color:var(--color-text)]">
                  {JSON.stringify(r.document.metadata, null, 2)}
                </pre>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Collections tab. Lists collections on the selected node. Clicking a
 * row stages the collection for the Query tab and switches to it.
 */
function CollectionsTab(props: {
  nodeName: string;
  onPick: (collection: string) => void;
}): React.JSX.Element {
  const { nodeName, onPick } = props;
  const list = trpc.ragListCollections.useQuery(
    { node: nodeName },
    { enabled: !!nodeName, retry: false },
  );

  if (list.isLoading) {
    return (
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-4  text-[color:var(--color-text-secondary)]" style={{ fontSize: 14 }}>
        Loading collections…
      </div>
    );
  }
  if (list.error) {
    return (
      <div className="rounded-md border border-[var(--color-err)] bg-[var(--color-surface-1)] px-3 py-2  text-[color:var(--color-err)]" style={{ fontSize: 14 }}>
        Failed to reach <Badge variant="default" className="mono">{nodeName}</Badge>:{' '}
        {list.error.message}
      </div>
    );
  }
  const data = list.data as ListCollectionsResponse | undefined;
  const rows = data?.collections ?? [];

  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-[var(--color-border)] p-4  text-[color:var(--color-text-secondary)]" style={{ fontSize: 14 }}>
        No collections yet on <Badge variant="default" className="mono">{nodeName}</Badge>. Index a
        document in the Indexing tab to create one.
      </div>
    );
  }

  return (
    <div
      className="overflow-hidden rounded-md border border-[var(--color-border)]"
      data-testid="knowledge-collections-table"
    >
      <table className="w-full mono " style={{ fontSize: 14 }}>
        <thead className="bg-[var(--color-surface-1)] text-left text-[color:var(--color-text-secondary)]">
          <tr>
            <th className="px-3 py-2 font-medium">Name</th>
            <th className="px-3 py-2 font-medium">Count</th>
            <th className="px-3 py-2 font-medium">Dimensions</th>
            <th className="w-28 px-3 py-2 font-medium text-right"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr
              key={c.name}
              className="border-t border-[var(--color-border)] bg-[var(--color-surface-1)]"
            >
              <td className="px-3 py-2 text-[color:var(--color-ok)] break-all">
                {c.name}
              </td>
              <td className="px-3 py-2 text-[color:var(--color-text)]">
                {typeof c.count === 'number' ? c.count : '—'}
              </td>
              <td className="px-3 py-2 text-[color:var(--color-text)]">
                {typeof c.dimensions === 'number' ? c.dimensions : '—'}
              </td>
              <td className="px-3 py-2 text-right">
                <Button
                  type="button"
                  onClick={() => onPick(c.name)}
                  className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-0.5 text-[10px] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text)]"
                >
                  Use in Query
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Indexing tab. Accepts either a JSON array of `{id, content, metadata?}`
 * or plain text paragraphs (auto-IDed). The mutation only fires when
 * the operator hits Submit — no autosave, no focus-blur side effects.
 */
function IndexingTab(props: { nodeName: string }): React.JSX.Element {
  const { nodeName } = props;
  const [text, setText] = useState('');
  const [collection, setCollection] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<StoreResponse | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const store = trpc.ragStore.useMutation({
    onSuccess: (data) => {
      setLastResult(data as StoreResponse);
      setSubmitError(null);
      setText('');
    },
    onError: (err) => {
      setLastResult(null);
      setSubmitError(err.message);
    },
  });

  function onSubmit(): void {
    setParseError(null);
    setSubmitError(null);
    const { documents, error } = parseIndexInput(text);
    if (error) {
      setParseError(error);
      return;
    }
    const input: {
      node: string;
      documents: IndexDocumentInput[];
      collection?: string;
    } = {
      node: nodeName,
      documents,
    };
    if (collection.trim()) input.collection = collection.trim();
    store.mutate(input);
  }

  const previewCount = (() => {
    const { documents, error } = parseIndexInput(text);
    if (error) return null;
    return documents.length;
  })();

  return (
    <div className="space-y-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
        className="space-y-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-4"
        data-testid="knowledge-indexing-form"
      >
        <label className="block " style={{ fontSize: 14 }}>
          <span className="mb-1 block  text-[color:var(--color-text-secondary)]" style={{ fontSize: 12 }}>
            Documents to index (JSON array or plain text paragraphs)
          </span>
          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setParseError(null);
            }}
            rows={10}
            placeholder={`Paragraph-per-document:\n\nFirst paragraph becomes one doc.\n\nBlank lines separate documents.\n\nOr JSON:\n[{"id":"note-1","content":"…","metadata":{"source":"runbook"}}]`}
            className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono  text-[color:var(--color-text)]" style={{ fontSize: 12 }}
          />
          <span className="mt-1 block  text-[color:var(--color-text-secondary)]" style={{ fontSize: 12 }}>
            {previewCount != null
              ? `${previewCount} document${previewCount === 1 ? '' : 's'} will be stored.`
              : 'Starts with [ to parse as JSON; otherwise split on blank lines.'}
          </span>
        </label>
        <div className="grid grid-cols-12 gap-3">
          <label className="col-span-8 " style={{ fontSize: 14 }}>
            <span className="mb-1 block  text-[color:var(--color-text-secondary)]" style={{ fontSize: 12 }}>
              Collection (optional)
            </span>
            <Input
              type="text"
              value={collection}
              onChange={(e) => setCollection(e.target.value)}
              placeholder="defaults to node's collection"
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono text-[color:var(--color-text)]"
            />
          </label>
          <div className="col-span-4 flex items-end">
            <Button variant="primary" size="sm"
              type="submit"
              disabled={store.isPending}
              data-testid="knowledge-indexing-submit"
              
            >
              {store.isPending ? 'Storing…' : 'Store documents'}
            </Button>
          </div>
        </div>
        {parseError && (
          <div className=" text-[color:var(--color-err)]" style={{ fontSize: 12 }}>
            {parseError}
          </div>
        )}
      </form>

      {submitError && (
        <div className="rounded-md border border-[var(--color-err)] bg-[var(--color-surface-1)] px-3 py-2  text-[color:var(--color-err)]" style={{ fontSize: 14 }}>
          Failed to reach <Badge variant="default" className="mono">{nodeName}</Badge>: {submitError}
        </div>
      )}

      {lastResult && (
        <div
          className="rounded-md border border-[var(--color-ok)] bg-[var(--color-surface-1)] p-3"
          data-testid="knowledge-indexing-result"
        >
          <div className=" text-[color:var(--color-text)]" style={{ fontSize: 14 }}>
            Stored {lastResult.ids.length} document
            {lastResult.ids.length === 1 ? '' : 's'} in{' '}
            <Badge variant="default" className="mono">{lastResult.collection}</Badge>.
          </div>
          <div className="mt-2 flex flex-wrap gap-1 mono text-[10px] text-[color:var(--color-text-secondary)]">
            {lastResult.ids.map((id) => (
              <span
                key={id}
                className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1.5 py-0.5"
              >
                {id}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Embedder binding panel. Shows the current binding under the
 * selected RAG node and lets the operator swap or clear it. Chroma
 * embeds internally and ignores the binding — we still render the
 * panel for visibility, but explain the no-op inline.
 *
 * Optimistic update: flip the local state immediately, call
 * `nodeUpdateRagBinding`, then revert on error. Persistence is a
 * `nodeList` invalidation on success so the activity bar / other
 * consumers observe the change.
 */
function EmbedderPanel(props: {
  node: RagNodeSummary;
  agentNodes: AgentNodeSummary[];
}): React.JSX.Element {
  const { node, agentNodes } = props;
  const utils = trpc.useUtils();
  const [editing, setEditing] = useState(false);
  const [draftNode, setDraftNode] = useState(node.embedder?.node ?? '');
  const [draftModel, setDraftModel] = useState(node.embedder?.model ?? '');
  const [optimistic, setOptimistic] = useState<EmbedderBinding | null | undefined>(
    undefined,
  );
  const [error, setError] = useState<string | null>(null);

  React.useEffect(() => {
    // Reset drafts when the selected node changes. The fresh selection
    // is the source of truth; keep the form hydrated from it.
    setDraftNode(node.embedder?.node ?? '');
    setDraftModel(node.embedder?.model ?? '');
    setOptimistic(undefined);
    setEditing(false);
    setError(null);
  }, [node.name, node.embedder?.node, node.embedder?.model]);

  const mutation = trpc.nodeUpdateRagBinding.useMutation({
    onSuccess: async () => {
      setError(null);
      setEditing(false);
      await utils.nodeList.invalidate();
      setOptimistic(undefined);
    },
    onError: (err) => {
      setError(err.message);
      setOptimistic(undefined);
    },
  });

  const shown = optimistic !== undefined ? optimistic : node.embedder;

  function onSave(): void {
    const n = draftNode.trim();
    const m = draftModel.trim();
    if (!n || !m) {
      setError('Embedder node and model are both required.');
      return;
    }
    setError(null);
    const next: EmbedderBinding = { node: n, model: m };
    setOptimistic(next);
    mutation.mutate({ node: node.name, embedder: next });
  }

  function onClear(): void {
    setError(null);
    setOptimistic(null);
    mutation.mutate({ node: node.name, embedder: null });
  }

  return (
    <div
      className="mb-4 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3"
      data-testid="knowledge-embedder-panel"
    >
      <div className="flex items-start justify-between gap-3">
        <div className=" text-[color:var(--color-text-secondary)]" style={{ fontSize: 12 }}>
          <div className="mb-1 uppercase tracking-wider">Embedder</div>
          {shown ? (
            <div
              className="text-[color:var(--color-text)]"
              data-testid="knowledge-embedder-current"
            >
              node{' '}
              <Badge variant="default" className="mono">{shown.node}
              </Badge>
              <span> · model </span>
              <Badge variant="default" className="mono">{shown.model}
              </Badge>
            </div>
          ) : (
            <div
              className="text-[color:var(--color-text-secondary)]"
              data-testid="knowledge-embedder-current"
            >
              none
            </div>
          )}
          {node.provider === 'chroma' && (
            <div className="mt-1 text-[10px] text-[color:var(--color-text-secondary)]">
              Chroma embeds internally — this binding is ignored by chroma
              nodes, but persists for operator visibility.
            </div>
          )}
        </div>
        <div className="flex gap-1">
          {!editing ? (
            <Button
              type="button"
              onClick={() => {
                setDraftNode(shown?.node ?? '');
                setDraftModel(shown?.model ?? '');
                setEditing(true);
              }}
              disabled={mutation.isPending}
              data-testid="knowledge-embedder-edit"
              className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-0.5 text-[10px] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Edit embedder
            </Button>
          ) : (
            <Button
              type="button"
              onClick={() => {
                setEditing(false);
                setError(null);
              }}
              disabled={mutation.isPending}
              className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-0.5 text-[10px] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Cancel
            </Button>
          )}
          {shown && !editing && (
            <Button variant="secondary" size="sm"
              type="button"
              onClick={onClear}
              disabled={mutation.isPending}
              data-testid="knowledge-embedder-clear"
              
            >
              Clear embedder
            </Button>
          )}
        </div>
      </div>

      {editing && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSave();
          }}
          className="mt-3 grid grid-cols-12 gap-3"
          data-testid="knowledge-embedder-form"
        >
          <label className="col-span-5 " style={{ fontSize: 14 }}>
            <span className="mb-1 block  text-[color:var(--color-text-secondary)]" style={{ fontSize: 12 }}>
              Node
            </span>
            <select
              value={draftNode}
              onChange={(e) => setDraftNode(e.target.value)}
              data-testid="knowledge-embedder-node-select"
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono text-[color:var(--color-text)]"
            >
              <option value="">(pick a node)</option>
              {draftNode &&
                !agentNodes.some((n) => n.name === draftNode) && (
                  <option value={draftNode}>{draftNode} (current)</option>
                )}
              {agentNodes.map((n) => (
                <option key={n.name} value={n.name}>
                  {n.name}
                </option>
              ))}
            </select>
          </label>
          <label className="col-span-5 " style={{ fontSize: 14 }}>
            <span className="mb-1 block  text-[color:var(--color-text-secondary)]" style={{ fontSize: 12 }}>
              Model
            </span>
            <Input
              type="text"
              value={draftModel}
              onChange={(e) => setDraftModel(e.target.value)}
              placeholder="e.g. nomic-embed-text-v1.5"
              data-testid="knowledge-embedder-model-input"
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono text-[color:var(--color-text)]"
            />
          </label>
          <div className="col-span-2 flex items-end">
            <Button variant="primary" size="sm"
              type="submit"
              disabled={mutation.isPending}
              data-testid="knowledge-embedder-save"
              
            >
              {mutation.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </form>
      )}

      {error && (
        <div
          className="mt-2  text-[color:var(--color-err)]" style={{ fontSize: 12 }}
          data-testid="knowledge-embedder-error"
        >
          {error}
        </div>
      )}
    </div>
  );
}

export default function Knowledge(): React.JSX.Element {
  const nodes = trpc.nodeList.useQuery();
  const ragNodes = useMemo<RagNodeSummary[]>(() => {
    const rows = nodes.data?.nodes ?? [];
    return rows
      .filter((n) => {
        const eff = (n as { effectiveKind?: string }).effectiveKind;
        return eff === 'rag';
      })
      .map((n) => {
        const embedder = n.rag?.embedder;
        return {
          name: n.name,
          provider:
            (n.rag?.provider as RagProviderKind | undefined) ?? null,
          kind: 'rag' as const,
          embedder:
            embedder && typeof embedder === 'object'
              ? {
                  node: String((embedder as EmbedderBinding).node),
                  model: String((embedder as EmbedderBinding).model),
                }
              : null,
        };
      });
  }, [nodes.data]);
  const agentNodes = useMemo<AgentNodeSummary[]>(() => {
    const rows = nodes.data?.nodes ?? [];
    return rows
      .filter((n) => {
        const eff = (n as { effectiveKind?: string }).effectiveKind;
        return eff === 'agent';
      })
      .map((n) => ({ name: n.name, endpoint: n.endpoint }));
  }, [nodes.data]);

  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>('query');
  const [queryCollection, setQueryCollection] = useState('');

  // Auto-select the first RAG node once the list loads.
  React.useEffect(() => {
    const first = ragNodes[0];
    if (!selectedNode && first) {
      setSelectedNode(first.name);
      return;
    }
    if (selectedNode && !ragNodes.some((n) => n.name === selectedNode)) {
      setSelectedNode(first?.name ?? null);
    }
  }, [ragNodes, selectedNode]);

  const selected = ragNodes.find((n) => n.name === selectedNode) ?? null;

  return (
    <div className="h-full overflow-auto p-6" data-testid="knowledge-retrieval-root">
      <div className="mb-1  uppercase tracking-widest text-[color:var(--color-text-secondary)]" style={{ fontSize: 12 }}>
        Knowledge
      </div>
      <h1 className="mb-2 text-2xl font-semibold text-[color:var(--color-text)]">
        Retrieval-Augmented Generation
      </h1>
      <p className="mb-6  text-[color:var(--color-text-secondary)]" style={{ fontSize: 12 }}>
        Query, browse, and index documents against the RAG nodes registered in
        your kubeconfig. Supported providers:{' '}
        <Badge variant="default" className="mono">chroma</Badge> and{' '}
        <Badge variant="default" className="mono">pgvector</Badge>.
      </p>

      {nodes.isLoading && (
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-4  text-[color:var(--color-text-secondary)]" style={{ fontSize: 14 }}>
          Loading nodes…
        </div>
      )}

      {!nodes.isLoading && ragNodes.length === 0 && (
        <div
          className="rounded-md border border-dashed border-[var(--color-border)] bg-[var(--color-surface-1)] p-6"
          data-testid="knowledge-empty-state"
        >
          <div className=" text-[color:var(--color-text)]" style={{ fontSize: 14 }}>
            No knowledge bases yet — register one with{' '}
            <Badge variant="default" className="mono">llamactl node add …</Badge>.
          </div>
          <p className="mt-2  text-[color:var(--color-text-secondary)]" style={{ fontSize: 12 }}>
            Example for a Chroma node backed by the chroma-mcp server:
          </p>
          <pre className="mt-1 overflow-x-auto rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2 mono text-[10px] text-[color:var(--color-text)]">{`llamactl node add kb-chroma \\
  --rag=chroma \\
  --endpoint="chroma-mcp run --persist-directory /path/to/chroma-data"`}</pre>
          <p className="mt-2  text-[color:var(--color-text-secondary)]" style={{ fontSize: 12 }}>
            Or a pgvector node against a running Postgres with the{' '}
            <Badge variant="default" className="mono">vector</Badge> extension:
          </p>
          <pre className="mt-1 overflow-x-auto rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2 mono text-[10px] text-[color:var(--color-text)]">{`llamactl node add kb-pg \\
  --rag=pgvector \\
  --endpoint="postgres://kb_user:$PG_PASSWORD@db.local:5432/kb_main"`}</pre>
        </div>
      )}

      {ragNodes.length > 0 && selected && (
        <>
          <div className="mb-4 grid grid-cols-12 gap-3">
            <label className="col-span-6 " style={{ fontSize: 14 }}>
              <span className="mb-1 block  text-[color:var(--color-text-secondary)]" style={{ fontSize: 12 }}>
                RAG node
              </span>
              <select
                value={selected.name}
                onChange={(e) => setSelectedNode(e.target.value)}
                data-testid="knowledge-node-select"
                className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono text-[color:var(--color-text)]"
              >
                {ragNodes.map((n) => (
                  <option key={n.name} value={n.name}>
                    {n.name}
                    {n.provider ? ` — ${n.provider}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <div className="col-span-6 flex items-end gap-2  text-[color:var(--color-text-secondary)]" style={{ fontSize: 12 }}>
              <span>
                kind <Badge variant="default" className="mono">rag</Badge>
              </span>
              {selected.provider && (
                <span>
                  · provider{' '}
                  <Badge variant="default" className="mono">{selected.provider}
                  </Badge>
                </span>
              )}
            </div>
          </div>

          <EmbedderPanel node={selected} agentNodes={agentNodes} />

          <div
            className="mb-4 flex gap-1 border-b border-[var(--color-border)]"
            data-testid="knowledge-tabs"
          >
            {(
              [
                { id: 'query', label: 'Query' },
                { id: 'collections', label: 'Collections' },
                { id: 'indexing', label: 'Indexing' },
                { id: 'pipelines', label: 'Pipelines' },
                { id: 'quality', label: 'Quality' },
              ] as { id: TabId; label: string }[]
            ).map((tab) => {
              const active = tab.id === activeTab;
              return (
                <Button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  data-testid={`knowledge-tab-${tab.id}`}
                  className={
                    active
                      ? 'border-b-2 border-[var(--color-brand)] px-3 py-2 text-sm font-medium text-[color:var(--color-text)]'
                      : 'border-b-2 border-transparent px-3 py-2 text-sm text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text)]'
                  }
                >
                  {tab.label}
                </Button>
              );
            })}
          </div>

          <div data-testid={`knowledge-panel-${activeTab}`}>
            {activeTab === 'query' && (
              <QueryTab
                nodeName={selected.name}
                collection={queryCollection}
                onCollectionChange={setQueryCollection}
                embedder={selected.embedder}
                provider={selected.provider}
              />
            )}
            {activeTab === 'collections' && (
              <CollectionsTab
                nodeName={selected.name}
                onPick={(collection) => {
                  setQueryCollection(collection);
                  setActiveTab('query');
                }}
              />
            )}
            {activeTab === 'indexing' && <IndexingTab nodeName={selected.name} />}
            {activeTab === 'quality' && (
              <QualityTab nodeName={selected.name} collection={queryCollection} />
            )}
            {activeTab === 'pipelines' && (
              <PipelinesTab
                nodeName={selected.name}
                availableNodes={ragNodes.map((n) => n.name)}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
