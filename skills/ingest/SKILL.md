---
name: ingest
description: Ingest the current workspace's markdown-first context files into HydraDB. Use when the user wants an immediate sync or refresh of workspace knowledge instead of waiting for automatic sync.
disable-model-invocation: true
allowed-tools: Bash(node *)
argument-hint: "[--force]"
---

Ingest the current workspace context files into HydraDB:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/plugin.mjs" ingest --json $ARGUMENTS
```

Report:

- how many files were scanned
- how many were synced
- how many were skipped
- any errors

If the user asks why specific files were skipped, explain it from the JSON output and the current config. Remember that the ingest path may redact or skip sensitive-looking content before upload.

Also mention whether files were ingested as memory or knowledge, since that depends on `ingestionMode`.

This is the canonical command; `/hydradb:sync-workspace`, `/hydradb:reindex`, `/hydradb:remember`, and `/hydradb:save-session` are deprecated aliases that still work.
