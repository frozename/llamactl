# RAG nodes — retrieval-augmented knowledge bases

Register vector stores and knowledge bases as first-class cluster
nodes alongside `agent`, `gateway`, and `provider` kinds. Every RAG
node exposes a uniform surface (`search`, `store`, `delete`,
`listCollections`) through tRPC and MCP so ops-chat, the Electron
Knowledge module, and future Chat / Pipelines consumers talk to the
same contract regardless of backend.

---

## When to use it

Reach for a RAG node whenever you want llamactl-managed retrieval
against a persisted document store: project memory, logs, ticket
bodies, code snippets, or any corpus you'd normally query by
similarity. The backend picks up the indexing/embedding
responsibility; llamactl owns the surface.

Not useful when the caller already speaks the backend's native API
directly — RAG nodes exist to normalize retrieval across backends, not
replace them.

---

## Supported providers (v1)

- **`chroma`** — proxied through [chroma-mcp](https://github.com/chroma-core/chroma-mcp).
  Chroma embeds internally; callers store raw text and search with a
  natural-language query.
- **`pgvector`** — native SQL adapter against Postgres + the
  [pgvector](https://github.com/pgvector/pgvector) extension. Callers
  supply pre-computed embedding vectors on every store + search. No
  in-adapter embedding yet.

Both adapters normalize response `score` to cosine similarity in
`0..1` (higher = more relevant). Raw backend distance is forwarded on
the optional `distance` field for callers that want the untransformed
value.

Additional backends (Qdrant, Weaviate, Milvus, LanceDB, …) plug in
behind the same `RetrievalProvider` contract — open an issue if you
need one.

---

## Register a Chroma node

**Prereq**: install chroma-mcp on a box the llamactl agent can reach:

```sh
pipx install chroma-mcp          # or: pip install chroma-mcp
```

Smoke-test the command separately first — if it can't boot, the RAG
node fails fast with `connect-failed`, not a silent hang.

Register the node. `endpoint` is the *full* command string the adapter
spawns over stdio; `collection` is the default collection name used
when search/store requests omit it.

```sh
llamactl node add kb-chroma \
  --rag=chroma \
  --endpoint='chroma-mcp run --persist-directory /var/lib/chroma-data' \
  --collection=default
```

The adapter opens a fresh chroma-mcp subprocess per tRPC call and
tears it down in `finally`. Pooling is a follow-up (see roadmap).

---

## Register a pgvector node

**Prereqs**:

1. Postgres 15+ with the `vector` extension installed:
   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   ```
2. A collection table per the **Schema** section below, with an HNSW
   index on the embedding column.
3. An embedding pipeline you control — pgvector has no in-adapter
   embedding. Every `store` call must carry `vector: number[]`; every
   `search` passes the query embedding in `filter.vector`.

Register the node, keeping the password out of the persisted config
via an env-var reference:

```sh
export KB_PG_PASSWORD='...'
llamactl node add kb-pg \
  --rag=pgvector \
  --endpoint="postgres://kb_user@db.local:5432/kb_main" \
  --collection=documents \
  --auth-token-env=KB_PG_PASSWORD
```

The adapter opens a short-lived connection per call via
[postgres.js](https://github.com/porsager/postgres) and closes it on
teardown.

### Schema convention

Every `collection` in pgvector is a table with this shape:

```sql
CREATE TABLE documents (
  id        TEXT PRIMARY KEY,
  content   TEXT NOT NULL,
  metadata  JSONB,
  embedding vector(1536)      -- pick the dim your embedder produces
);

CREATE INDEX documents_embedding_idx
  ON documents USING hnsw (embedding vector_cosine_ops);
```

llamactl intentionally does **not** manage DDL — the embedding
dimension is the operator's choice, and schema churn across tenants
is too easy to get wrong from inside the adapter. A
`llamactl rag pgvector init` helper is on the roadmap.

---

## Day-to-day usage

### From the Electron Knowledge module

Click the Knowledge icon in the activity bar. The module surfaces
three tabs:

- **Query** — pick a RAG node, type a query, browse ranked results
  with score badges.
- **Collections** — list collections on the selected node; click a
  row to jump to Query with that collection preselected.
- **Indexing** — paste JSON (`{id, content, metadata?}[]`) or
  paragraph-separated text and store it. Returned IDs surface in
  a success banner.

The picker filters `nodeList` to entries with `effectiveKind: 'rag'`;
if none are registered, the UI points you at `llamactl node add ...`.

### From the Chat module (auto-context)

Each conversation can bind to a RAG node via the **rag** picker in the
chat header. Once bound, every message you send triggers a background
`ragSearch({ node, query: <your message>, topK })` call; the top
results are trimmed to a per-turn character budget (~12k chars, tunable
in the source) and prepended as a `system` message before your turn
reaches the LLM. The user message shows a disclosure with the retrieved
doc IDs + scores + content previews so you can verify what the model
saw.

Retrieval failures don't block the chat — the turn still sends, just
without context. Check the activity-bar's Knowledge module for the
same RAG node to confirm it's reachable independently.

### From ops-chat

The operator console speaks the same tools natively:

- "search the kb-chroma node for authentication failures" → runs
  `llamactl.rag.search`.
- "add this stack trace to the kb-chroma node" → runs
  `llamactl.rag.store` (dry-run gate surfaces the would-be payload
  before committing).
- "list collections on kb-pg" → runs `llamactl.rag.listCollections`.
- "delete doc abc-123 from kb-chroma" → runs `llamactl.rag.delete`
  (destructive — tier-3, needs the type-the-tool-name confirmation).

### From MCP / tRPC

Every surface maps 1:1 to the underlying `RetrievalProvider`
contract. The MCP tool names + tRPC procedures are:

| MCP tool                          | tRPC procedure       | Method |
| --------------------------------- | -------------------- | ------ |
| `llamactl.rag.search`             | `ragSearch`          | query  |
| `llamactl.rag.store`              | `ragStore`           | mutate |
| `llamactl.rag.delete`             | `ragDelete`          | mutate |
| `llamactl.rag.listCollections`    | `ragListCollections` | query  |

The MCP inputs mirror the tRPC inputs exactly; callers always pass
the target `node` name.

---

## Troubleshooting

### `connect-failed: chroma-mcp binary not on PATH`

chroma-mcp isn't installed on the host running the llamactl agent.
Install via pipx/pip and re-run; restart the agent if the shell
can't find it because the PATH was set in a different login shell.

### `connect-failed` on pgvector

Confirm in order:

1. `psql $PG_URL -c 'SELECT 1'` reaches the server from the agent.
2. `CREATE EXTENSION IF NOT EXISTS vector;` has run in the target
   database.
3. The password resolves: if using `--auth-token-env`, the env var is
   set in the agent's environment (not just the shell that registered
   the node).

Passwords never land in errors or logs — the adapter redacts
`postgres://user:***@host:port/db` at every surface.

### `tool-missing: table 'X' has no 'embedding' column`

pgvector store/search against a table that isn't a collection in the
schema sense. Create the table per **Schema convention** above.

### `invalid-request: pgvector search requires a query vector`

Every pgvector `ragSearch` must pass the pre-computed query embedding
in `filter.vector: number[]` **OR** have a `binding.embedder` set so
the adapter can auto-embed the free-text query. See "Delegated
embedding" below for the one-time setup that removes this
requirement.

### Scores look inverted

Both adapters normalize `score = clamp(1 - distance, 0..1)` — higher
is more relevant, so `0.92` means "very similar." If a backend ever
returns values outside `0..1`, that's a bug — file it.

---

## Delegated embedding (shipped)

pgvector's strict caller-supplied-vector requirement is lifted when
the rag binding names an **embedder**:

```yaml
rag:
  provider: pgvector
  endpoint: postgres://kb@db.local:5432/kb_main
  collection: documents
  embedder:
    node: sirius                   # any cluster node with createEmbeddings
    model: text-embedding-3-small  # model the embedder node speaks
```

With `embedder` set:
- `store({ documents: [{ id, content }] })` — missing vectors are
  computed in one batch call per store.
- `search({ query: "…" })` without `filter.vector` — the query is
  embedded before the similarity scan.

Caller-supplied vectors always win — if a doc carries `vector`, the
embedder is skipped for that doc. Rotating the secret behind the
embedder node's `apiKeyRef` does not recreate the pod; changing
which env var / model the embedder uses does.

## Chat auto-context (shipped)

See ["From the Chat module"](#from-the-chat-module-auto-context)
above. Each conversation can bind to a RAG node + topK; every send
retrieves + injects a budget-trimmed system message. Failure is
soft — the turn still sends without context.

---

## What's next (roadmap)

- **Pipelines "retrieve" stage** — composable retrieval in the
  workflow engine alongside "synthesize".
- **Adapter pooling** — cache provider instances between calls.
- **Schema helpers** — `llamactl rag pgvector init --table <name>
  --dim <d>` creates the table + HNSW index.
- **CLI wrappers** — `llamactl rag {search,store,delete} --node ...`
  for operators who live in a shell.
- **Backend expansion** — Qdrant, Weaviate, Milvus, LanceDB, Pinecone,
  BigQuery vector search.
- **Hybrid search** — BM25 + vector rerank where the backend supports
  it.
