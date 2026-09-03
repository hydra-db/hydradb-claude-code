# HydraDB Plugin Usage

This guide covers the day-to-day setup and operating modes for the HydraDB Claude Code plugin.

## Install paths

### Public GitHub install

After the repo is public, install it in Claude Code with:

```text
/plugin marketplace add usecortex/hydradb-claude-code
/plugin install hydradb@hydradb
```

Then reload or restart Claude Code.

### Local checkout install

If you are testing the plugin from source before publishing, add the absolute path to the repo:

```text
/plugin marketplace add /absolute/path/to/hydradb-claude-code
/plugin install hydradb@hydradb
```

## 1. Configure HydraDB

At minimum, provide:

```bash
export HYDRADB_API_KEY="..."
export HYDRADB_TENANT_ID="tenant_123"
export HYDRADB_SUB_TENANT_ID=""
```

Then add a workspace config if you want repo-specific behavior:

```json
{
  "subTenantId": "claude-my-workspace",
  "captureMode": "session-upsert",
  "searchMode": "memory",
  "ingestionMode": "memory",
  "requestTimeoutMs": 15000,
  "writeTimeoutMs": 15000
}
```

The plugin reads config from:

1. built-in defaults
2. `HYDRADB_PLUGIN_CONFIG`
3. `${CLAUDE_PLUGIN_DATA}/config.json`
4. `./.hydradb-plugin-data/config.json`
5. `.hydradb-plugin.json`
6. `.hydradb-plugin.local.json`
7. environment variable overrides

`subTenantId` is required explicitly. If you want HydraDB to use its default sub-tenant, set `subTenantId` to `""` instead of leaving it out.

## 2. Pick your automation level

### Default mode

```json
{
  "autoRecall": true,
  "autoIngest": true,
  "captureMode": "session-upsert",
  "searchMode": "memory",
  "ingestionMode": "memory"
}
```

Use this when you want:

- markdown docs synced into HydraDB memory with `infer`
- prompt-time recall from memory by default
- one evolving session memory by default instead of isolated turn snapshots

### Rolling full-session mode

```json
{
  "captureMode": "session-upsert"
}
```

Use this when you want one evolving session memory that gets upserted after each assistant response.

### Hybrid mode

```json
{
  "captureMode": "both",
  "searchMode": "both"
}
```

Use this when you want:

- isolated turn memories
- a rolling session transcript
- memory recall and knowledge recall in parallel

### Manual-save mode

```json
{
  "captureMode": "off"
}
```

Use this when you want automatic recall and sync, but no automatic memory writes from the conversation.

## 3. Understand the three mode knobs

### `captureMode`

- `turn`: save isolated user/assistant pairs
- `session-upsert`: keep one evolving session transcript
- `both`: do both
- `off`: do not auto-save conversation content

### `searchMode`

- `memory`: recall memories only
- `both`: recall memories and knowledge in parallel
- `knowledge`: recall knowledge only
- `unified` / `auto`: explicit spellings; `auto` means `memory` on a split database

On a unified database (created with `type: "unified"`, see `hydradb-api-info/unified-databases.md`) this knob is ignored: there is one corpus, and the plugin recalls it as a single `CONTEXT` section and ingests everything through the unified `items[]` body. The layout is read once from `GET /databases`.

### `ingestionMode`

- `memory`: sync workspace docs into memory using `infer`
- `knowledge`: sync workspace docs as knowledge
- `auto`: prefer memory, but fall back to knowledge for larger files

If you use `ingestionMode: "auto"`, pair it with `searchMode: "both"` so auto recall can see both storage paths.

## 4. Network timeout controls

- `requestTimeoutMs`: timeout for recall and other read-style HydraDB requests
- `writeTimeoutMs`: timeout for memory ingestion and workspace sync uploads

Example:

```json
{
  "requestTimeoutMs": 10000,
  "writeTimeoutMs": 20000
}
```

For the blocking Claude hooks, it is safest to keep these below the hook time budgets unless you intentionally want slower retries.

These can also be set with:

- `HYDRADB_REQUEST_TIMEOUT_MS`
- `HYDRADB_WRITE_TIMEOUT_MS`

## 5. What gets synced from the workspace

By default the plugin syncs only markdown-first workspace context:

- `CLAUDE.md`
- `.claude/**/*.md`
- `**/*.md`
- `**/*.mdx`

This is intentional. HydraDB is not being used here as a code indexer.

If you want text files too, extend `includeGlobs`:

```json
{
  "includeGlobs": [
    "CLAUDE.md",
    ".claude/**/*.md",
    "**/*.md",
    "**/*.mdx",
    "**/*.txt"
  ]
}
```

## 6. Ignore marker

The default ignore marker is `hydra-ignore`.

You can place it:

- in a file to keep that file out of workspace sync
- in a prompt to skip saving that prompt and its reply to HydraDB

Important: the ignore marker skips capture and sync. It does not disable recall for that prompt.

## 7. User-facing commands

- `/hydradb:setup`
- `/hydradb:status`
- `/hydradb:last-recall`
- `/hydradb:search <query>`
- `/hydradb:remember <note>`
- `/hydradb:save-session`
- `/hydradb:sync-workspace [--force]`

The plugin also exposes CLI entry points through `node scripts/plugin.mjs` for local testing.

If auto-recall feels unclear, run `/hydradb:last-recall` to inspect the most recent prompt-time recall payload the plugin recorded.

The plugin also ships a hidden `auto-recall` skill that Claude can invoke proactively for long-term context when prompt-hook recall is unavailable or incomplete.

For deeper hook debugging, start Claude Code with `HYDRADB_DEBUG=true`. The plugin will keep a best-effort JSONL trace in `${CLAUDE_PLUGIN_DATA}/debug.log` or `./.hydradb-plugin-data/debug.log`.

## 8. What auto recall injects

On each user prompt, the plugin can inject a bounded `<hydradb-context>` block containing:

- retrieved memory chunks
- retrieved knowledge chunks
- entity path chains from graph context
- chunk-level graph relations
- extra linked context when HydraDB returns it

This content is explicitly framed as reference material, not as new instructions.

## 9. Recommended starting presets

### Team docs + durable memory

```json
{
  "captureMode": "session-upsert",
  "searchMode": "memory",
  "ingestionMode": "memory"
}
```

### Cross-session continuity

```json
{
  "captureMode": "session-upsert",
  "searchMode": "memory",
  "ingestionMode": "memory"
}
```

### Maximum recall coverage

```json
{
  "captureMode": "both",
  "searchMode": "both",
  "ingestionMode": "auto"
}
```
