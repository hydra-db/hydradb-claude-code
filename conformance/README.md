# Conformance

This directory is the plugin's half of the shared anti-drift gate described in
`CONTRACT.md` §4. It proves the plugin's wrapper speaks the canonical HydraDB
vocabulary and does not diverge from the other clients or from the pinned SDK.

## Files

- **`vectors.json`** — the shared, language-neutral fixtures (request shape in →
  expected canonical SDK call out). **Identical across all four client repos;
  maintained centrally.** Do not edit a single repo's copy — a change is one PR
  per repo against the master.
- **`runner.mjs`** — drives every vector through the canonical wrapper
  (`scripts/lib/hydra/`) against the **real vendored SDK** with a capturing
  `fetch`, and asserts the actual wire call each vector expects (method, scope,
  content-type, forbidden/required fields, client-id preservation).
- **`tests.mjs`** — HTTP-level wire tests (the repo's first) and golden `--json`
  shape snapshots:
  - the DX-G-002 guard: knowledge ingest is `multipart/form-data` with a
    top-level `tenant_id` and the source in `app_knowledge` (never
    `application/json`, never `app_sources`), preserving the client-assigned id;
  - delete-by-kind routing and the "deleted nothing" surfacing fix;
  - the recall round-trip (camelCase SDK response → normalized chunks);
  - golden key-shape snapshots of `query`/`doctor`/`last-recall` `--json`, the
    shapes marketplace-shipped skill files parse;
  - the PRO-1618 unified contract: no `type` on a unified database on any
    call, the JSON ingest body with list key `context` pinned exactly, the
    four-key query response parsed by shape with `llm_prompt` injected
    verbatim, the 202 parsed for `results[].source_id`, and split output
    pinned byte-for-byte against goldens cut from the pre-contract code.
- **`fixtures.mjs`**: the split (v2) and unified (four-key) query responses
  the wire tests and goldens share.
- **`unified-query-envelope.json`**: a real unified `/query` envelope as the
  server's own handler test renders it (enrichment string, `enrichment_kind`,
  markdown `llm_prompt`), read end to end by a wire test.
- **`golden/`**: committed key-shape snapshots plus the two whole-text split
  goldens. Regenerate intentionally with `UPDATE_GOLDEN=1 npm run check` and
  review the diff; a change to a `split-*` golden is a split regression.

## Running

All of it runs as part of CI via:

```bash
npm run check
```

`check.mjs` calls `runConformance()`, `runHttpTests()`, and `runGoldenTests()`.
