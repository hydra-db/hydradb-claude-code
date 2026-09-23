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
{ "success": true, "message": "Context queued for ingestion successfully",
  "results": [ { "source_id": "claude-turn:abc:1", "title": null, "status": "queued", "infer": true, "error": null, "error_code": null } ],
  "success_count": 1, "failed_count": 0 }
```

inside the usual `{success, data, meta}` envelope. `results[].source_id` is the context id (the one sent, or the one the server generated when none was). `/hydradb:ingest --note` prints it, and `ingest --session --json` returns the queued ids as `contextIds`. Poll `GET /context/status?database=..&ids=..` for indexing progress.

## Query: the request and the four-key response

The plugin sends the v2 request (`database`, `collection`, `query`, `mode`, `max_results`, `alpha`, `recency_bias`, `graph_context`) plus `follow_forceful_relations` (config `followForcefulRelations`, default `true`), and no `type`.

The response `data` has exactly four keys: `chunks`, `graph`, `forceful_relations` and `llm_prompt`. A real envelope, as the server's own handler test renders it:

```json
{
  "success": true,
  "data": {
    "chunks": [
      {
        "chunk_id": "ck_policy_3",
        "context_id": "refund-policy",
        "score": 0.91,
        "content": "Refunds are processed within 30 days of purchase by the Finance Department.",
        "enrichment": "Refund window is 30 days; Finance owns refund processing.",
        "enrichment_kind": "business_knowledge",
        "temporal": [
          {
            "content": "Refund policy effective_from June 2026. Start: 2026-06-01",
            "start_date": "2026-06-01",
            "end_date": null
          }
        ]
      },
      {
        "chunk_id": "ck_chat_1",
        "context_id": "chat-2026-07-29",
        "score": 0.84,
        "content": "user: Keep refund answers short please\nassistant: Got it.",
        "enrichment": "User prefers short answers about refunds.",
        "enrichment_kind": "user_preference"
      }
    ],
    "graph": [
      {
        "origin": "query_path",
        "triplets": [
          {
            "source": {
              "entity_id": "ent_refunds",
              "name": "Refund Processing"
            },
            "relation": {
              "predicate": "managed by",
              "context": "Refund processing is managed by the Finance Department.",
              "relationship_id": "rel_managed_by",
              "chunk_id": "ck_policy_3"
            },
            "target": {
              "entity_id": "ent_finance",
              "name": "Finance Department"
            }
          }
        ],
        "path_summary": "Refund processing is managed by the Finance Department."
      },
      {
        "origin": "chunk_relation",
        "triplets": [
          {
            "source": {
              "entity_id": "ent_user",
              "name": "User"
            },
            "relation": {
              "predicate": "prefers",
              "context": "The user prefers short answers about refunds.",
              "relationship_id": "rel_prefers",
              "chunk_id": "ck_chat_1"
            },
            "target": {
              "entity_id": "ent_short",
              "name": "short answers"
            }
          }
        ],
        "path_summary": "The user prefers short answers about refunds."
      }
    ],
    "forceful_relations": [
      {
        "via": {
          "from": "refund-policy",
          "to": "refund-faq"
        },
        "chunk": {
          "chunk_id": "ck_faq_1",
          "context_id": "refund-faq",
          "score": 0,
          "content": "FAQ: refunds to a card take 5 to 7 business days to appear."
        }
      }
    ],
    "llm_prompt": "# Query results\n\n**Query:** who owns refund processing?\n**Found:** 2 results across 2 sources · 2 related facts · 1 temporal fact · 1 forceful relation\nCite a result by its number in brackets, e.g. [1].\n\n## Results\n\n### 1. Refund policy\n- **Relevance:** 0.91 · **Collection:** support · **Type:** file · **Category:** business_knowledge\n- **Id:** refund-policy · **Last updated:** 2026-07-02\n\nRefunds are processed within 30 days of purchase by the Finance Department.\n\n**Enrichment:** Refund window is 30 days; Finance owns refund processing.\n\n---\n\n### 2. Support chat with Priya\n- **Relevance:** 0.84 · **Collection:** support · **Type:** message · **Category:** user_preference\n- **Id:** chat-2026-07-29 · **Last updated:** 2026-07-29\n\nuser: Keep refund answers short please\nassistant: Got it.\n\n**Enrichment:** User prefers short answers about refunds.\n\n## Forceful relations\n\nLinked to a result by the author at ingest time (forceful_relations), not by relevance to this query.\n\n### R1. Refund FAQ\n- **Linked from:** refund-policy · **Collection:** support\n- **Id:** refund-faq\n\nFAQ: refunds to a card take 5 to 7 business days to appear.\n\n## Related facts\n\n- [P1] **Refund Processing** -managed by→ **Finance Department** (query path, relevance 0.81) [1]\n  Refund processing is managed by the Finance Department.\n- [P2] **User** -prefers→ **short answers** (chunk relation, relevance 0.74) [2]\n  The user prefers short answers about refunds.\n\n## Temporal facts\n\n- **Refund policy** *effective_from* → **June 2026** (from 2026-06-01, precision: month, status: ongoing; evidence: \"from June\") [1]\n\n## Sources\n\n1. **Refund policy** (file, id: refund-policy) · https://docs.acme.com/refunds · updated 2026-07-02\n2. **Support chat with Priya** (message, id: chat-2026-07-29) · updated 2026-07-29\n3. **Refund FAQ** (id: refund-faq)"
  },
  "error": null,
  "meta": {
    "request_id": "ab5a04df-d3c4-419c-9669-d1ea2c3f9c51",
    "api_version": "2.0.1",
    "latency_ms": null,
    "database": "acme_corp",
    "collection": "support"
  }
}
```

On a chunk (and on `forceful_relations[].chunk`, which has the same shape):

- `enrichment` is a plain string, the enrichment written for that chunk. It is omitted when empty.
- `enrichment_kind` is the chunk's declared `context_category` (`user_preference`, `business_knowledge` or `decision_trace`). It is omitted when none was declared, and can be present when `enrichment` is not.
- `temporal[]` is present only when the query engaged a dated fact: `content` is the fact with its dated sides (`Start: YYYY-MM-DD`, `End: YYYY-MM-DD`), and `start_date` / `end_date` are ISO dates or null.

`llm_prompt` is markdown: a `# Query results` header with the `**Query:**`, `**Found:**` and cite lines, then `## Results` (`### 1. <title>` per result, with its relevance, collection, type and `**Category:**` on the meta line, then the content and `**Enrichment:**`), `## Forceful relations` (`### R1.` entries with `**Linked from:**`), `## Related facts` (`[P1]` graph paths), `## Temporal facts` and `## Sources`.

What the plugin does with it:

- The `<hydradb-context>` block injected on each prompt contains `llm_prompt` verbatim (secret redaction and the `maxContextChars` budget still apply). It numbers what the model is asked to cite (results `1.`, forceful relations `R1.`, related facts `[P1]`, cited in brackets as `[1]`, `[R1]`, `[P1]`), so the plugin never rebuilds it from the chunks.
- `query --json` returns `searchMode: "unified"` and a `unified` object: `chunks[]` (`contextId`, `chunkId`, `score`, `content`, `enrichment` (a string), `enrichmentKind`, `temporal[]`), `graph[]` (`origin`, `pathSummary`, `triplets`), `forcefulRelations[]` (`via{from,to}`, `chunk` with the same fields) and `llmPrompt`. The text output renders the structured fields in the same markdown layout as `llm_prompt`: `## Results` with `### 1.` per chunk (headed by its `context_id`, since chunks carry no title), `**Relevance:**` and `**Category:**` on the meta line, `**Enrichment:**` and `**Temporal:**` lines, then `## Forceful relations` with the server's guide line and `### R1.` entries, and `## Related facts` with `[P1]` paths.
- `/hydradb:last-recall` reports `unifiedCount`, `unifiedGraphPathCount` and `unifiedForcefulRelationCount` for a unified recall.
- Chunks carry nothing about their source (no title, url, collection or timestamps). Use `GET /context/inspect?database=..&id=<context_id>` for that.
- The parser tells the two shapes apart by shape (`graph` and `forceful_relations` are arrays and `llm_prompt` a string, versus `graph_context` and `chunk_content`), never by a flag, because split databases and stored logs keep producing the old shape. The bucket is read from `forceful_relations` only: a body that names it `relations` is refused as not the unified body, never read as one.
- `graph[].origin` is `"query_path"` (a path grown from the query's entities) or `"chunk_relation"` (the neighbourhood of a returned chunk); `query --json` carries it as `unified.graph[].origin`, and leaves it off a path whose origin is missing or not one of those two.
- The envelope `meta` of a unified response carries `request_id`, `api_version`, `latency_ms`, `database` and `collection`, and no `tenant_id`, `sub_tenant_id` or `source_type`. The plugin reads no field of `meta` on a unified database.

## Other endpoints

`POST /context/list`, `DELETE /context`, `GET /context/relations`, `GET /context/inspect`, `GET /context/status`: unchanged shapes, and the plugin sends no `type` to a unified database on any of them.

`searchMode: "unified"` and `ingestionMode: "unified"` are accepted as explicit spellings, and `searchMode: "auto"` means `memory` on a split database; the layout always wins.
