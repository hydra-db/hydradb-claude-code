# Unified databases (PRO-1618)

A database created with `type: "unified"` keeps knowledge and memory in ONE corpus. There is no new API version: the same v2 endpoints serve it, and `type` gained the value `unified`.

## What the plugin does

- On startup it reads the configured database's layout once from `GET /databases` (`details[].type`). A failed probe reads as `split`, which is what every database created before this change is.
- On a **unified** database every call sends `type: "unified"` (the only value the server accepts there; `memory`/`knowledge` are refused with a 400), recall is one ranked list rendered as a single `CONTEXT` section, and every write (turn capture, session upsert, `/hydradb-remember`, workspace sync) goes through the unified `items[]` body.
- On a **split** database nothing changes: `searchMode`/`ingestionMode` behave exactly as before.

## Creating one

```bash
curl -X POST https://api.hydradb.com/databases \
  -H "Authorization: Bearer $HYDRADB_API_KEY" -H "Content-Type: application/json" \
  -d '{"database": "my-db", "type": "unified"}'
```

## The `items[]` shape the plugin sends

```json
POST /context/ingest
{
  "database": "my-db",
  "collection": "claude-my-workspace",
  "upsert": true,
  "items": [
    { "context_id": "claude-turn:abc:1", "conversation": [
        { "role": "user", "content": "...", "name": "Soham" },
        { "role": "assistant", "content": "..." } ],
      "enrich": true, "custom_instructions": "..." },
    { "context_id": "claude-chunk:abc:1", "title": "CLAUDE.md (part 1/2)", "text": "...",
      "is_markdown": true, "user_name": "Soham", "enrich": true },
    { "context_id": "claude-file:abc", "title": "CLAUDE.md", "text": "...",
      "happened_at": "2026-09-05T10:00:00.000Z",
      "attributes": { "workspace": "my-workspace", "relative_path": "CLAUDE.md", "extension": ".md" },
      "custom_attributes": { "size_bytes": 4096, "plugin": "hydradb",
        "source": "claude-code-plugin", "description": "Workspace context synced from my-workspace",
        "url": "hydradb://workspace/my-workspace/CLAUDE.md" } }
  ]
}
```

A workspace file's `metadata` becomes `attributes` and its `additional_metadata` becomes `custom_attributes`; `timestamp` becomes `happened_at`. `source`, `description` and `url` have no field of their own on an item, so they ride in `custom_attributes` rather than being dropped — a synced file keeps the same provenance it has on a split database.

Nothing the split lane carried is dropped on the way. `is_markdown` and `user_name` are on the item, the same two fields `MemoryItem` has always had, so a workspace file chunks and renders the same way and keeps its attribution whichever layout it lands on. A conversation's attribution rides on the per-turn `name` instead, which is what the server reads first.

`searchMode: "unified"` and `ingestionMode: "unified"` are accepted as explicit spellings, and `searchMode: "auto"` means `memory` on a split database; the layout always wins.
