import { test } from "node:test";
import assert from "node:assert/strict";
import { createHydraWrapper } from "../scripts/lib/hydra/index.mjs";
import { HydraClient, normalizeRetrievalResponse } from "../scripts/lib/hydra-client.mjs";

test("query forwards additive options and preserves envelope warnings", async () => {
  let request;
  const wrapper = createHydraWrapper({ sdkClient: { query: async (args) => {
    request = args;
    return { success: true, data: { chunks: [] }, meta: { warnings: [{ code: "partial", collections: ["c"] }] } };
  } } });
  const result = await wrapper.context.query({ query: "q", include_table_sql: false, table_limit: 0 });
  assert.equal(request.includeTableSql, false);
  assert.equal(request.tableLimit, 0);
  assert.deepEqual(result.warnings, [{ code: "partial", collections: ["c"] }]);
});

test("retrieval exposes additive structured fields", () => {
  const result = normalizeRetrievalResponse({
    chunks: [{ text: "x", chunk_metadata: { page: 2 } }],
    tabular_data: [{ rows: [[1]] }], temporal_facts: [{ observed_at: "2025-01-01" }],
    graph_context: { query_paths: [{ triplets: [{ source: { name: "a", database: "db", collection: "c", source_id: "s", read_status: "ready" }, relation: { canonical_predicate: "is" }, target: { name: "b" } }] }] },
    warnings: [{ code: "partial", collections: ["c"] }]
  });
  assert.deepEqual(result.chunks[0].chunkMetadata, { page: 2 });
  assert.deepEqual(result.tabularData, [{ rows: [[1]] }]);
  assert.equal(result.temporalFacts[0].observed_at, "2025-01-01");
  assert.deepEqual(result.warnings[0].collections, ["c"]);
  assert.equal(result.graphContext.queryPathsDetailed[0].triplets[0].source.database, "db");
});

test("recall forwards snake_case options through its wrapper", async () => {
  let request;
  const client = new HydraClient({ sdkClient: { query: async (args) => {
    request = args;
    return { success: true, data: { chunks: [] } };
  } } });
  await client.recallKnowledge("q", { include_table_sql: true, table_limit: 7 });
  assert.equal(request.includeTableSql, true);
  assert.equal(request.tableLimit, 7);
});

test("HydraClient preserves metadata keys and redacts sensitive properties", async () => {
  const metadata = {
    customerID: "first", customer_id: "second", nestedMap: {
      customerID: 1, customer_id: 2, password: "short", token: 123,
      secret: { nested: "hidden" }, api_key: "abc", "API key": "def",
      authorization: "bearer", cookie: ["session"], private_key: "key",
      safeText: "password=verylongpassword"
    }, list: [{ accessToken: "secret value", validKey: "visible" }]
  };
  for (const field of ["chunkMetadata", "chunk_metadata"]) {
    const client = new HydraClient({ sdkClient: { query: async () => ({
      success: true, data: { chunks: [{ chunkContent: "hello", [field]: metadata }] }
    }) } });
    const result = await client.recallKnowledge("q");
    const actual = result.chunks[0].chunkMetadata;
    assert.equal(actual.customerID, "first");
    assert.equal(actual.customer_id, "second");
    assert.equal(actual.nestedMap.customerID, 1);
    assert.equal(actual.nestedMap.customer_id, 2);
    for (const key of ["password", "token", "secret", "api_key", "API key", "authorization", "cookie", "private_key"]) {
      assert.equal(actual.nestedMap[key], "[REDACTED]");
    }
    assert.equal(actual.nestedMap.safeText, "[REDACTED:generic-secret]");
    assert.deepEqual(actual.list, [{ accessToken: "[REDACTED]", validKey: "visible" }]);
  }
});

test("vendored SDK recall retains and redacts wire metadata", async () => {
  const client = new HydraClient({ apiKey: "test-key", tenantId: "test-db", fetch: async () =>
    new Response(JSON.stringify({ success: true, data: { chunks: [{
      chunk_content: "hello", chunk_metadata: { customerID: "one", customer_id: "two", password: "short" }
    }] } }), { status: 200, headers: { "content-type": "application/json" } })
  });
  const result = await client.recallKnowledge("q");
  assert.deepEqual(result.chunks[0].chunkMetadata, {
    customerID: "one", customer_id: "two", password: "[REDACTED]"
  });
});
