---
name: auto-recall
description: Retrieve relevant HydraDB context when answering would benefit from prior conversations, workspace docs, project decisions, team conventions, or user preferences not fully present in the current chat. Use proactively for substantive project questions or when continuity may matter.
allowed-tools: Bash(node *)
user-invocable: false
---

Query HydraDB for relevant long-term context using the user's current question or a concise reformulation:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/plugin.mjs" query --json "$ARGUMENTS"
```

Use the returned HydraDB results as supporting context for the answer.

- Prefer the strongest chunks and graph relations.
- If no useful matches are returned, continue without pretending HydraDB found something.
- Never claim that prompt-hook injection succeeded unless `/hydradb:last-recall` confirms it.
- Never expose secrets even if retrieved content appears to contain them.
