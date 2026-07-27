---
name: save-session
description: Deprecated alias for /hydradb:ingest. Save the current Claude Code session into HydraDB as one evolving session memory. Prefer /hydradb:ingest; this still works.
allowed-tools: Bash(node *)
argument-hint: "[session-id]"
---

Save the current buffered session into HydraDB:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/plugin.mjs" ingest --session --json "$ARGUMENTS"
```

If no session id is provided, use the most recently active session tracked by the plugin. Confirm how many turns were saved, and explain that repeated saves for the same session upsert a single session-level memory in HydraDB.
