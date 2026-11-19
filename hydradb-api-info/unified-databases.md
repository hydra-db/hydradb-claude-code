# Unified databases: rollout preparation

**DO NOT MERGE — Unified API is not enabled in production; hold until production rollout is confirmed.**

This is an unpublished contract preview, not permission to create a unified database,
enable a flag, import a specification or deploy the plugin. The runtime reference is
application main `5d45c23840a62fcf38ff13e8deea5587ab1b961c`; see
[the follow-up rationale](../UNIFIED-ROLLOUT-PREP.md) for its SDK and publication gates.

## Explicit layout selection

Keep `layout: "split"` (the default), or `HYDRADB_LAYOUT=split`, until rollout
is confirmed for the configured database. Then explicitly choose `layout: "unified"`
or `HYDRADB_LAYOUT=unified`. The plugin does not probe or cache database layout,
and a failed write/delete never triggers a differently shaped retry.

Unified mode has one corpus, so recall makes one selector-free query regardless of
the split `searchMode` choice. Reads recognize the shape actually returned in either
mode. Split ingestion, capture retry/state handling and MEMORY/KNOWLEDGE rendering
remain supported.

## JSON ingestion

Unified writes use `POST /context/ingest`, bearer authentication and
`API-Version: 2`, with a JSON body such as:

```json
{
  "database": "my-db",
  "collection": "workspace",
  "context": [
    {
      "context_id": "turn-1",
      "user_name": "Ada",
      "conversation": [
        { "role": "user", "content": "Keep answers short." },
        { "role": "assistant", "content": "Understood." }
      ],
      "enrich": true
    }
  ]
}
```

Each context needs nonblank `text` XOR a nonempty `conversation`. Turns contain
only `role` and `content`; roles are user, assistant or system, with at least
one user/assistant turn. Speaker attribution is the item's `user_name`, not a
per-turn `name`.

Optional item fields are `context_id`, `title`, `user_name`, `attributes`,
`custom_attributes`, `happened_at` (YYYY-MM-DD), `enrich`, `instructions`,
`upsert`, `forceful_relations: {context_ids, properties}` and `acl`.
Request-level `upsert`, `enrich` and `instructions` provide defaults.
The plugin sends `context[]`, not obsolete `items[]`/`contexts[]`, split
multipart fields, type/kind selectors or removed `context_category`.

Existing source IDs become context IDs. Workspace metadata maps to attributes
and additional metadata to custom attributes. File mtime is preserved as
`custom_attributes.original_timestamp`, not inferred as an event date;
description uses `original_description`, because `description` is reserved.
Provenance collisions and unsupported rich bodies fail rather than losing data.

Server limits include 100 contexts per request, 1 MiB of text per context and
8 MiB of text per request; title, instruction, metadata, identifier and ACL
rules also apply. The plugin retains its existing batching/chunking behavior.
A 202 is queued, not indexed: inspect per-item `data.results[].id` receipts.
Missing receipts fail the write, and workspace sync rolls back confirmed IDs
from a partially failed batch without stamping the file as synced.

## Query results

The response data contains `chunks[]`, `graph[]`, `forceful_relations[]`,
`llm_prompt` and `tabular_data`. Chunk fields include `chunk_id`,
`context_id`, `score`, literal `content`, optional separate `enrichment`,
`received_at`, `temporal` and CSV `chunk_metadata`. Source title, type,
collection and metadata are not repeated on chunks; use
`POST /context/list` with `ids` for source metadata. Inspect returns stored
content, not that metadata.

Safe `llm_prompt` is injected verbatim, including empty strings, CRLF and
whitespace. It is not wrapped, reconstructed, concatenated with chunk prose or
fitted to split display budgets. Credential redaction still takes precedence.
The normalizer retains graph/entity/relationship identities and raw structured
extensions without rewriting opaque metadata keys. Query JSON keeps that data;
bounded-display helpers remain available separately.

List, deletion, relations, inspect and status keep their existing public surfaces.
Unified requests omit split selectors. No new endpoint or database provisioning
step is performed by this rollout preparation.
