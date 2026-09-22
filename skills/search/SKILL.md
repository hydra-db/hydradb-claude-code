---
name: search
description: Deprecated alias for /hydradb:query. Manually query HydraDB using the configured search mode. Prefer /hydradb:query; this still works.
disable-model-invocation: true
allowed-tools: Bash(node *)
argument-hint: "<query>"
---

Run bounded retrieval for the provided query:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/plugin.mjs" query --json "$ARGUMENTS"
```

Summarize the strongest matches from whichever backends are active in the configured `searchMode`. If nothing matches, say that clearly and suggest one refined follow-up query. Never print raw secret values even if retrieved content contains them.

On a unified database the output has `searchMode: "unified"` and a `unified` object. Use `unified.llmPrompt` as the context and keep its bracketed citation labels (`[1]`, `[R1]`, `[P1]`) when you cite something from it. The structured fields are `unified.chunks[]` (`contextId`, `score`, `content`, `enrichment.text`), `unified.graph[]` (`pathSummary`) and `unified.relations[]` (`via`, `chunk`). Chunks carry no source details; the `contextId` is what identifies them.
