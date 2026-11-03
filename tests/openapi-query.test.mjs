import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHydraContextBlock } from "../scripts/lib/context-format.mjs";
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
      customerID: 1, customer_id: 2, token_count: 120, tokenizer: "cl100k_base", password: "short", token: 123,
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
    assert.equal(actual.nestedMap.token_count, 120);
    assert.equal(actual.nestedMap.tokenizer, "cl100k_base");
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

test("real SDK serializes per-request table options and preserves record keys", async () => {
  const sent = [];
  const client = new HydraClient({ apiKey: "test-key", tenantId: "db", fetch: async (url, init) => {
    sent.push({ url: String(url), init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ success: true, data: { chunks: [],
      tabular_data: { records: [{ customerID: 1, customer_id: 2, nestedMap: { fieldID: 3, field_id: 4 } }] }
    } }), { status: 200, headers: { "content-type": "application/json" } });
  } });
  const [a, b] = await Promise.all([
    client.recallKnowledge("a", { include_table_sql: false, table_limit: 0 }),
    client.recallKnowledge("b", { include_table_sql: true, table_limit: 9 })
  ]);
  assert.deepEqual(a.tabularData.records[0], { customerID: 1, customer_id: 2, nestedMap: { fieldID: 3, field_id: 4 } });
  assert.deepEqual(b.tabularData, a.tabularData);
  assert.deepEqual(sent.map(x => [x.body.query, x.body.include_table_sql, x.body.table_limit]).sort(), [["a", false, 0], ["b", true, 9]]);
  assert.ok(sent.every(x => x.init.signal && x.init.method === "POST"));
  assert.ok(sent.every(x => new Headers(x.init.headers).get("authorization")));
});

test("agent context includes bounded table and warnings from real recall", async () => {
  async function recall(data, warnings) {
    const client = new HydraClient({ apiKey: "test-key", tenantId: "db", fetch: async () =>
      new Response(JSON.stringify({ success: true, data, meta: { warnings } }), { status: 200, headers: { "content-type": "application/json" } }) });
    return client.recallKnowledge("q");
  }
  const table = { records: [{ customerID: "A", customer_id: "B" }] };
  for (const data of [{ chunks: [], tabular_data: table }, { chunks: [{ chunk_content: "prose" }], tabular_data: table, llm_prompt: "server prompt" }]) {
    const result = await recall(data, [{ code: "PARTIAL", message: "incomplete", collections: ["db"] }]);
    const context = buildHydraContextBlock({ query: "q", knowledge: result, maxContextChars: 3000 });
    assert.match(context, /customerID/); assert.match(context, /customer_id/);
    assert.match(context, /PARTIAL/); assert.match(context, /incomplete/);
    if (data.chunks.length) assert.match(context, /prose|server prompt/);
  }
  const warningOnly = await recall({ chunks: [] }, [{ code: "PARTIAL", message: "incomplete" }]);
  assert.match(buildHydraContextBlock({ query: "q", knowledge: warningOnly, maxContextChars: 3000 }), /PARTIAL/);
  const huge = await recall({ chunks: [], tabular_data: { records: Array.from({length: 100}, (_, i) => ({ value: "x".repeat(300), i })) } }, []);
  const context = buildHydraContextBlock({ query: "q", knowledge: huge, maxContextChars: 1200 });
  assert.ok(context.length <= 1200); assert.match(context, /omitted/i);
});

test("table bridge preserves SDK error handling and timeout cancellation", async () => {
  let calls = 0;
  const failing = new HydraClient({ apiKey: "test", tenantId: "db", fetch: async () => {
    calls += 1;
    return new Response(JSON.stringify({ message: "denied" }), { status: 403, headers: { "content-type": "application/json" } });
  } });
  await assert.rejects(failing.recallKnowledge("q", { include_table_sql: true }), /403/);
  assert.equal(calls, 1);
  let aborted = false;
  const slow = new HydraClient({ apiKey: "test", tenantId: "db", requestTimeoutMs: 5, fetch: async (_url, init) =>
    new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => {
      aborted = true; reject(new DOMException("aborted", "AbortError"));
    }, { once: true }))
  });
  await assert.rejects(slow.recallKnowledge("q", { table_limit: 2 }), /timed out|aborted|timeout/i);
  assert.equal(aborted, true);
});

test("table records and agent context redact segmented credentials without erasing metadata", async () => {
  const record = {
    admin_password: "p@ss", signing_secret: "signing", aws_secret_access_key: "aws-key",
    secret_key: "secret-key-value", webhook_secret: "webhook-value",
    "x-api-key": "header-api-value", personal_access_token: "personal-token-value",
    dbPrivateKey: { value: "private-value" }, authorization_header: "auth-value", session_cookie: "cookie-value",
    token_count: 120, tokenizer: "cl100k_base", cookie_policy_enabled: true
  };
  const client = new HydraClient({ apiKey: "test", tenantId: "db", fetch: async () =>
    new Response(JSON.stringify({ success: true, data: { chunks: [], tabular_data: { records: [record] } } }),
      { status: 200, headers: { "content-type": "application/json" } })
  });
  const result = await client.recallKnowledge("q");
  const actual = result.tabularData.records[0];
  for (const key of ["admin_password", "signing_secret", "aws_secret_access_key", "secret_key", "webhook_secret", "x-api-key", "personal_access_token", "dbPrivateKey", "authorization_header", "session_cookie"]) {
    assert.equal(actual[key], "[REDACTED]", key);
  }
  assert.equal(actual.token_count, 120);
  assert.equal(actual.tokenizer, "cl100k_base");
  assert.equal(actual.cookie_policy_enabled, true);
  const text = buildHydraContextBlock({ query: "q", knowledge: result, maxContextChars: 3000 });
  for (const secret of ["p@ss", "signing\"", "aws-key", "secret-key-value", "webhook-value", "header-api-value", "personal-token-value", "private-value", "auth-value", "cookie-value"]) assert.ok(!text.includes(secret), secret);
  assert.match(text, /"token_count":120/);
  assert.match(text, /"tokenizer":"cl100k_base"/);
  assert.match(text, /"cookie_policy_enabled":true/);
});
