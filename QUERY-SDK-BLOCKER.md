# Query table options and SDK compatibility

## Production response retention

The API published at source main `431899c27111ab0d7b9d9f29f35f086b20eeb1e2` documents split `graph` and `forceful_relations` roots and relation-evidence `properties`. The committed SDK already passes these response extensions through; the hand-owned adapter retains them as `graph` and `forcefulRelations` with structured secret redaction. Opaque metadata/property keys keep their original spelling. Legacy graph context, additional context, prompt formatting, and host outputs are unchanged when the fields are absent.

Published TypeScript SDK 2.1.8 still lacks typed declarations for these roots and properties. A compatible typed SDK release remains a blocker to using generated types; no unpublished version, dependency bump, vendor edit, new endpoint, or unified-layout behavior is introduced here. The existing request-side table-option bridge remains separate and unchanged.

The published SDK 2.1.2 strips `include_table_sql` and `table_limit` while serializing query requests. The wrapper bridges these fields into the SDK-serialized JSON using a per-call transport adapter. SDK authentication, timeout/abort, retries and response/error handling remain in use. The bridge is limited to bounded JSON query bodies and should be removed after a compatible SDK is released and vendored. No unpublished SDK is bundled.
