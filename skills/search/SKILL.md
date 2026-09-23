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

On a unified database the output has `searchMode: "unified"` and a `unified` object. Use `unified.llmPrompt` (markdown) as the context and cite what you use from it by its number in brackets: `[1]` for result `### 1.`, `[R1]` for forceful relation `### R1.`, `[P1]` for related fact `[P1]`. The structured fields are `unified.chunks[]` (`contextId`, `score`, `content`, `enrichment` (a string), `enrichmentKind`), `unified.graph[]` (`origin`, `pathSummary`) and `unified.forcefulRelations[]` (`via`, `chunk`; linked by the author at ingest, not ranked for the query). Chunks carry no source details; the `contextId` is what identifies them.
