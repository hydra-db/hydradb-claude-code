# Query table options and SDK compatibility

The wrapper accepts `include_table_sql` / `table_limit` (also camelCase) and forwards them to the SDK request object. The currently vendored published SDK 2.1.2 strips these unknown fields when serializing the HTTP request. The latest published SDK 2.1.8 also lacks this contract. These options therefore do not reach the API until a compatible SDK is released and the vendor bundle is rebuilt. The SDK spy tests validate the wrapper seam, not wire serialization. No unpublished SDK is bundled.
