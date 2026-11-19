# Unified rollout preparation

DO NOT MERGE — Unified API is not enabled in production; hold until production rollout is confirmed.

This is an isolated follow-up above PR #14 (`d583953`), not a replacement for the #11 → #13 → #14 stack or the separate production tabular PR #19. The runtime reference is source main `5d45c23840a62fcf38ff13e8deea5587ab1b961c` with the unpublished flag-on SDK JSON preview. No flags, deployments, publication gates, generated SDKs, vendor bytes, dependency pins, or source branches are changed.

The root stack PR #11 currently conflicts with main. This follow-up is tested
against #14, not a merged current-main integration; the stack owners must reconcile
those conflicts and the separate production work before the chain can land.

Keep `layout: "split"` (the default). `layout: "unified"` or `HYDRADB_LAYOUT=unified` is an explicit database choice, not automatic detection. A failed write/delete never changes layout or triggers a differently shaped retry. All reads accept the response shape they actually receive.

The existing unified item mapping, limits, receipt output, host hooks, IDs, capture retry queue, and workspace hashing remain. Unified I/O now uses per-call adapters inside the committed SDK's transport, preserving its authentication, version header, abort/timeout, retry policy, error handling, and response parsing. Typed unified declarations remain blocked on a real SDK release; the separate API/site publication lint failure is not bypassed.

Safe server prompts, including CRLF and whitespace, are injected verbatim instead of fitted to the split budget. Secret redaction still takes precedence. Unified raw structured data and graph/chunk identity remain available without rewriting opaque record keys. Existing bounded-display helpers and their tests remain available; they no longer rewrite the injected server prompt or query JSON.

Workspace mtime is provenance (`custom_attributes.original_timestamp`), not an invented event date. Generated description is `original_description`, because `description` is reserved metadata. Provenance collisions, unsupported rich bodies, invalid dates, reserved keys, and oversized metadata fail rather than silently losing caller data. Missing per-item receipts fail the write; workspace sync rolls back confirmed IDs from a partially failed batch and does not stamp the file as synced.

## Test-contract migration

The #14 baseline intentionally tested behavior this rollout protocol now replaces:

- `conformance/tests.mjs` cases 12 and 13–13c: probe/cache and split-to-unified retry expectations become explicit choice, zero probes, original refusal, and exactly one dispatch.
- The same file's cases 10d–10e: prompt-wrapper/injection-budget expectations become exact safe-prompt equality. Its split goldens and bounded fallback/display checks remain unchanged.
- `conformance/unified-fixes.mjs` cases 4, 6, 9, and 10: hook prompt equality and concurrent explicit choices replace injection fitting and cache/probe expectations, retaining unified chunk-size checks and pure display-fitting tests.
- Generated-provenance expectations and the mocked conversation receipt now match the runtime: no mtime-to-event inference, no reserved `description`, and receipts echo each submitted context ID.

Only the unified query shape golden gains raw fields and identity; every split golden remains byte-identical. The new direct tests exercise existing methods through the real vendored SDK, with offline captures for canonical bodies, auth/version, aborts/errors, one dispatch, concurrency isolation, shape reads, safe prompt fidelity, credential redaction, workspace provenance, missing receipts, and partial rollback. No live HydraDB calls are used.
