import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig, DEFAULTS } from "../scripts/lib/config.mjs";
import { syncWorkspace } from "../scripts/lib/workspace-sync.mjs";
import { buildHydraContextBlock } from "../scripts/lib/context-format.mjs";
import { createHydraWrapper } from "../scripts/lib/hydra/index.mjs";
import { HydraClient, normalizeRetrievalResponse } from "../scripts/lib/hydra-client.mjs";

const unifiedFixture = {
  chunks: [{ chunk_id: "chunk-1", context_id: "context-1", content: "whole content", score: 0.8,
    enrichment: "whole enrichment", received_at: "2026-11-19T00:00:00Z" }],
  graph: [{ origin: "query_path", path_summary: "summary", triplets: [{
    source: { entity_id: "entity-1", name: "one" },
    relation: { predicate: "uses", context: "evidence", relationship_id: "edge-1", chunk_id: "chunk-1", timestamp: 1.5 },
    target: { entity_id: "entity-2", name: "two" }
  }] }],
  forceful_relations: [{ via: { from: "context-1", to: "context-2" }, chunk: {
    chunk_id: "chunk-2", context_id: "context-2", content: "linked content", score: 0.7
  } }],
  llm_prompt: "  Server prompt\r\n" + "complete content ".repeat(800) + "\r\n  ",
  tabular_data: { records: [{ customerID: 1, customer_id: 2, nestedMap: { keyID: 3 } }] }
};

test("unified query survives the real SDK and is read by shape in either layout", async () => {
  for (const layout of ["split", "unified"]) {
    let sent;
    const client = new HydraClient({ apiKey: "test-key", tenantId: "db", layout, fetch: async (url, init) => {
      sent = JSON.parse(init.body);
      assert.equal(new Headers(init.headers).get("API-Version"), "2");
      return Response.json({ success: true, data: unifiedFixture });
    } });
    const result = await client.recallKnowledge("q");
    assert.equal(result.layout, "unified");
    assert.deepEqual(result.raw.chunks, unifiedFixture.chunks);
    assert.deepEqual(result.raw.graph, unifiedFixture.graph);
    assert.deepEqual(result.raw.forceful_relations, unifiedFixture.forceful_relations);
    assert.deepEqual(result.tabular_data, unifiedFixture.tabular_data);
    assert.equal(result.llmPrompt, unifiedFixture.llm_prompt);
    assert.equal(sent.type, layout === "split" ? "knowledge" : undefined);
    assert.equal(buildHydraContextBlock({ query: "q", unified: result, maxContextChars: 512 }), unifiedFixture.llm_prompt);
  }
});

test("a supplied empty unified prompt does not reconstruct chunk content", () => {
  const result = normalizeRetrievalResponse({ ...unifiedFixture, llm_prompt: "" });
  assert.equal(buildHydraContextBlock({ unified: result, maxContextChars: 512 }), "");
});

test("unified real-SDK responses redact credentials without rewriting opaque keys or dropping warnings", async () => {
  const credential = "registered-test-credential-value";
  const fixture = structuredClone(unifiedFixture);
  fixture.chunks[0].content = `stored ${credential}`;
  fixture.graph[0].path_summary = `graph ${credential}`;
  fixture.tabular_data.records[0] = { customerID: "one", customer_id: "two", nestedMap: { keyID: "safe", admin_password: "sensitive" }, text: credential };
  fixture.llm_prompt = `prompt ${credential}`;
  const client = new HydraClient({ apiKey: credential, tenantId: "db", layout: "unified", fetch: async () =>
    Response.json({ success: true, data: fixture, meta: { warnings: [{ code: "partial", collections: ["collection"] }] } }) });
  const result = await client.recallKnowledge("q");
  assert.ok(!JSON.stringify(result).includes(credential));
  assert.equal(result.tabular_data.records[0].customerID, "one");
  assert.equal(result.tabular_data.records[0].customer_id, "two");
  assert.equal(result.tabular_data.records[0].nestedMap.keyID, "safe");
  assert.equal(result.tabular_data.records[0].nestedMap.admin_password, "[REDACTED]");
  assert.deepEqual(result.warnings, [{ code: "partial", collections: ["collection"] }]);
  assert.ok(!buildHydraContextBlock({ unified: result }).includes(credential));
});

test("unified existing methods reject unsupported input before mapping or dispatch", async () => {
  let calls = 0;
  const client = new HydraClient({ layout: "unified", fetch: async () => { calls++; throw new Error("must not dispatch"); } });
  await assert.rejects(() => client.addMemories([{ text: "body", unknown_body: "lost" }]), /unsupported/);
  await assert.rejects(() => client.addMemories([{ user_assistant_pairs: [{ user: "hello", assistant: "world", extra: "lost" }] }]), /unsupported/);
  await assert.rejects(() => client.uploadKnowledge([{ content: { html: "<b>lost</b>" } }]), /rich content/);
  await assert.rejects(() => client.uploadKnowledge([{ content: { text: "body" }, extra: "lost" }]), /unsupported/);
  assert.equal(calls, 0);
});

test("unified layout sends existing writes as canonical JSON through the SDK", async () => {
  const sent = [];
  const client = new HydraClient({ apiKey: "test-key", tenantId: "db", subTenantId: "collection", layout: "unified",
    fetch: async (url, init) => {
      const headers = new Headers(init.headers);
      assert.equal(headers.get("content-type"), "application/json");
      assert.equal(headers.get("authorization"), "Bearer test-key");
      assert.equal(headers.get("API-Version"), "2");
      assert.ok(init.signal instanceof AbortSignal);
      const body = JSON.parse(init.body);
      sent.push(body);
      assert.equal(body.database, "db");
      assert.equal(body.collection, "collection");
      assert.equal(body.type, undefined);
      assert.equal(body.kind, undefined);
      for (const item of body.context) {
        assert.equal(Boolean(item.text) !== Boolean(item.conversation), true);
        for (const key of ["metadata", "additional_metadata", "context_category", "type", "kind"]) assert.equal(item[key], undefined);
      }
      return Response.json({ success: true, data: { results: body.context.map(item => ({ id: item.context_id, status: "queued" })), success_count: body.context.length, failed_count: 0 } }, { status: 202 });
    } });
  await client.addTextMemory("note", { sourceId: "note-id", infer: false });
  await client.addConversationMemory("question", "answer", { sourceId: "turn-id", userName: "Ada" });
  await client.uploadKnowledge([{ id: "file-id", title: "file.md", content: { text: "workspace content" },
    metadata: { customerID: 1, customer_id: 2 }, additional_metadata: { nestedMap: { keyID: 3 } }, timestamp: "2026-11-19T00:00:00Z", url: "hydradb://workspace/file.md" }]);
  assert.equal(sent.length, 3);
  assert.equal(sent[0].context[0].context_id, "note-id");
  assert.equal(sent[0].context[0].enrich, false);
  assert.deepEqual(sent[1].context[0].conversation, [{ role: "user", content: "question" }, { role: "assistant", content: "answer" }]);
  assert.equal(sent[1].context[0].user_name, "Ada");
  assert.deepEqual(sent[2].context[0].attributes, { customerID: 1, customer_id: 2 });
  assert.deepEqual(sent[2].context[0].custom_attributes.nestedMap, { keyID: 3 });
  assert.equal(sent[2].context[0].happened_at, undefined);
  assert.equal(sent[2].context[0].custom_attributes.original_timestamp, "2026-11-19T00:00:00Z");
});

test("unified delete preserves per-id reconciliation without a split selector", async () => {
  const client = new HydraClient({ apiKey: "test-key", tenantId: "db", layout: "unified", fetch: async (_, init) => {
    assert.equal(init.method, "DELETE");
    assert.equal(JSON.parse(init.body).type, undefined);
    return Response.json({ success: true, data: { results: [{ id: "a", deleted: true }, { id: "b", deleted: false }] } });
  } });
  const result = await client.deleteKnowledge(["a", "b"]);
  assert.deepEqual(result.deletedIds, ["a"]);
  assert.deepEqual(result.failedIds, ["b"]);
});

test("layout is explicit and failed split writes are never retried as unified", async () => {
  assert.throws(() => new HydraClient({ layout: "auto" }), /layout/i);
  let calls = 0;
  const client = new HydraClient({ apiKey: "test-key", tenantId: "db", fetch: async () => {
    calls++;
    return Response.json({ error: "this database is unified: send context[]" }, { status: 400 });
  } });
  await assert.rejects(() => client.addTextMemory("note"), /400/);
  assert.equal(calls, 1);
});

test("unified SDK bridges isolate concurrent requests and retain SDK errors and aborts", async () => {
  const seen = [];
  const client = new HydraClient({ apiKey: "test-key", tenantId: "db", layout: "unified", writeTimeoutMs: 10,
    fetch: async (_, init) => {
      const body = JSON.parse(init.body);
      seen.push(body);
      if (body.context[0].text === "refuse") return Response.json({ error: "refused" }, { status: 400 });
      if (body.context[0].text === "abort") return new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
      await Promise.resolve();
      return Response.json({ success: true, data: { results: body.context.map(item => ({ id: item.context_id, status: "queued" })) } }, { status: 202 });
    } });
  await Promise.all([client.addTextMemory("first", { sourceId: "first" }), client.addTextMemory("second", { sourceId: "second" })]);
  assert.deepEqual(seen.map(body => body.context[0].context_id).sort(), ["first", "second"]);
  await assert.rejects(() => client.addTextMemory("refuse"), /400/);
  await assert.rejects(() => client.addTextMemory("abort"), /timed out|abort/i);
  assert.equal(seen.length, 4);
});

test("layout config and env select one unified query without changing host JSON", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hydradb-unified-"));
  const saved = process.env.HYDRADB_LAYOUT;
  try {
    await fs.writeFile(path.join(directory, "config.json"), JSON.stringify({ apiKey: "test-key", tenantId: "db" }));
    process.env.HYDRADB_LAYOUT = "unified";
    assert.equal((await loadConfig(directory, directory)).config.layout, "unified");
    process.env.HYDRADB_LAYOUT = "automatic";
    assert.ok((await loadConfig(directory, directory)).errors.some(message => message.includes("layout")));
    assert.equal((await loadConfig(directory, directory)).configured, false);
    const code = `
      import assert from 'node:assert/strict';
      let calls = 0;
      globalThis.fetch = async (url, init) => {
        calls++;
        assert.ok(String(url).endsWith('/query'));
        assert.equal(JSON.parse(init.body).type, undefined);
        return Response.json({success:true,data:${JSON.stringify(unifiedFixture)}});
      };
      process.argv = ['node', 'plugin', 'user-prompt-submit'];
      process.on('beforeExit', () => assert.equal(calls, 1));
      await import(${JSON.stringify(new URL("../scripts/plugin.mjs", import.meta.url).href)});
    `;
    const output = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", code], {
      cwd: directory, encoding: "utf8", input: JSON.stringify({ session_id: "unified-test", prompt: "question" }),
      env: { ...process.env, HYDRADB_COLLECTION: "collection", HYDRADB_LAYOUT: "unified", HYDRADB_API_KEY: "test-key", HYDRADB_DATABASE: "db",
        HYDRADB_SEARCH_MODE: "both", CLAUDE_PLUGIN_DATA: directory, PLUGIN_ROOT: path.resolve(new URL("..", import.meta.url).pathname) }
    }));
    assert.equal(output.hookSpecificOutput?.additionalContext ?? output.additional_context, unifiedFixture.llm_prompt);
  } finally {
    if (saved == null) delete process.env.HYDRADB_LAYOUT; else process.env.HYDRADB_LAYOUT = saved;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("unified knowledge workspace preserves mtime provenance without inventing an event date", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hydradb-unified-knowledge-"));
  try {
    const file = path.join(directory, "doc.md");
    await fs.writeFile(file, "# Workspace content");
    const client = new HydraClient({ apiKey: "test-key", tenantId: "db", subTenantId: "collection", layout: "unified", fetch: async (_, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.database, "db");
      assert.equal(body.collection, "collection");
      const item = body.context[0];
      assert.equal(item.happened_at, undefined);
      assert.equal(item.tenant_id, undefined);
      assert.equal(item.sub_tenant_id, undefined);
      assert.equal(item.custom_attributes.original_timestamp, new Date((await fs.stat(file)).mtimeMs).toISOString());
      const reserved = new Set("chunk_id sub_tenant_id source_id chunk_content chunk_content_embedding chunk_content_sparse source_title source_url source_upload_time source_last_updated_time source_type source_collection source_owner source_collaborator description description_embedding inferred_content inferred_content_embedding base_metadata layout document_metadata document_metadata_embedding embedding metadata evidence_kind evidence_subject chunk_level parent_chunk_id chunk_generation".split(" "));
      for (const map of [item.attributes, item.custom_attributes]) {
        for (const key of Object.keys(map)) assert.ok(!reserved.has(key.toLowerCase()), `${key} is reserved by the pinned runtime`);
      }
      assert.ok(Buffer.byteLength(JSON.stringify(item.custom_attributes)) <= 1024);
      assert.equal(item.custom_attributes.description, undefined);
      assert.equal(item.custom_attributes.original_description, "Workspace context synced from workspace");
      return Response.json({ success: true, data: { results: [{ id: item.context_id, status: "queued" }] } }, { status: 202 });
    } });
    const state = { files: {}, sessions: {} };
    const args = { client, config: { ...DEFAULTS, layout: "unified", ingestionMode: "knowledge" }, projectRoot: directory, workspaceName: "workspace", state };
    assert.equal((await syncWorkspace(args)).synced, 1);
    const tracked = structuredClone(state.files[file]);
    assert.equal((await syncWorkspace(args)).synced, 0);
    assert.deepEqual(state.files[file], tracked);
    await assert.rejects(() => client.uploadKnowledge([{ content: { text: "body" }, tenant_id: "another" }]), /conflicts/);
    await assert.rejects(() => client.uploadKnowledge([{ content: { text: "body" }, sub_tenant_id: "another" }]), /conflicts/);
    await assert.rejects(() => client.addMemories([{ text: "body", observation_date: "2026-11-19T00:00:00Z" }]), /YYYY-MM-DD/);
    await assert.rejects(() => client.uploadKnowledge([{ content: { text: "body" }, description: "provenance", additional_metadata: { original_description: "caller value" } }]), /conflict/);
    await assert.rejects(() => client.uploadKnowledge([{ content: { text: "body" }, additional_metadata: { note: "x".repeat(1024) } }]), /1024|1 KiB/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("Claude unified writes refuse missing receipts and workspace rolls back acknowledged chunks", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hydradb-claude-partial-"));
  try {
    await fs.writeFile(path.join(directory, "doc.md"), "# Document\n" + "paragraph ".repeat(35));
    const calls = [];
    const client = new HydraClient({ apiKey: "test-key", tenantId: "db", layout: "unified", fetch: async (_, init) => {
      const body = JSON.parse(init.body);
      calls.push({ method: init.method, body });
      if (init.method === "DELETE") return Response.json({ success: true, data: { results: body.ids.map(id => ({ id, deleted: true })) } });
      return Response.json({ success: true, data: { results: [{ id: body.context[0].context_id, status: "queued" }] } }, { status: 202 });
    } });
    await assert.rejects(() => client.addMemories([{ source_id: "a", text: "a" }, { source_id: "b", text: "b" }]), error => {
      assert.deepEqual(error.ingest.contextIds, ["a"]);
      assert.equal(error.ingest.failedCount, 1);
      return true;
    });
    calls.length = 0;
    const state = { files: {}, sessions: {} };
    const summary = await syncWorkspace({ client, config: { ...DEFAULTS, layout: "unified", maxMemoryCharsPerChunk: 120 }, projectRoot: directory,
      workspaceName: "workspace", state });
    assert.equal(summary.synced, 0);
    assert.deepEqual(state.files, {});
    assert.equal(calls[1].method, "DELETE");
    assert.deepEqual(calls[1].body.ids, [calls[0].body.context[0].context_id]);
    assert.equal(calls[1].body.type, undefined);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
