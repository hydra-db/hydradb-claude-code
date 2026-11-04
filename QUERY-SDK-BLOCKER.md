# Query table options and SDK compatibility

The published SDK 2.1.2 strips `include_table_sql` and `table_limit` while serializing query requests. The wrapper bridges these fields into the SDK-serialized JSON using a per-call transport adapter. SDK authentication, timeout/abort, retries and response/error handling remain in use. The bridge is limited to bounded JSON query bodies and should be removed after a compatible SDK is released and vendored. No unpublished SDK is bundled.
