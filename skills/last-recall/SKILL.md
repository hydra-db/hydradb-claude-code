---
name: last-recall
description: Show the most recent auto-recall payload captured by the HydraDB plugin. Use when debugging whether UserPromptSubmit recall ran, what HydraDB returned, or what was injected into context.
disable-model-invocation: true
allowed-tools: Bash(node *)
---

Inspect the last auto-recall payload recorded by the plugin:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/plugin.mjs" last-recall --json
```

Summarize:

- whether auto-recall was skipped or executed
- the skip reason, if any
- how many memory and knowledge chunks were returned (on a unified database: `unifiedCount`, `unifiedGraphPathCount`, `unifiedForcefulRelationCount`)
- whether an `additionalContext` block was emitted
- any recall errors

If `additionalContext` is present, show the important parts of what would have been injected into Claude's context.
