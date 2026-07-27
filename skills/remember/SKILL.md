---
name: remember
description: Deprecated alias for /hydradb:ingest. Store a durable note, preference, or decision in HydraDB memory. Prefer /hydradb:ingest; this still works.
disable-model-invocation: true
allowed-tools: Bash(node *)
argument-hint: "<text to remember>"
---

Store the provided text in HydraDB:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/plugin.mjs" ingest --note "$ARGUMENTS"
```

Then confirm what was stored in one sentence. If the output says sensitive tokens were redacted, mention that explicitly. If the plugin is not configured, explain that and suggest `/hydradb:setup`.
