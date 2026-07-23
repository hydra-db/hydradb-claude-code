---
name: doctor
description: Inspect HydraDB plugin configuration, active settings, and sync state for the current workspace. Use when the user asks if HydraDB is working or why sync or recall is not happening.
disable-model-invocation: true
allowed-tools: Bash(node *)
---

Check HydraDB plugin health for the current workspace:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/plugin.mjs" doctor --json
```

Summarize:

- whether the plugin is configured
- which config layers or files were resolved
- which API base URL is active
- the active collection (sub-tenant)
- whether auto-recall and auto-ingest are enabled
- the active `captureMode`, `searchMode`, and `ingestionMode`
- the active max prompt context budget
- the active HydraDB read and write timeouts
- how many files and sessions are currently tracked
- any config validation errors

If configuration is missing or broken, point the user to `/hydradb:setup`. If `captureMode` is `off`, mention that manual session saving is available via `/hydradb:ingest`.

If the user is specifically debugging prompt-time recall, point them to `/hydradb:last-recall`.

Do not infer that `UserPromptSubmit` hooks failed or that no HydraDB context was injected based on this output alone. It only reports configuration and tracked state; use `/hydradb:last-recall` for prompt-time recall evidence.

This is the canonical command; `/hydradb:status` is a deprecated alias that still works.
