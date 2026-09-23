# Unified databases (PRO-1618)

A database created with `type: "unified"` keeps knowledge and memory in ONE corpus. There is no new API version: the same v2 endpoints serve it. What changes on it is the ingest body, the query response, and that `type` is never sent.

## What the plugin does

- On startup it reads the configured database's layout once from `GET /databases` (`details[].type` is `"split"` or `"unified"`; absent means split). A failed probe reads as `split`, which is what every database created before this change is.
- On a **unified** database the plugin sends no `type` on any call, writes every memory (turn capture, session upsert, `/hydradb:ingest --note`, workspace sync) through the JSON ingest body below, and injects the server-built `llm_prompt` from the four-key query response as the recall context.
- On a **split** database nothing changes: the multipart ingest, `type` on every call, the MEMORY/KNOWLEDGE context block, and `searchMode`/`ingestionMode` behave exactly as before.

## Creating one

```bash
curl -X POST https://api.hydradb.com/databases \
  -H "Authorization: Bearer $HYDRADB_API_KEY" -H "Content-Type: application/json" \
  -d '{"database": "my-db", "type": "unified"}'
```

`POST /databases` is the one call that carries `type: "unified"`.

## Ingest: the JSON body the plugin sends

```json
POST /context/ingest
{
  "database": "my-db",
  "collection": "claude-my-workspace",
  "upsert": true,
  "context": [
    { "context_id": "claude-turn:abc:1",
      "conversation": [
        { "role": "user", "content": "...", "name": "Soham" },
        { "role": "assistant", "content": "..." } ],
      "enrich": true, "instructions": "Extract durable user preferences, ..." },
    { "context_id": "claude-session:abc:memory", "title": "Claude Code session abc",
      "text": "# Claude Code session\n...", "enrich": true, "instructions": "...",
      "custom_attributes": { "is_markdown": true, "user_name": "Soham" } },
    { "context_id": "claude-file:abc", "title": "CLAUDE.md", "text": "...", "enrich": true,
      "happened_at": "2026-09-05",
      "attributes": { "workspace": "my-workspace", "relative_path": "CLAUDE.md", "extension": ".md" },
      "custom_attributes": { "size_bytes": 4096, "plugin": "hydradb",
        "source": "claude-code-plugin", "description": "Workspace context synced from my-workspace",
        "url": "hydradb://workspace/my-workspace/CLAUDE.md" } }
  ]
}
```

The list key is `context`. Each item is exactly one of `text` or `conversation` (turns are `{role, content, name?}` with roles `user`, `assistant`, `system`). The item fields are the contract's: `context_id` (was `source_id`), `title`, `enrich` (was `infer`), `upsert`, `instructions` (was `custom_instructions`), `happened_at` (YYYY-MM-DD only; the workspace sync cuts it from the file's mtime), `attributes` (was `metadata`; declared, filterable), `custom_attributes` (was `additional_metadata`; free-form), `context_category`, `forceful_relations`, `acl`. `enrich`, `upsert` and `instructions` may also be given once at request level as the default for every item.

`is_markdown` and `user_name` are not item fields, so a text item carries them inside `custom_attributes`; a conversation's attribution is the per-turn `name`. A workspace file's `metadata` becomes `attributes`, its `additional_metadata` becomes `custom_attributes`, and `source`, `description` and `url` ride in `custom_attributes` too, so a synced file keeps the same provenance it has on a split database.

The response is a 202:

```json
{ "success": true, "message": "...",
  "results": [ { "source_id": "claude-turn:abc:1", "title": null, "status": "queued", "infer": true, "error": null, "error_code": null } ],
  "success_count": 1, "failed_count": 0 }
```

inside the usual `{success, data, meta}` envelope. `results[].source_id` is the context id (the one sent, or the one the server generated when none was). `/hydradb:ingest --note` prints it, and `ingest --session --json` returns the queued ids as `contextIds`. Poll `GET /context/status?database=..&ids=..` for indexing progress.

## Query: the request and the four-key response

The plugin sends the v2 request (`database`, `collection`, `query`, `mode`, `max_results`, `alpha`, `recency_bias`, `graph_context`) plus `follow_forceful_relations` (config `followForcefulRelations`, default `true`), and no `type`.

The response `data` has exactly four keys:

```json
{
  "chunks": [
    { "chunk_id": "ck_9f2", "context_id": "chat-2026-07-29#w2", "score": 0.87,
      "content": "user: Keep answers short please\nassistant: Got it.",
      "enrichment": { "text": "User prefers short, bullet-point answers.", "kind": "user_preference" },
      "temporal": [ { "content": "...", "start_date": "2026-06-01", "end_date": null } ] }
  ],
  "graph": [
    { "origin": "query_path",
      "triplets": [ { "source": { "entity_id": "ent_a3f", "name": "John" },
                      "relation": { "predicate": "subscribed to", "context": "John subscribed to the Pro plan.",
                                    "temporal_details": "since June", "relationship_id": "rel_1", "chunk_id": "ck_9f2" },
                      "target": { "entity_id": "ent_9c1", "name": "Pro plan" } } ],
      "path_summary": "John is on the Pro plan since June 2026." }
  ],
  "forceful_relations": [
    { "via": { "from": "linear-PRO-1169", "to": "linear-PRO-1169-comment-4" },
      "chunk": { "chunk_id": "ck_7b3", "context_id": "linear-PRO-1169-comment-4", "score": 0.42, "content": "..." } }
  ],
  "llm_prompt": "=== CONTEXT ===\nCite anything you use from this context with its bracketed label, e.g. [1].\n\n[1] context_id: chat-2026-07-29#w2\n...\n=== FORCEFUL RELATIONS ===\nLinked to a result by the author at ingest time (forceful_relations), not by relevance to this query.\n\n[R1] ...\n=== GRAPH ===\n[P1] John is on the Pro plan since June 2026.\n    John -> subscribed to -> Pro plan [1]"
}
```

What the plugin does with it:

- The `<hydradb-context>` block injected on each prompt contains `llm_prompt` verbatim (secret redaction and the `maxContextChars` budget still apply). It carries the citation labels `[1]`, `[R1]`, `[P1]` the model is asked to cite, so the plugin never rebuilds it from the chunks.
- `query --json` returns `searchMode: "unified"` and a `unified` object: `chunks[]` (`contextId`, `chunkId`, `score`, `content`, `enrichment{text,kind}`, `temporal[]`), `graph[]` (`origin`, `pathSummary`, `triplets`), `forcefulRelations[]` (`via{from,to}`, `chunk`) and `llmPrompt`. The text output renders the structured fields in the same `[n]` / `[Rn]` / `[Pn]` labelling and the same `=== FORCEFUL RELATIONS ===` heading and guide line as `llm_prompt`.
- `/hydradb:last-recall` reports `unifiedCount`, `unifiedGraphPathCount` and `unifiedForcefulRelationCount` for a unified recall.
- Chunks carry nothing about their source (no title, url, collection or timestamps). Use `GET /context/inspect?database=..&id=<context_id>` for that.
- The parser tells the two shapes apart by shape (`graph` and `forceful_relations` are arrays and `llm_prompt` a string, versus `graph_context` and `chunk_content`), never by a flag, because split databases and stored logs keep producing the old shape. The bucket is read from `forceful_relations` only: a body that names it `relations` is refused as not the unified body, never read as one.
- `graph[].origin` is `"query_path"` (a path grown from the query's entities) or `"chunk_relation"` (the neighbourhood of a returned chunk); `query --json` carries it as `unified.graph[].origin`, and leaves it off a path whose origin is missing or not one of those two.
- The envelope `meta` of a unified response carries `request_id`, `api_version`, `latency_ms`, `database` and `collection`, and no `tenant_id`, `sub_tenant_id` or `source_type`. The plugin reads no field of `meta` on a unified database.

## Other endpoints

`POST /context/list`, `DELETE /context`, `GET /context/relations`, `GET /context/inspect`, `GET /context/status`: unchanged shapes, and the plugin sends no `type` to a unified database on any of them.

`searchMode: "unified"` and `ingestionMode: "unified"` are accepted as explicit spellings, and `searchMode: "auto"` means `memory` on a split database; the layout always wins.
